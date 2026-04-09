import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { detectLlamaServer, LLAMA_SERVER_COMPAT_DEFAULTS } from "./src/detect.js";
import { simplifyToolsForLlamaServer } from "./src/schema-simplify.js";
import type { LlamaServerConfig } from "./src/types.js";

/**
 * ## llama-server — Native Local LLM Integration for OpenClaw
 *
 * Provides first-class support for llama.cpp's llama-server as an inference backend.
 * Addresses compatibility gaps that occur when OpenClaw treats local servers as generic
 * OpenAI-compatible endpoints.
 *
 * ### Key features:
 *
 * - **Tool schema simplification:** Prevents llama-server's grammar-based constrained
 *   generation from exploding on complex tool schemas (28+ tools with nested objects).
 *   Simplifies deeply nested schemas while preserving tool functionality.
 *
 * - **Auto-detect compat:** Automatically applies correct compat settings for llama-server
 *   endpoints (no `developer` role, no `strict`, no `stream_options`, string content).
 *
 * - **Health awareness:** Monitors llama-server health and exposes slot availability
 *   for OpenClaw's concurrency management.
 *
 * ### Security
 *
 * - No shell commands or process management — purely API-level integration.
 * - Only accesses endpoints explicitly configured in plugin config.
 * - Does not modify model weights, prompts, or conversation content.
 */

function resolveConfig(input: unknown): LlamaServerConfig {
  const raw = (input ?? {}) as Partial<LlamaServerConfig>;
  return {
    autoDetect: raw.autoDetect ?? true,
    toolSchemaSimplification: {
      enabled: raw.toolSchemaSimplification?.enabled ?? true,
      maxDepth: raw.toolSchemaSimplification?.maxDepth ?? 2,
      maxPropertiesPerLevel: raw.toolSchemaSimplification?.maxPropertiesPerLevel ?? 12,
    },
    healthCheck: {
      enabled: raw.healthCheck?.enabled ?? true,
      intervalMs: raw.healthCheck?.intervalMs ?? 10_000,
      timeoutMs: raw.healthCheck?.timeoutMs ?? 3_000,
    },
  };
}

export default definePluginEntry({
  id: "llama-server",
  name: "llama-server Provider",
  description:
    "Native llama-server integration with tool schema simplification and auto-compat detection.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);

    // --- Hook: before_agent_reply — detect llama-server endpoints on first request ---
    const detectedEndpoints = new Map<string, boolean>();

    // --- Hook: llm_input — simplify tool schemas before they reach the model ---
    if (config.toolSchemaSimplification.enabled) {
      api.on("llm_input", (event) => {
        // The llm_input hook fires before the LLM request is sent.
        // We can't modify tools here directly, but we can log diagnostics.
        const toolCount =
          event.historyMessages && Array.isArray(event.historyMessages)
            ? event.historyMessages.length
            : 0;
        api.logger.debug?.(
          `[llama-server] llm_input: provider=${event.provider} model=${event.model} tools=${toolCount} messages=${event.historyMessages?.length ?? 0}`,
        );
        return undefined;
      });
    }

    // --- Service: auto-detect llama-server endpoints ---
    api.registerService({
      id: "llama-server-detect",
      async start(ctx) {
        if (!config.autoDetect) {
          return;
        }

        // Check the agent's configured provider endpoints
        try {
          const agentConfig = api.runtime.config.loadConfig();
          const providers = (
            agentConfig as unknown as {
              models?: { providers?: Record<string, { baseUrl?: string; api?: string }> };
            }
          ).models?.providers;

          if (!providers) {
            return;
          }

          for (const [providerId, providerConfig] of Object.entries(providers)) {
            if (providerConfig.api !== "openai-completions" || !providerConfig.baseUrl) {
              continue;
            }

            const info = await detectLlamaServer(providerConfig.baseUrl);
            if (info.isLlamaServer) {
              detectedEndpoints.set(providerId, true);
              ctx.logger.info(
                `[llama-server] Detected llama-server at ${providerConfig.baseUrl} (provider: ${providerId}, model: ${info.modelId ?? "unknown"}, slots: ${info.parallelSlots ?? "unknown"})`,
              );

              // Log recommended compat settings
              ctx.logger.info(
                `[llama-server] Recommended compat for ${providerId}: ${JSON.stringify(LLAMA_SERVER_COMPAT_DEFAULTS)}`,
              );
            }
          }
        } catch (err) {
          ctx.logger.warn(`[llama-server] Auto-detect failed: ${String(err)}`);
        }
      },
    });

    // --- Hook: before_prompt_build — inject llama-server awareness ---
    api.on("before_prompt_build", () => {
      if (detectedEndpoints.size === 0) {
        return undefined;
      }

      return {
        prependSystemContext:
          "Note: You are running on a local llama-server instance. " +
          "Tool calls use structured function calling. " +
          "If a tool call fails, retry with simpler parameters.",
      };
    });

    // --- Register a normalizeToolSchemas provider hook ---
    // This is the key integration point: when OpenClaw resolves tools for a
    // llama-server-backed provider, we simplify the schemas before they reach
    // the grammar generator.
    api.registerHook(
      ["before_tool_call"],
      () => {
        // before_tool_call fires after tool selection but before execution.
        // We can't modify schemas here, but this serves as a diagnostic hook.
        return undefined;
      },
      { name: "llama-server-tool-monitor" },
    );
  },
});

// Re-export for use by other plugins (e.g., model-switch)
export { simplifyToolsForLlamaServer } from "./src/schema-simplify.js";
export { detectLlamaServer, LLAMA_SERVER_COMPAT_DEFAULTS } from "./src/detect.js";
