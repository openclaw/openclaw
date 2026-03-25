import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { getAgentCoreConfig, AgentCoreMemoryManager } from "../agentcore/src/index.js";
import { extractTenantId, extractAgentId } from "../hyperion/src/lib/index.js";

// Cache managers by namespace to avoid creating a new client per tool call.
const managerCache = new Map<string, AgentCoreMemoryManager>();

function getOrCreateManager(namespace: string): AgentCoreMemoryManager | null {
  const config = getAgentCoreConfig();
  if (!config?.memoryId) {
    return null;
  }

  const cached = managerCache.get(namespace);
  if (cached) {
    return cached;
  }

  const manager = new AgentCoreMemoryManager({ config, namespace });
  managerCache.set(namespace, manager);
  return manager;
}

function resolveNamespace(sessionKey?: string): string | null {
  if (!sessionKey) return null;
  const config = getAgentCoreConfig();
  if (!config) return null;
  const tenantId = extractTenantId(sessionKey);
  if (!tenantId) return null;
  const agentId = extractAgentId(sessionKey);
  return `${config.memoryNamespacePrefix}${tenantId}:${agentId}`;
}

export default definePluginEntry({
  id: "memory-agentcore",
  name: "Memory (AgentCore)",
  description:
    "Memory search backed by AWS Bedrock AgentCore — no local embedding provider needed.",
  kind: "memory",
  register(api) {
    const memorySearchTool = api.runtime.tools.createMemorySearchTool;
    const memoryGetTool = api.runtime.tools.createMemoryGetTool;

    // Override the memory search tool factory: the tool creation uses OC's
    // built-in createMemorySearchTool for the tool shape, but we replace
    // the underlying MemorySearchManager with our AgentCore adapter.
    //
    // However, OC's createMemorySearchTool internally calls getMemorySearchManager()
    // which routes through the backend-config resolution. To fully bypass that,
    // we register custom tools that call AgentCoreMemoryManager directly.
    api.registerTool(
      (ctx) => {
        const namespace = resolveNamespace(ctx.sessionKey);
        if (!namespace) {
          // Fall back to OC's built-in tools if we can't resolve namespace
          const search = memorySearchTool({ config: ctx.config, agentSessionKey: ctx.sessionKey });
          const get = memoryGetTool({ config: ctx.config, agentSessionKey: ctx.sessionKey });
          if (!search || !get) return null;
          return [search, get];
        }

        const manager = getOrCreateManager(namespace);
        if (!manager) {
          // No memoryId configured — fall back to built-in
          const search = memorySearchTool({ config: ctx.config, agentSessionKey: ctx.sessionKey });
          const get = memoryGetTool({ config: ctx.config, agentSessionKey: ctx.sessionKey });
          if (!search || !get) return null;
          return [search, get];
        }

        const searchTool = {
          label: "Memory Search",
          name: "memory_search",
          description:
            "Mandatory recall step: semantically search agent memory before answering questions about prior work, decisions, dates, people, preferences, or todos. Powered by AgentCore Memory (server-side embeddings).",
          parameters: {
            type: "object" as const,
            properties: {
              query: { type: "string" as const },
              maxResults: { type: "number" as const },
              minScore: { type: "number" as const },
            },
            required: ["query"] as const,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const query =
              typeof params.query === "string" ? params.query : String(params.query ?? "");
            const maxResults =
              typeof params.maxResults === "number" ? params.maxResults : undefined;
            const minScore = typeof params.minScore === "number" ? params.minScore : undefined;
            try {
              const results = await manager.search(query, {
                maxResults,
                minScore,
                sessionKey: ctx.sessionKey,
              });
              const status = manager.status();
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      results,
                      provider: status.provider,
                      model: status.model,
                    }),
                  },
                ],
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      results: [],
                      disabled: true,
                      unavailable: true,
                      error: message,
                      warning: "Memory search is unavailable due to an AgentCore error.",
                      action: "Check AgentCore Memory configuration and retry memory_search.",
                    }),
                  },
                ],
              };
            }
          },
        };

        const getTool = {
          label: "Memory Get",
          name: "memory_get",
          description:
            "Read a specific memory record by path. Use after memory_search to retrieve full content.",
          parameters: {
            type: "object" as const,
            properties: {
              path: { type: "string" as const },
              from: { type: "number" as const },
              lines: { type: "number" as const },
            },
            required: ["path"] as const,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const relPath =
              typeof params.path === "string" ? params.path : String(params.path ?? "");
            try {
              const result = await manager.readFile({ relPath });
              return {
                content: [{ type: "text" as const, text: JSON.stringify(result) }],
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      path: relPath,
                      text: "",
                      disabled: true,
                      error: message,
                    }),
                  },
                ],
              };
            }
          },
        };

        return [searchTool, getTool] as any;
      },
      { names: ["memory_search", "memory_get"] },
    );
  },
});
