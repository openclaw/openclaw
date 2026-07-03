import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";

type ArvenMemoryConfig = {
  baseUrl: string;
  authHeaderEnv?: string;
  recallTool?: string;
  getTool?: string;
  storeTool?: string;
  statusTool?: string;
  timeoutMs?: number;
};

type JsonRpcResponse = {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

const DEFAULT_TIMEOUT_MS = 10000;

function asConfig(value: Record<string, unknown> | undefined): ArvenMemoryConfig {
  const cfg = value ?? {};
  return {
    baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : "",
    authHeaderEnv: typeof cfg.authHeaderEnv === "string" ? cfg.authHeaderEnv.trim() : undefined,
    recallTool: typeof cfg.recallTool === "string" ? cfg.recallTool.trim() : undefined,
    getTool: typeof cfg.getTool === "string" ? cfg.getTool.trim() : undefined,
    storeTool: typeof cfg.storeTool === "string" ? cfg.storeTool.trim() : undefined,
    statusTool: typeof cfg.statusTool === "string" ? cfg.statusTool.trim() : undefined,
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

function resultText(payload: unknown): string {
  if (payload && typeof payload === "object" && "content" in payload) {
    const content = (payload as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? typeof (item as { text?: unknown }).text === "string"
              ? (item as { text: string }).text
              : ""
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) {
        return text;
      }
    }
  }
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload, null, 2);
}

async function callMcpTool(
  cfg: ArvenMemoryConfig,
  toolName: string,
  args: Record<string, unknown>,
) {
  if (!cfg.baseUrl) {
    throw new Error("Arven Memory baseUrl is required.");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (cfg.authHeaderEnv) {
    const auth = process.env[cfg.authHeaderEnv];
    if (auth) {
      headers.authorization = auth;
    }
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: cfg.baseUrl,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `arven-memory-${Date.now()}`,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    },
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(cfg.baseUrl),
    auditContext: "arven-memory.mcp",
  });

  try {
    if (!response.ok) {
      throw new Error(`Arven Memory HTTP ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
      throw new Error(
        payload.error.message ?? `Arven Memory MCP error ${payload.error.code ?? ""}`,
      );
    }
    return payload.result;
  } finally {
    await release();
  }
}

export const arvenMemoryConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    baseUrl: { type: "string" },
    authHeaderEnv: { type: "string" },
    recallTool: { type: "string" },
    getTool: { type: "string" },
    storeTool: { type: "string" },
    statusTool: { type: "string" },
    timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
  },
  required: ["baseUrl"],
} as const;

const recallParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Search query" },
    limit: { type: "number", description: "Maximum result count" },
  },
  required: ["query"],
} as const;

const getParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Memory item id or URI" },
  },
  required: ["id"],
} as const;

const storeParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", description: "Memory text to store" },
    project: { type: "string", description: "Optional project or namespace" },
  },
  required: ["text"],
} as const;

const emptyParameters = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export default definePluginEntry({
  id: "arven-memory",
  name: "Arven Memory",
  description: "Update-stable MCP adapter for Arven Memory",
  kind: "memory" as const,
  configSchema: { jsonSchema: arvenMemoryConfigJsonSchema },
  register(api) {
    const cfg = asConfig(api.pluginConfig);
    const recallTool = cfg.recallTool || "memory_search";
    const getTool = cfg.getTool || "memory_get";
    const storeTool = cfg.storeTool || "memory_store";
    const statusTool = cfg.statusTool || "memory_status";

    api.registerTool(
      {
        name: "arven_memory_recall",
        label: "Arven Memory Recall",
        description: "Search Arven Memory through the configured MCP bridge.",
        parameters: recallParameters,
        async execute(_toolCallId, params) {
          const { query, limit } = params as { query: string; limit?: number };
          const result = await callMcpTool(cfg, recallTool, { query, question: query, limit });
          return {
            content: [{ type: "text" as const, text: resultText(result) }],
            details: result,
          };
        },
      },
      { names: ["arven_memory_recall", "memory_search"] },
    );

    api.registerTool(
      {
        name: "arven_memory_get",
        label: "Arven Memory Get",
        description: "Fetch a specific Arven Memory item through the configured MCP bridge.",
        parameters: getParameters,
        async execute(_toolCallId, params) {
          const { id } = params as { id: string };
          const result = await callMcpTool(cfg, getTool, { id });
          return {
            content: [{ type: "text" as const, text: resultText(result) }],
            details: result,
          };
        },
      },
      { names: ["arven_memory_get", "memory_get"] },
    );

    api.registerTool(
      {
        name: "arven_memory_store",
        label: "Arven Memory Store",
        description: "Store durable memory through the configured Arven MCP bridge.",
        parameters: storeParameters,
        async execute(_toolCallId, params) {
          const { text, project } = params as { text: string; project?: string };
          const result = await callMcpTool(cfg, storeTool, { text, project });
          return {
            content: [{ type: "text" as const, text: resultText(result) }],
            details: result,
          };
        },
      },
      { names: ["arven_memory_store"] },
    );

    api.registerTool(
      {
        name: "arven_memory_status",
        label: "Arven Memory Status",
        description: "Check the configured Arven Memory MCP bridge.",
        parameters: emptyParameters,
        async execute() {
          const result = await callMcpTool(cfg, statusTool, {});
          return {
            content: [{ type: "text" as const, text: resultText(result) }],
            details: result,
          };
        },
      },
      { names: ["arven_memory_status"] },
    );
  },
});
