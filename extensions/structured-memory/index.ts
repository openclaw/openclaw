import { definePluginEntry } from "./api.js";
import { configSchema, resolveStructuredMemoryConfig } from "./src/config.js";
import { closeAllDatabases, getOrOpenDatabase, insertRecord } from "./src/db.js";
import { runSessionMaintenance, runFullMaintenanceCycle } from "./src/maintenance.js";
import { analyzeMessage, type PerceptorSignal } from "./src/perceptor.js";
import { createStructuredMemorySupplement } from "./src/supplement.js";
import {
  createMemoryRecordAddTool,
  createMemoryRecordFindTool,
  createMemoryRecordArchiveTool,
} from "./src/tools.js";

interface PendingSignal {
  signal: PerceptorSignal;
  text: string;
}

export default definePluginEntry({
  id: "structured-memory",
  name: "Structured Memory",
  description:
    "Structured typed memory records with importance scoring and Weibull time-based decay.",
  configSchema,
  register(api) {
    const config = resolveStructuredMemoryConfig(api.pluginConfig);
    if (!config.enabled) return;

    api.registerTool(createMemoryRecordAddTool(config, api), {
      name: "memory_record_add",
    });
    api.registerTool(createMemoryRecordFindTool(config), {
      name: "memory_record_find",
    });
    api.registerTool(createMemoryRecordArchiveTool(config), {
      name: "memory_record_archive",
    });

    api.registerMemoryCorpusSupplement(createStructuredMemorySupplement({ config }));

    // ── Perceptor: pending signals per session ──────────────
    const pendingSignals = new Map<string, PendingSignal[]>();

    api.on("message_received", async (event: unknown) => {
      try {
        const msg = event as { content?: string; sessionKey?: string };
        const content = msg.content?.trim();
        if (!content || content.length < 3) return;

        const result = analyzeMessage(content);
        if (!result.signal) return;

        const key = msg.sessionKey ?? "default";
        const signals = pendingSignals.get(key) ?? [];
        signals.push({ signal: result.signal, text: content });
        pendingSignals.set(key, signals);
      } catch {
        // silent: perceptor is best-effort
      }
    });

    api.on("agent_end", async (_event, ctx) => {
      try {
        const agentId = ctx.agentId ?? "main";
        const sessionKey =
          (ctx as { sessionKey?: string }).sessionKey ??
          (ctx as { agentSessionKey?: string }).agentSessionKey;

        // Phase 2: flush high-confidence perceptor signals
        if (sessionKey) {
          const pending = pendingSignals.get(sessionKey);
          if (pending && pending.length > 0) {
            const db = getOrOpenDatabase(agentId);
            for (const { signal, text } of pending) {
              // RFC §5: Perceptor confidence ≥ 0.8 → write directly, skip LLM
              if (signal.confidence >= 0.8) {
                try {
                  insertRecord(db, {
                    type: signal.type,
                    summary: text.slice(0, 100),
                    confidence: signal.confidence,
                    importance: signal.importance,
                    keywords: signal.keywords.join(" "),
                    agent_id: agentId,
                    source_session_id: sessionKey,
                    content: text,
                  });
                } catch {
                  // per-record failure does not block other signals
                }
              }
            }
            pendingSignals.delete(sessionKey);
          }
        }

        await runSessionMaintenance({ agentId, config });
      } catch {
        // silent: maintenance does not affect main flow
      }
    });

    let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
    api.on("gateway_start", async () => {
      const intervalMs = 60 * 60 * 1000;
      maintenanceTimer = setInterval(async () => {
        try {
          await runFullMaintenanceCycle({ config, api });
        } catch {
          // silent
        }
      }, intervalMs);
      if (maintenanceTimer && typeof maintenanceTimer.unref === "function") {
        maintenanceTimer.unref();
      }
    });
    api.on("gateway_stop", () => {
      if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
      }
      closeAllDatabases();
    });
  },
});
