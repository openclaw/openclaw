/**
 * ULS Bridge Plugin — Main Entry Point
 *
 * Registers tools, hooks into prompt build and tool lifecycle,
 * and manages the ULS Hub lifecycle within the Gateway process.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createUlsHub,
  destroyUlsHub,
  getUlsHub,
  formatRetrievedMemory,
  type UlsConfig,
  DEFAULT_ULS_CONFIG,
} from "../../src/uls/index.js";
import {
  createUlsRetrieveTool,
  createUlsWriteTool,
  createUlsSetScopeTool,
  createUlsRedactTool,
  createUlsExplainProvenanceTool,
} from "./tools.js";

const ulsBridgePlugin = {
  id: "uls-bridge",
  name: "ULS Bridge",
  description:
    "Unified Latent Space bridge — cross-agent shared memory with dialectical constraints, projection gating, and prompt injection hardening.",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    const logger = api.logger;

    // -----------------------------------------------------------------------
    // 1. Resolve ULS config from plugin config + defaults
    // -----------------------------------------------------------------------
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const ulsEnabled = pluginCfg.enabled === true;

    if (!ulsEnabled) {
      logger.info("[uls-bridge] ULS is disabled. Set uls-bridge.enabled=true to activate.");
      return;
    }

    const stateDir = (pluginCfg.storagePath as string) || resolveDefaultStoragePath(api);

    const ulsConfig: UlsConfig = {
      ...DEFAULT_ULS_CONFIG,
      enabled: true,
      storagePath: stateDir,
      indexType: (pluginCfg.indexType as "simple" | "faiss") ?? "simple",
      maxInjectionTokens: Number(pluginCfg.maxInjectionTokens ?? 2048),
      allowedScopes:
        (pluginCfg.allowedScopes as Record<string, Array<"self" | "team" | "global">>) ?? {},
      teamGroups: (pluginCfg.teamGroups as Record<string, string[]>) ?? {},
    };

    // -----------------------------------------------------------------------
    // 2. Initialize ULS Hub
    // -----------------------------------------------------------------------
    const hub = createUlsHub(ulsConfig);
    logger.info(`[uls-bridge] ULS Hub initialized. Storage: ${stateDir}`);

    // -----------------------------------------------------------------------
    // 3. Register tools
    // -----------------------------------------------------------------------
    api.registerTool(
      (ctx) => {
        const tools = [
          createUlsRetrieveTool(ctx),
          createUlsWriteTool(ctx),
          createUlsSetScopeTool(ctx),
          createUlsRedactTool(ctx),
          createUlsExplainProvenanceTool(ctx),
        ].filter(Boolean);
        return tools.length > 0 ? tools : null;
      },
      {
        names: [
          "uls_retrieve_context",
          "uls_write_memory",
          "uls_set_scope",
          "uls_redact",
          "uls_explain_provenance",
        ],
      },
    );

    // -----------------------------------------------------------------------
    // 4. Hook: before_prompt_build — inject retrieved shared memory
    // -----------------------------------------------------------------------
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        if (!hub) return;

        const agentId = ctx.agentId ?? "unknown";

        // Derive query from the current prompt (user intent)
        const queryText = event.prompt?.slice(0, 500) ?? "";
        if (!queryText.trim()) return;

        try {
          const result = await hub.retrieve({
            agentId,
            query: queryText,
            scope: "team", // default retrieval scope
            topK: 5,
          });

          if (result.records.length === 0) return;

          const injected = formatRetrievedMemory(result, ulsConfig.maxInjectionTokens);
          if (!injected) return;

          return { prependContext: injected };
        } catch (err) {
          logger.warn(`[uls-bridge] Prompt injection retrieval failed: ${String(err)}`);
        }
      },
      { priority: 50 },
    );

    // -----------------------------------------------------------------------
    // 5. Hook: after_tool_call — store tool experiences as memories
    // -----------------------------------------------------------------------
    api.on(
      "after_tool_call",
      async (event, ctx) => {
        if (!hub) return;

        const agentId = ctx.agentId ?? "unknown";
        const toolName = event.toolName;

        // Skip ULS tools to avoid self-referential loops
        if (toolName.startsWith("uls_")) return;

        try {
          const record = await hub.encode(
            {
              modality: "tool_result",
              toolName,
              params: summarizeParams(event.params),
              result:
                typeof event.result === "string"
                  ? event.result.slice(0, 2048)
                  : JSON.stringify(event.result ?? "").slice(0, 2048),
              error: event.error,
              durationMs: event.durationMs,
              status: event.error ? "error" : "success",
              summary: `Tool '${toolName}' ${event.error ? "failed" : "succeeded"}${event.durationMs ? ` in ${event.durationMs}ms` : ""}`,
              sourceTool: toolName,
              sourceChannel: undefined,
              scope: "self",
            },
            agentId,
          );

          // Default to self scope — agent must explicitly escalate
          record.scope = "self";
          await hub.store(record);
        } catch (err) {
          logger.warn(`[uls-bridge] Failed to store tool result: ${String(err)}`);
        }
      },
      { priority: 10 },
    );

    // -----------------------------------------------------------------------
    // 6. Hook: agent_end — detect contradictions at end of turn
    // -----------------------------------------------------------------------
    api.on(
      "agent_end",
      async (event, ctx) => {
        if (!hub) return;

        const agentId = ctx.agentId ?? "unknown";

        // Simple contradiction detection: look for error patterns
        if (!event.success && event.error) {
          try {
            await hub.contradictionUpdate(
              agentId,
              {
                contradictionType: "tool_failure",
                tensionScore: 0.5,
                parties: [agentId],
                synthesisHint: `Agent failed: ${event.error.slice(0, 200)}`,
              },
              {
                description: `Agent turn failed: ${event.error.slice(0, 500)}`,
                durationMs: event.durationMs,
              },
            );
          } catch {
            // Non-fatal
          }
        }
      },
      { priority: 5 },
    );

    // -----------------------------------------------------------------------
    // 7. Hook: gateway_stop — cleanup
    // -----------------------------------------------------------------------
    api.on(
      "gateway_stop",
      async () => {
        await destroyUlsHub();
        logger.info("[uls-bridge] ULS Hub shut down.");
      },
      { priority: 1 },
    );
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultStoragePath(api: OpenClawPluginApi): string {
  // Default to ~/.openclaw/uls
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return `${home}/.openclaw/uls`;
}

/**
 * Summarize tool params to avoid storing secrets/large payloads.
 */
function summarizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 512) {
      summary[key] = value.slice(0, 512) + "… [truncated]";
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

export default ulsBridgePlugin;
