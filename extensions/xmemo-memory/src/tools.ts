import {
  asToolParamsRecord,
  type AgentToolResult,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { Type } from "typebox";
import { XMemoClient, type XMemoRememberRequest } from "./client.js";
import { resolveXMemoMemoryConfig } from "./config.js";
import { XMemoSearchManager } from "./search-manager.js";

function buildClient(api: OpenClawPluginApi): XMemoClient | null {
  const cfg = resolveXMemoMemoryConfig(api.config);
  if (!cfg.token) {
    return null;
  }
  return new XMemoClient(cfg.baseUrl, cfg.token, cfg.agentId, cfg.agentInstanceId);
}

function buildErrorResult(error: unknown): AgentToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `XMemo memory tool failed: ${message}` }],
    details: { error: message },
  };
}

const optionalPositiveInteger = (description: string) =>
  Type.Optional(Type.Integer({ description, minimum: 1 }));

export function registerXMemoTools(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search XMemo long-term memory by semantic similarity. Use before answering questions about prior decisions, preferences, or project context.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        maxResults: optionalPositiveInteger("Max results (default: 8)"),
      }),
      async execute(_toolCallId, params) {
        const client = buildClient(api);
        if (!client) {
          return {
            content: [{ type: "text", text: "XMemo is not configured. Set XMEMO_KEY to enable memory search." }],
            details: { unavailable: true },
          };
        }

        const cfg = resolveXMemoMemoryConfig(api.config);
        const raw = asToolParamsRecord(params);
        const query = String(raw.query ?? "").trim();
        const maxResults = typeof raw.maxResults === "number" ? raw.maxResults : cfg.recallMaxItems;

        if (!query) {
          return {
            content: [{ type: "text", text: "Query is required for memory_search." }],
            details: { error: "missing query" },
          };
        }

        try {
          const manager = new XMemoSearchManager(client, cfg);
          const results = await manager.search(query, { maxResults });

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant XMemo memories found." }],
              details: { count: 0 },
            };
          }

          const lines = results.map((r, i) => `${i + 1}. [${(r.score * 100).toFixed(0)}%] ${r.snippet}`);
          const text = `Found ${results.length} XMemo memories:\n\n${lines.join("\n")}`;

          return {
            content: [{ type: "text", text }],
            details: { count: results.length, results },
          };
        } catch (error) {
          return buildErrorResult(error);
        }
      },
    },
    { names: ["memory_search"] },
  );

  api.registerTool(
    {
      name: "memory_get",
      label: "Memory Get",
      description:
        "Read a specific XMemo memory by its path. The path is returned by memory_search and encodes the XMemo memory id.",
      parameters: Type.Object({
        path: Type.String({ description: "Memory path (e.g. openclaw/<uuid>)" }),
        from: Type.Optional(Type.Integer({ description: "Start line", minimum: 1 })),
        lines: Type.Optional(Type.Integer({ description: "Line count", minimum: 1 })),
      }),
      async execute(_toolCallId, params) {
        const client = buildClient(api);
        if (!client) {
          return {
            content: [{ type: "text", text: "XMemo is not configured. Set XMEMO_KEY to enable memory get." }],
            details: { unavailable: true },
          };
        }

        const cfg = resolveXMemoMemoryConfig(api.config);
        const raw = asToolParamsRecord(params);
        const relPath = String(raw.path ?? "").trim();
        if (!relPath) {
          return {
            content: [{ type: "text", text: "Path is required for memory_get." }],
            details: { error: "missing path" },
          };
        }

        try {
          const manager = new XMemoSearchManager(client, cfg);
          const result = await manager.readFile({
            relPath,
            from: typeof raw.from === "number" ? raw.from : undefined,
            lines: typeof raw.lines === "number" ? raw.lines : undefined,
          });

          return {
            content: [{ type: "text", text: result.text || "(empty memory)" }],
            details: { path: result.path, from: result.from, lines: result.lines, truncated: result.truncated },
          };
        } catch (error) {
          return buildErrorResult(error);
        }
      },
    },
    { names: ["memory_get"] },
  );

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Store durable information in XMemo. Use for decisions, conventions, preferences, bug fixes, and high-signal project context. Do not store secrets.",
      parameters: Type.Object({
        content: Type.String({ description: "Information to remember" }),
        path: Type.Optional(Type.String({ description: "Optional path/category (defaults to the configured bucket)" })),
        memory_type: Type.Optional(
          Type.String({
            description: "Memory type",
            enum: ["auto", "semantic", "episodic", "procedural", "working", "identity"],
          }),
        ),
        importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)", minimum: 0, maximum: 1 })),
      }),
      async execute(_toolCallId, params) {
        const client = buildClient(api);
        if (!client) {
          return {
            content: [{ type: "text", text: "XMemo is not configured. Set XMEMO_KEY to enable memory store." }],
            details: { unavailable: true },
          };
        }

        const cfg = resolveXMemoMemoryConfig(api.config);
        const raw = asToolParamsRecord(params);
        const content = String(raw.content ?? "").trim();
        if (!content) {
          return {
            content: [{ type: "text", text: "Content is required for memory_store." }],
            details: { error: "missing content" },
          };
        }

        try {
          const response = await client.remember({
            content,
            path: raw.path ? String(raw.path) : cfg.bucket,
            bucket: cfg.bucket,
            scope: cfg.scope ?? null,
            team_id: cfg.teamId ?? null,
            memory_type: (raw.memory_type as XMemoRememberRequest["memory_type"]) ?? "semantic",
            importance: typeof raw.importance === "number" ? raw.importance : 0.7,
            source: "openclaw",
          });

          return {
            content: [{ type: "text", text: `Stored XMemo memory: "${content.slice(0, 80)}..."` }],
            details: { action: "created", id: response.id },
          };
        } catch (error) {
          return buildErrorResult(error);
        }
      },
    },
    { names: ["memory_store"] },
  );

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description:
        "Delete a specific XMemo memory by its path/id. The path is returned by memory_search and encodes the XMemo memory id.",
      parameters: Type.Object({
        path: Type.String({ description: "Memory path (e.g. openclaw/<uuid>)" }),
        mode: Type.Optional(
          Type.String({
            description: "Deletion mode",
            enum: ["soft_delete", "hard_delete", "redact"],
            default: "soft_delete",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const client = buildClient(api);
        if (!client) {
          return {
            content: [{ type: "text", text: "XMemo is not configured. Set XMEMO_KEY to enable memory forget." }],
            details: { unavailable: true },
          };
        }

        const raw = asToolParamsRecord(params);
        const relPath = String(raw.path ?? "").trim();
        if (!relPath) {
          return {
            content: [{ type: "text", text: "Path is required for memory_forget." }],
            details: { error: "missing path" },
          };
        }

        const parts = relPath.split("/");
        const id = parts[parts.length - 1];
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? "")) {
          return {
            content: [{ type: "text", text: `Path does not contain a valid XMemo memory id: ${relPath}` }],
            details: { error: "invalid memory id" },
          };
        }

        try {
          await client.forgetMemory(id!, {
            mode: (raw.mode as "soft_delete" | "hard_delete" | "redact") ?? "soft_delete",
            reason: "deleted via openclaw memory_forget tool",
          });

          return {
            content: [{ type: "text", text: `Forgotten XMemo memory ${id}.` }],
            details: { action: "deleted", id },
          };
        } catch (error) {
          return buildErrorResult(error);
        }
      },
    },
    { names: ["memory_forget"] },
  );
}
