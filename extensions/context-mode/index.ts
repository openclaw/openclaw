/**
 * Context Mode Plugin
 *
 * Proactively compresses large tool outputs before they enter the LLM's
 * context window, using the synchronous `tool_result_persist` hook.
 * Full outputs are indexed in a local FTS5 knowledge base for on-demand
 * retrieval via `context_search` and `context_retrieve` tools.
 *
 * This is complementary to OpenClaw's reactive compaction — it compresses
 * at write time rather than when context is near full.
 */

import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { compressToolResult } from "./src/compressor.js";
import { type KnowledgeBase, openKnowledgeBase } from "./src/knowledge-base.js";
import { DEFAULT_CONFIG, type AgentFilter, type ContextModeConfig } from "./src/types.js";

/** Check whether the plugin should be active for a given agent ID. */
function isAgentEnabled(filter: AgentFilter | undefined, agentId: string | undefined): boolean {
  if (!filter) return true;
  if (filter.include) return agentId != null && filter.include.includes(agentId);
  if (filter.exclude) return agentId == null || !filter.exclude.includes(agentId);
  return true;
}

/**
 * Minimal tool shape for plugin-defined tools. The SDK's `AnyAgentTool` uses
 * generics we can't satisfy from a plain object literal, so we narrow to the
 * fields we actually provide and cast once via `asAgentTool`.
 */
type PluginToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

/** Centralized cast — single place that bridges PluginToolDef → AnyAgentTool. */
function asAgentTool(def: PluginToolDef): AnyAgentTool {
  return def as unknown as AnyAgentTool;
}

type PluginState = {
  kb: KnowledgeBase | null;
  config: ContextModeConfig;
};

/**
 * Resolve the knowledge base directory.
 * Uses the agent directory when available (tool factory context), otherwise
 * falls back to ~/.openclaw/context-mode/<agentId>/.
 */
function resolveKbDir(agentDir?: string, agentId?: string): string | null {
  if (agentDir) {
    return path.join(agentDir, "context-mode");
  }
  // Fallback: store under ~/.openclaw/context-mode/<agentId>/
  const id = agentId ?? "default";
  return path.join(os.homedir(), ".openclaw", "context-mode", id);
}

/** Parse plugin config from the raw pluginConfig object. */
function parseConfig(raw: Record<string, unknown> | undefined): ContextModeConfig {
  if (!raw) {
    return { ...DEFAULT_CONFIG };
  }
  const agents = raw.agents as AgentFilter | undefined;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    threshold:
      typeof raw.threshold === "number" && raw.threshold > 0
        ? raw.threshold
        : DEFAULT_CONFIG.threshold,
    excludeTools: Array.isArray(raw.excludeTools)
      ? raw.excludeTools.filter((t): t is string => typeof t === "string")
      : DEFAULT_CONFIG.excludeTools,
    summaryHeadChars:
      typeof raw.summaryHeadChars === "number" && raw.summaryHeadChars > 0
        ? raw.summaryHeadChars
        : DEFAULT_CONFIG.summaryHeadChars,
    agents:
      agents && typeof agents === "object"
        ? {
            include: Array.isArray(agents.include)
              ? agents.include.filter((s): s is string => typeof s === "string")
              : undefined,
            exclude: Array.isArray(agents.exclude)
              ? agents.exclude.filter((s): s is string => typeof s === "string")
              : undefined,
          }
        : undefined,
  };
}

/**
 * Get or lazily open the knowledge base.
 * Returns null if no suitable directory is available or if node:sqlite fails.
 */
function getOrOpenKb(
  state: PluginState,
  api: OpenClawPluginApi,
  agentDir?: string,
  agentId?: string,
): KnowledgeBase | null {
  if (state.kb) {
    return state.kb;
  }
  const dir = resolveKbDir(agentDir, agentId);
  if (!dir) {
    return null;
  }
  try {
    state.kb = openKnowledgeBase(dir);
    return state.kb;
  } catch (err) {
    api.logger.warn(`[context-mode] Failed to open knowledge base: ${String(err)}`);
    return null;
  }
}

/**
 * Extract text content from a toolResult message.
 * AgentMessage has role="toolResult" with content: Array<{ type: "text", text: string }>.
 */
function extractTextFromToolResult(message: unknown): string | null {
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== "toolResult") {
    return null;
  }
  if (!Array.isArray(msg.content)) {
    return null;
  }
  const texts: string[] = [];
  for (const block of msg.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Replace text content in a toolResult message with compressed summary.
 * Returns a new message object (does not mutate the original).
 */
function replaceTextInToolResult(message: unknown, newText: string): unknown {
  const msg = message as { content?: unknown[] };
  if (!Array.isArray(msg.content)) {
    return message;
  }

  // Replace all text blocks with a single compressed block
  const nonTextBlocks = msg.content.filter(
    (block) =>
      !(block && typeof block === "object" && (block as { type?: string }).type === "text"),
  );

  return {
    ...msg,
    content: [{ type: "text", text: newText }, ...nonTextBlocks],
  };
}

const contextModePlugin = {
  id: "context-mode",
  name: "Context Mode",
  description: "Proactive tool-output compression for extended agent session lifetime",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const state: PluginState = {
      kb: null,
      config: parseConfig(api.pluginConfig),
    };

    if (!state.config.enabled) {
      api.logger.info("[context-mode] Plugin loaded but disabled (set enabled: true to activate)");
      return;
    }

    api.logger.info(
      `[context-mode] Active — threshold: ${state.config.threshold} chars, ` +
        `excludeTools: [${state.config.excludeTools.join(", ")}]`,
    );

    // -- Hook: tool_result_persist (synchronous) --
    // Intercept large tool results before they're written to the session transcript.
    api.on(
      "tool_result_persist",
      (event, ctx) => {
        // Skip agents not in the include/exclude list
        if (!isAgentEnabled(state.config.agents, ctx.agentId)) return;

        const toolName = event.toolName ?? ctx.toolName ?? "unknown";

        // Skip excluded tools, our own tools, and synthetic results
        if (
          state.config.excludeTools.includes(toolName) ||
          toolName === "context_search" ||
          toolName === "context_retrieve" ||
          toolName === "context_list" ||
          event.isSynthetic
        ) {
          return;
        }

        const text = extractTextFromToolResult(event.message);
        if (!text || text.length <= state.config.threshold) {
          return;
        }

        // P1: ensure KB is available before compressing — don't advertise
        // "use context_retrieve" if we can't actually store the full text
        const kb = getOrOpenKb(state, api, undefined, ctx.agentId);
        if (!kb) {
          return;
        }

        const result = compressToolResult(text, toolName, state.config);

        // Defer the SQLite write off the hot path (best-effort persistence)
        queueMicrotask(() => {
          try {
            kb.store({
              refId: result.refId,
              toolName,
              toolCallId: event.toolCallId ?? "unknown",
              originalChars: result.originalChars,
              compressedChars: result.summary.length,
              fullText: text,
              timestamp: Date.now(),
            });
          } catch (err) {
            api.logger.warn(`[context-mode] Failed to store entry: ${String(err)}`);
          }
        });

        api.logger.info(
          `[context-mode] Compressed ${toolName} result: ` +
            `${result.originalChars} → ${result.summary.length} chars ` +
            `(${Math.round((1 - result.summary.length / result.originalChars) * 100)}% reduction)`,
        );

        const modified = replaceTextInToolResult(event.message, result.summary);
        return { message: modified as typeof event.message };
      },
      { priority: 10 },
    );

    // -- Hook: before_prompt_build --
    // Inject guidance so the agent knows about compressed outputs and retrieval tools
    const excludeList =
      state.config.excludeTools.length > 0
        ? `Excluded from compression: ${state.config.excludeTools.join(", ")}.`
        : "";
    api.on("before_prompt_build", (_event, ctx) => {
      if (!isAgentEnabled(state.config.agents, ctx.agentId)) return;
      return {
        prependContext:
          "<context-mode>\n" +
          `Context Mode is active. Tool outputs exceeding ${state.config.threshold} characters ` +
          "are automatically compressed into a summary containing:\n" +
          "- A [Context Mode: compressed from N chars] header\n" +
          "- JSON structure detection (if applicable)\n" +
          "- Head of the original text\n" +
          "- Extracted URLs, errors, counts\n" +
          "- A ref ID for full retrieval\n\n" +
          `${excludeList}\n` +
          "Available tools:\n" +
          "- context_retrieve(ref_id): retrieve the full original text by reference ID\n" +
          "- context_search(query): full-text search across all stored outputs\n" +
          "- context_list(limit?): list recent stored entries with metadata\n" +
          "</context-mode>",
      };
    });

    // -- Tool: context_search --
    // Lets the agent search previously compressed outputs via FTS5
    api.registerTool(
      (ctx) => {
        if (!isAgentEnabled(state.config.agents, ctx.agentId)) return null;
        return asAgentTool({
          name: "context_search",
          label: "Context Search",
          description:
            "Search previously compressed tool outputs by keyword. " +
            "Returns matching entries with reference IDs for full retrieval.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query (keywords or phrases)" }),
            limit: Type.Optional(
              Type.Number({
                description: "Maximum results to return (default: 5)",
                minimum: 1,
                maximum: 20,
              }),
            ),
          }),
          async execute(_id: string, params: Record<string, unknown>) {
            const query = typeof params.query === "string" ? params.query.trim() : "";
            if (!query) {
              return { content: [{ type: "text", text: "Error: query is required" }] };
            }
            const limit = typeof params.limit === "number" ? Math.min(params.limit, 20) : 5;

            const kb = getOrOpenKb(state, api, ctx.agentDir, ctx.agentId);
            if (!kb) {
              return {
                content: [{ type: "text", text: "Context Mode knowledge base is not available." }],
              };
            }

            const entries = kb.search(query, limit);
            if (entries.length === 0) {
              return {
                content: [{ type: "text", text: `No results found for query: "${query}"` }],
              };
            }

            const lines = entries.map((e, i) => {
              const preview = e.fullText.slice(0, 200).replace(/\n/g, " ");
              return (
                `${i + 1}. ref="${e.refId}" tool=${e.toolName} ` +
                `(${e.originalChars.toLocaleString()} chars)\n   ${preview}...`
              );
            });

            const text = `Found ${entries.length} result(s):\n\n${lines.join("\n\n")}\n\nUse context_retrieve with a ref ID to get the full text.`;
            return { content: [{ type: "text", text }] };
          },
        });
      },
      { name: "context_search" },
    );

    // -- Tool: context_retrieve --
    // Retrieve the full original text by reference ID
    api.registerTool(
      (ctx) => {
        if (!isAgentEnabled(state.config.agents, ctx.agentId)) return null;
        return asAgentTool({
          name: "context_retrieve",
          label: "Context Retrieve",
          description:
            "Retrieve the full original text of a previously compressed tool output " +
            "by its reference ID.",
          parameters: Type.Object({
            ref_id: Type.String({ description: "The reference ID from a compressed output" }),
          }),
          async execute(_id: string, params: Record<string, unknown>) {
            const refId = typeof params.ref_id === "string" ? params.ref_id.trim() : "";
            if (!refId) {
              return { content: [{ type: "text", text: "Error: ref_id is required" }] };
            }

            const kb = getOrOpenKb(state, api, ctx.agentDir, ctx.agentId);
            if (!kb) {
              return {
                content: [{ type: "text", text: "Context Mode knowledge base is not available." }],
              };
            }

            const entry = kb.retrieve(refId);
            if (!entry) {
              return {
                content: [{ type: "text", text: `No entry found for ref="${refId}"` }],
              };
            }

            const header =
              `[Retrieved from Context Mode — tool: ${entry.toolName}, ` +
              `original: ${entry.originalChars.toLocaleString()} chars]\n\n`;

            return { content: [{ type: "text", text: header + entry.fullText }] };
          },
        });
      },
      { name: "context_retrieve" },
    );

    // -- Tool: context_list --
    // List recent stored entries with metadata (no full text)
    api.registerTool(
      (ctx) => {
        if (!isAgentEnabled(state.config.agents, ctx.agentId)) return null;
        return asAgentTool({
          name: "context_list",
          label: "Context List",
          description:
            "List recently stored compressed tool outputs with their reference IDs, " +
            "tool names, timestamps, and sizes. Use context_retrieve to get the full text.",
          parameters: Type.Object({
            limit: Type.Optional(
              Type.Number({
                description: "Maximum entries to return (default: 20)",
                minimum: 1,
                maximum: 100,
              }),
            ),
          }),
          async execute(_id: string, params: Record<string, unknown>) {
            const limit = typeof params.limit === "number" ? Math.min(params.limit, 100) : 20;

            const kb = getOrOpenKb(state, api, ctx.agentDir, ctx.agentId);
            if (!kb) {
              return {
                content: [{ type: "text", text: "Context Mode knowledge base is not available." }],
              };
            }

            const entries = kb.listRecent(limit);
            if (entries.length === 0) {
              return {
                content: [{ type: "text", text: "No stored entries yet." }],
              };
            }

            const lines = entries.map((e, i) => {
              const date = new Date(e.timestamp).toISOString();
              return (
                `${i + 1}. ref="${e.refId}" tool=${e.toolName} ` +
                `original=${e.originalChars.toLocaleString()} chars ` +
                `compressed=${e.compressedChars.toLocaleString()} chars ` +
                `at ${date}`
              );
            });

            const text = `${entries.length} stored entry(ies):\n\n${lines.join("\n")}`;
            return { content: [{ type: "text", text }] };
          },
        });
      },
      { name: "context_list" },
    );
  },
};

export default contextModePlugin;
