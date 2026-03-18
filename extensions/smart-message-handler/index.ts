/** Smart Message Handler Plugin — entry point & registration glue. */
import type { PluginApi } from "openclaw/plugin-sdk/core";
import { classifyExecutionIntent, classifyMessage, isIncomplete } from "./src/classifier.ts";
import { getConfig } from "./src/config.ts";
import { calculateDebounceMultiplier, logDebug } from "./src/debounce.ts";
import {
  loadEmbeddingCache,
  isEmbeddingCacheLoaded,
  findBestTextMatch,
  clearEmbeddingCache,
  getEmbeddingCacheStats,
} from "./src/embedding-cache.ts";
import {
  setLastPrediction,
  recordToolUsage,
  formatFeedbackReport,
  resetFeedback,
} from "./src/feedback.ts";
import {
  recordClassification,
  recordSkippedSession,
  getMetrics,
  resetMetrics,
  formatMetricsReport,
  enablePersistence,
  flushMetrics,
  loadPersistedMetrics,
  aggregatePersistedMetrics,
} from "./src/metrics.ts";
import {
  createSessionStore,
  recordMessage,
  getSession,
  clearSessions,
} from "./src/session-state.ts";
import {
  classifyBaseline,
  recordDivergence,
  formatDivergenceReport,
  resetDivergenceLog,
} from "./src/shadow.ts";
import { buildDynamicExecutionSignal } from "./src/signal-builder.ts";
import type { ExecutionKind, MessageClassification } from "./src/types.ts";

// Runtime-only custom phrases added via /smartadd (non-persistent)
let runtimePhrases: { phrase: string; kind: ExecutionKind }[] = [];

// Last classification result for cross-hook access (before_model_resolve)
let lastClassification: MessageClassification | null = null;

export default function register(api: PluginApi) {
  const config = getConfig(api);
  if (!config.enabled) {
    api.logger.info("Smart message handler plugin is disabled");
    return;
  }

  api.logger.info("Smart message handler plugin loaded");
  enablePersistence();
  if (config.embeddingCacheEnabled && config.embeddingCachePath) {
    const loaded = loadEmbeddingCache(config.embeddingCachePath);
    api.logger.info(
      `Embedding cache ${loaded ? "loaded" : "failed to load"} from ${config.embeddingCachePath}`,
    );
  }
  let sessionStore = createSessionStore(100);

  api.on(
    "before_prompt_build",
    (event, ctx) => {
      // 1. getConfig
      const currentConfig = getConfig(api);

      // 2. session check
      const sessionKey = ctx.sessionKey || "default";
      if (currentConfig.disableForLocalMainSession && sessionKey === "agent:main:main") {
        logDebug(
          currentConfig,
          `Skipping smart handling for local main session: ${sessionKey}`,
          undefined,
          api.logger,
        );
        recordSkippedSession();
        return {};
      }

      // 3. recordMessage
      const messages = event.messages || [];
      const raw = messages.length > 0 ? messages[messages.length - 1] : undefined;
      const lastMessage = typeof raw === "string" ? raw : "";
      sessionStore = recordMessage(sessionStore, sessionKey);
      const sessionState = getSession(sessionStore, sessionKey);

      // 4. debounce calculation
      const multiplier = calculateDebounceMultiplier(lastMessage, sessionState, currentConfig);
      logDebug(
        currentConfig,
        `Session: ${sessionKey}, Multiplier: ${multiplier}`,
        undefined,
        api.logger,
      );
      if (multiplier > 1.5 && isIncomplete(lastMessage, currentConfig)) {
        logDebug(
          currentConfig,
          `Detected potentially incomplete input, suggesting extended wait`,
          undefined,
          api.logger,
        );
      }

      if (!currentConfig.executionSignalEnabled) {
        return {};
      }

      // 5. classifyMessage (custom phrases + embedding + keyword scoring)
      const effectiveConfig =
        runtimePhrases.length > 0
          ? { ...currentConfig, customPhrases: [...currentConfig.customPhrases, ...runtimePhrases] }
          : currentConfig;
      let classification = classifyMessage(lastMessage, effectiveConfig);

      // Embedding cache override
      if (currentConfig.embeddingCacheEnabled && isEmbeddingCacheLoaded()) {
        const textMatch = findBestTextMatch(lastMessage, 0.6);
        if (textMatch) {
          logDebug(
            currentConfig,
            `Embedding text match: "${textMatch.matchedText}" (sim=${textMatch.similarity.toFixed(3)}, kind=${textMatch.kind})`,
            undefined,
            api.logger,
          );
          if (classification.kind === "unknown" || textMatch.similarity >= 0.7) {
            classification = { ...classification, kind: textMatch.kind };
          }
        }
      }

      // 6. buildDynamicExecutionSignal (classification XML)
      lastClassification = classification;
      setLastPrediction(classification.kind);
      logDebug(currentConfig, `Classification:`, classification, api.logger);

      const signal = buildDynamicExecutionSignal(classification, currentConfig.locale);
      const result: Record<string, string> = {};
      if (signal !== null) {
        result.prependContext = signal;
        logDebug(
          currentConfig,
          `Injected execution signal for kind: ${classification.kind}`,
          undefined,
          api.logger,
        );
      }

      // 7. recordClassification + shadow + feedback
      recordClassification(classification.kind, signal !== null, sessionKey);

      if (currentConfig.shadowModeEnabled) {
        const baselineIntent = classifyBaseline(lastMessage, currentConfig);
        const previewLength = currentConfig.debug ? 100 : 50;
        const preview = lastMessage.slice(0, previewLength);
        recordDivergence({
          timestamp: Date.now(),
          messagePreview: preview,
          currentResult: classification.kind,
          baselineResult: baselineIntent.execution_kind,
          currentScore: classification.score,
          agreed: classification.kind === baselineIntent.execution_kind,
        });
      }

      // 8. return { prependContext }
      return result;
    },
    { priority: 10 },
  );

  // Model routing hook: suggest model override based on classification tier
  api.on("before_model_resolve", (_event, _ctx) => {
    const currentConfig = getConfig(api);
    if (!currentConfig.modelRoutingEnabled || !lastClassification) {
      return {};
    }

    const tier = lastClassification.suggested_tier;
    if (tier === "premium" && currentConfig.premiumModel) {
      return { modelOverride: currentConfig.premiumModel };
    }
    if (tier === "fast" && currentConfig.fastModel) {
      return { modelOverride: currentConfig.fastModel };
    }
    return {};
  });

  api.on("after_tool_call", (event) => {
    recordToolUsage(event.toolName);
  });

  api.registerCommand({
    name: "smartstatus",
    description: "Show smart message handler status",
    handler: () => {
      const currentConfig = getConfig(api);
      const sessionCount = sessionStore.size;
      const cacheStats = getEmbeddingCacheStats();
      const cacheInfo = cacheStats.loaded
        ? `loaded (${cacheStats.entryCount} entries, dim=${cacheStats.dimension})`
        : "not loaded";
      return {
        text: `Smart Message Handler Status:\n- Active sessions: ${sessionCount}\n- Embedding cache: ${cacheInfo}\n- Config: ${JSON.stringify(currentConfig, null, 2)}`,
      };
    },
  });

  api.registerCommand({
    name: "smartreset",
    description: "Reset smart message handler session data",
    handler: () => {
      sessionStore = clearSessions(sessionStore);
      return { text: "Smart message handler session data cleared." };
    },
  });

  api.registerCommand({
    name: "smartmetrics",
    description: "Show classification metrics (add 'weekly' for last 7 days from persisted log)",
    handler: (ctx) => {
      const args = ctx.args?.trim();
      if (args === "weekly") {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const entries = loadPersistedMetrics(sevenDaysAgo);
        const aggregated = aggregatePersistedMetrics(entries);
        return {
          text: `Weekly Report (${entries.length} entries)\n${formatMetricsReport(aggregated)}`,
        };
      }
      return { text: formatMetricsReport(getMetrics()) };
    },
  });

  api.registerCommand({
    name: "smartadd",
    description: "Add a custom intent phrase. Usage: /smartadd <kind> <phrase>",
    handler: (ctx) => {
      const args = ctx.args?.trim() || "";
      const spaceIdx = args.indexOf(" ");
      if (spaceIdx === -1) {
        return {
          text: "Usage: /smartadd <kind> <phrase>\nExample: /smartadd debug \u8FD9\u4E2A\u5730\u65B9\u53C8\u6302\u4E86",
        };
      }
      const kind = args.slice(0, spaceIdx) as ExecutionKind;
      const phrase = args.slice(spaceIdx + 1).trim();
      const validKinds = ["search", "install", "read", "run", "write", "debug", "analyze", "chat"];
      if (!validKinds.includes(kind)) {
        return { text: `Invalid kind "${kind}". Valid: ${validKinds.join(", ")}` };
      }
      if (!phrase) {
        return { text: "Phrase cannot be empty." };
      }
      runtimePhrases.push({ phrase, kind });
      return {
        text: `Added: "${phrase}" \u2192 ${kind}\nNote: This is a runtime addition. Add to openclaw.json config for persistence.`,
      };
    },
  });

  api.registerCommand({
    name: "smartfeedback",
    description: "Show prediction vs actual tool usage feedback",
    handler: () => ({ text: formatFeedbackReport() }),
  });

  api.registerCommand({
    name: "smartshadow",
    description: "Show shadow mode divergence report",
    handler: () => {
      const currentConfig = getConfig(api);
      if (!currentConfig.shadowModeEnabled) {
        return { text: "Shadow mode is disabled. Set shadowModeEnabled: true in config." };
      }
      return { text: formatDivergenceReport() };
    },
  });

  api.registerService({
    id: "smart-message-handler-cleanup",
    start: () => {
      api.logger.info("Smart message handler service started");
    },
    stop: async () => {
      await flushMetrics();
      sessionStore = clearSessions(sessionStore);
      resetMetrics();
      resetDivergenceLog();
      resetFeedback();
      clearEmbeddingCache();
      runtimePhrases = [];
      api.logger.info("Smart message handler service stopped, sessions cleared");
    },
  });
}

// Re-export for external use and smoke-test compatibility
export {
  classifyExecutionIntent,
  classifyMessage,
  toMessageClassification,
} from "./src/classifier.ts";
export { buildExecutionSignal, buildPreComputedVerdict } from "./src/signal-builder.ts";
export type {
  SmartHandlerConfig,
  SessionState,
  ExecutionIntent,
  ExecutionKind,
  PreComputedVerdict,
  MessageClassification,
  ConfidenceLevel,
  ModelTier,
} from "./src/types.ts";
