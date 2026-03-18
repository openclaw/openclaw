/**
 * OpenClaw Morph Plugin
 *
 * Provides Morph-powered fast compaction (25k+ tok/s, sub-300ms) and
 * AI-powered codebase search via WarpGrep SDK.
 */

import { Type } from "@sinclair/typebox";
import { createCodebaseSearchTool } from "./src/codebase-search/tool.js";
import { summarizeWithMorph } from "./src/compaction/client.js";
import {
  MORPH_DEFAULT_API_URL,
  MORPH_DEFAULT_COMPRESSION_RATIO,
  MORPH_DEFAULT_MODEL,
  MORPH_DEFAULT_TIMEOUT_MS,
} from "./src/compaction/defaults.js";
import type { MorphPluginConfig } from "./src/types.js";

// ============================================================================
// Plugin API type — uses the same shape as OpenClawPluginApi from core.
// The registerCompactionProvider method is being added by another agent.
// We type-cast as needed so the plugin compiles standalone.
// ============================================================================

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  runtime: { workspaceDir?: string };
  registerTool: (
    tool: {
      name: string;
      label?: string;
      description: string;
      parameters: unknown;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    },
    opts?: { name?: string },
  ) => void;
  registerCli: (
    registrar: (ctx: { program: import("commander").Command }) => void | Promise<void>,
    opts?: { commands?: string[] },
  ) => void;
  registerCompactionProvider?: (provider: {
    id: string;
    label: string;
    summarize: (params: {
      messages: unknown[];
      signal?: AbortSignal;
      compressionRatio?: number;
      previousSummary?: string;
    }) => Promise<string>;
  }) => void;
};

// ============================================================================
// Config resolution
// ============================================================================

// Config is validated by core against openclaw.plugin.json schema before
// reaching the plugin, so a simple cast is safe here.
function resolveConfig(rawConfig?: Record<string, unknown>): MorphPluginConfig {
  return (rawConfig ?? {}) as MorphPluginConfig;
}

function resolveApiKey(config: MorphPluginConfig): string | undefined {
  if (config.apiKey?.trim()) {
    return config.apiKey.trim();
  }
  const envKey = process.env.MORPH_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }
  return undefined;
}

// ============================================================================
// Plugin Definition
// ============================================================================

const morphPlugin = {
  id: "morph",
  name: "Morph",
  description: "Morph-powered compaction and codebase search",

  register(api: PluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const apiKey = resolveApiKey(config);

    // 1. Register compaction provider (if API key available and method exists)
    if (apiKey && api.registerCompactionProvider) {
      const apiUrl = config.apiUrl?.trim() || MORPH_DEFAULT_API_URL;
      const compressionRatio = config.compressionRatio ?? MORPH_DEFAULT_COMPRESSION_RATIO;

      api.registerCompactionProvider({
        id: "morph",
        label: "Morph Compaction",
        async summarize(params) {
          return summarizeWithMorph({
            messages: params.messages,
            config: {
              apiUrl,
              apiKey,
              model: MORPH_DEFAULT_MODEL,
              compressionRatio: params.compressionRatio ?? compressionRatio,
              timeout: MORPH_DEFAULT_TIMEOUT_MS,
            },
            signal: params.signal,
          });
        },
      });
      api.logger.info("morph: compaction provider registered");
    }

    // 2. Register codebase search tool (if enabled and API key available)
    if (config.codebaseSearch?.enabled !== false && apiKey) {
      const workspaceDir = api.runtime?.workspaceDir;
      const tool = createCodebaseSearchTool(apiKey, config, workspaceDir);
      api.registerTool(tool, { name: "codebase_search" });
      api.logger.info("morph: codebase search tool registered");
    }

    // 3. Register CLI setup command
    api.registerCli(
      ({ program }) => {
        const morph = program.command("morph").description("Morph integration management");

        morph
          .command("status")
          .description("Show Morph integration status")
          .action(() => {
            const key = resolveApiKey(config);
            if (key) {
              console.log("Morph API key: configured");
              console.log(`API URL: ${config.apiUrl?.trim() || MORPH_DEFAULT_API_URL}`);
              console.log(
                `Compression ratio: ${config.compressionRatio ?? MORPH_DEFAULT_COMPRESSION_RATIO}`,
              );
              console.log(
                `Codebase search: ${config.codebaseSearch?.enabled !== false ? "enabled" : "disabled"}`,
              );
            } else {
              console.log("Morph API key: not configured");
              console.log("Set via plugin config (apiKey) or MORPH_API_KEY environment variable.");
              console.log("Get your key at: https://www.morphllm.com/dashboard/api-keys");
            }
          });
      },
      { commands: ["morph"] },
    );
  },
};

export default morphPlugin;
