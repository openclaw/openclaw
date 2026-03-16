import type Database from "better-sqlite3";
import type {
  ContextEngine,
  AfterTurnParams,
  AgentMessage,
  PluginInsightsConfig,
  InsightsReport,
  PluginReport,
  PluginVerdict,
  VerdictLevel,
  PluginInstallRow,
  IngestResult,
  AssembleResult,
  CompactResult,
  BootstrapResult,
} from "./types.js";
import { TurnCollector } from "./collector/turn-collector.js";
import { ToolDetector } from "./collector/tool-detector.js";
import { ContextDetector } from "./collector/context-detector.js";
import { PluginReporter } from "./collector/plugin-reporter.js";
import { TriggerFrequencyMetric } from "./metrics/trigger-frequency.js";
import { TokenDeltaMetric } from "./metrics/token-delta.js";
import { ConversationTurnsMetric } from "./metrics/conversation-turns.js";
import { ImplicitSatisfactionMetric } from "./metrics/implicit-satisfaction.js";
import { LLMJudgeMetric } from "./metrics/llm-judge.js";

export interface ToolPluginMapping {
  toolName: string;
  pluginId: string;
  pluginName?: string;
}

export function createInsightsEngine(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolPluginMappings?: ToolPluginMapping[]
): { engine: ContextEngine; reporter: PluginReporter; toolDetector: ToolDetector } {
  const toolDetector = new ToolDetector(db);
  const contextDetector = new ContextDetector();
  const pluginReporter = new PluginReporter(db);
  const turnCollector = new TurnCollector(
    db,
    toolDetector,
    contextDetector,
    pluginReporter
  );

  // Build tool→plugin mapping if provided
  if (toolPluginMappings && toolPluginMappings.length > 0) {
    toolDetector.refreshMappingFromEntries(toolPluginMappings);
  }

  // Track known plugins from mapping
  if (toolPluginMappings) {
    const pluginIds = new Set(toolPluginMappings.map((m) => m.pluginId));
    updatePluginInstalls(db, [...pluginIds]);
  }

  // Per-session turn counters — ensures turn_index is session-scoped
  const sessionTurnCounters = new Map<string, number>();
  // Track how many messages we've already processed per session,
  // so afterTurn only ingests newly added messages (not the full transcript).
  const sessionMessageCounts = new Map<string, number>();

  // Create LLM judge once (not per-turn) to avoid race conditions
  // where concurrent evaluations both read budget as unfull.
  const judge =
    config.llmJudge.enabled && config.llmJudge.apiKey
      ? new LLMJudgeMetric(db, config.llmJudge)
      : null;

  const engine: ContextEngine = {
    info: {
      id: "plugin-insights",
      name: "Plugin Insights",
      ownsCompaction: false,
    },

    // Required: ingest each message (we just pass through)
    async ingest(_params: {
      sessionId: string;
      message: AgentMessage;
    }): Promise<IngestResult> {
      return { ingested: true };
    },

    // Required: assemble messages for context (pass through unchanged)
    async assemble(params: {
      sessionId: string;
      messages: AgentMessage[];
    }): Promise<AssembleResult> {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    },

    // Required: compact (we don't own compaction)
    async compact(_params: {
      sessionId: string;
      sessionFile: string;
    }): Promise<CompactResult> {
      return {
        ok: true,
        compacted: false,
        reason: "plugin-insights does not manage compaction",
      };
    },

    // Optional: bootstrap
    async bootstrap(_params: {
      sessionId: string;
      sessionFile: string;
    }): Promise<BootstrapResult> {
      return { bootstrapped: true };
    },

    // Optional: afterTurn — our main data collection point
    async afterTurn(params: AfterTurnParams): Promise<void> {
      if (!config.enabled) return;

      const sid = params.sessionId;
      const idx = sessionTurnCounters.get(sid) ?? 0;
      sessionTurnCounters.set(sid, idx + 1);

      // Only process newly added messages since last afterTurn call.
      // The SDK passes the full transcript each time; re-processing
      // old messages would inflate plugin events and metrics.
      const prevCount = sessionMessageCounts.get(sid) ?? 0;
      const newMessages = params.messages.slice(prevCount);
      sessionMessageCounts.set(sid, params.messages.length);

      if (newMessages.length > 0) {
        turnCollector.collect(sid, idx, newMessages);
      }

      // Async LLM judge evaluation (fire-and-forget, single instance)
      if (judge) {
        judge.evaluate().catch(() => {
          // Silently ignore judge errors
        });
      }
    },
  };

  return { engine, reporter: pluginReporter, toolDetector };
}

/** Build a complete insights report for all active plugins */
export function buildReport(
  db: Database.Database,
  config: PluginInsightsConfig,
  days: number = 30
): InsightsReport {
  const triggerMetric = new TriggerFrequencyMetric(db);
  const tokenMetric = new TokenDeltaMetric(db);
  const turnsMetric = new ConversationTurnsMetric(db);
  const satisfactionMetric = new ImplicitSatisfactionMetric(db);
  const judgeMetric = config.llmJudge.enabled
    ? new LLMJudgeMetric(db, config.llmJudge)
    : null;

  const activePlugins = triggerMetric.getActivePlugins(days);

  const plugins: PluginReport[] = activePlugins.map((pluginId) => {
    const triggerFrequency = triggerMetric.compute(pluginId, days);
    const tokenDelta = tokenMetric.compute(pluginId, days);
    const conversationTurns = turnsMetric.compute(pluginId, days);
    const implicitSatisfaction = satisfactionMetric.compute(pluginId, days);
    const llmJudge = judgeMetric
      ? judgeMetric.computeResult(pluginId, days)
      : undefined;

    const installedDays = getInstalledDays(db, pluginId);
    const pluginName = getPluginName(db, pluginId);

    const verdict = computeVerdict(
      triggerFrequency.totalTriggers,
      triggerFrequency.triggersPerDay,
      tokenDelta.deltaPercent,
      implicitSatisfaction.acceptanceRate,
      implicitSatisfaction.retryRate,
      implicitSatisfaction.totalSignals
    );

    return {
      pluginId,
      pluginName,
      installedDays,
      triggerFrequency,
      tokenDelta,
      conversationTurns,
      implicitSatisfaction,
      llmJudge,
      verdict,
    };
  });

  // Sort: keep > low_usage > expensive/low_satisfaction > remove
  const order: Record<VerdictLevel, number> = {
    keep: 0,
    low_usage: 1,
    expensive: 2,
    low_satisfaction: 3,
    remove: 4,
  };
  plugins.sort((a, b) => order[a.verdict.level] - order[b.verdict.level]);

  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - days);

  return {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: now.toISOString().slice(0, 10),
    plugins,
    generatedAt: now.toISOString(),
  };
}

function computeVerdict(
  totalTriggers: number,
  _triggersPerDay: number,
  tokenDeltaPercent: number,
  acceptanceRate: number,
  _retryRate: number,
  totalSignals: number
): PluginVerdict {
  // Low usage: only check absolute trigger count.
  // triggersPerDay is now window-scoped so the threshold would depend
  // on how many days the user asks for; total triggers is more stable.
  if (totalTriggers < 5) {
    return {
      level: "low_usage",
      label: "LOW USAGE — consider removing",
      reason: "Plugin is rarely triggered",
    };
  }

  if (tokenDeltaPercent > 30 && totalSignals > 5 && acceptanceRate < 50) {
    return {
      level: "remove",
      label: "EXPENSIVE & LOW SATISFACTION — recommend removing",
      reason: "High token overhead with low user acceptance",
    };
  }

  if (tokenDeltaPercent > 40) {
    return {
      level: "expensive",
      label: "EXPENSIVE — high token overhead",
      reason: `${tokenDeltaPercent}% extra tokens per trigger`,
    };
  }

  if (totalSignals > 5 && acceptanceRate < 50) {
    return {
      level: "low_satisfaction",
      label: "LOW SATISFACTION — users often retry",
      reason: `Only ${acceptanceRate}% acceptance rate`,
    };
  }

  return {
    level: "keep",
    label: "KEEP — strong positive impact",
    reason: "Good trigger frequency with acceptable overhead",
  };
}

function updatePluginInstalls(
  db: Database.Database,
  pluginIds: string[]
): void {
  const upsert = db.prepare(`
    INSERT INTO plugin_installs (plugin_id, first_seen_at, last_seen_at)
    VALUES (?, datetime('now'), datetime('now'))
    ON CONFLICT(plugin_id) DO UPDATE SET last_seen_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    for (const id of pluginIds) {
      upsert.run(id);
    }
  });
  tx();
}

function getInstalledDays(db: Database.Database, pluginId: string): number {
  const row = db
    .prepare("SELECT first_seen_at FROM plugin_installs WHERE plugin_id = ?")
    .get(pluginId) as PluginInstallRow | undefined;

  if (!row) return 0;

  const firstSeen = new Date(row.first_seen_at);
  const now = new Date();
  return Math.floor(
    (now.getTime() - firstSeen.getTime()) / (1000 * 60 * 60 * 24)
  );
}

function getPluginName(
  db: Database.Database,
  pluginId: string
): string | undefined {
  const row = db
    .prepare(
      "SELECT DISTINCT plugin_name FROM tool_plugin_mapping WHERE plugin_id = ? AND plugin_name IS NOT NULL LIMIT 1"
    )
    .get(pluginId) as { plugin_name: string } | undefined;

  return row?.plugin_name;
}

/** Clean up data older than retention period */
export function cleanupOldData(
  db: Database.Database,
  retentionDays: number
): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ");

  // Use subqueries instead of spreading turn IDs as bind parameters.
  // This avoids hitting SQLite's SQLITE_MAX_VARIABLE_NUMBER limit
  // when many expired turns exist.
  db.transaction(() => {
    db.prepare(
      `DELETE FROM satisfaction_signals WHERE turn_id IN (SELECT id FROM turns WHERE timestamp < ?)`
    ).run(cutoffStr);
    db.prepare(
      `DELETE FROM llm_scores WHERE turn_id IN (SELECT id FROM turns WHERE timestamp < ?)`
    ).run(cutoffStr);
    db.prepare(
      `DELETE FROM plugin_events WHERE turn_id IN (SELECT id FROM turns WHERE timestamp < ?)`
    ).run(cutoffStr);
    db.prepare(
      `DELETE FROM turns WHERE timestamp < ?`
    ).run(cutoffStr);
  })();
}
