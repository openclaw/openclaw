// @ts-nocheck

function normalizeTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function wrapContentWithEnvelope(content: string, metadata: { category?: string; tags?: string[]; source?: string }) {
  const lines = ["[OBMETA v1]"];
  if (metadata.category) lines.push(`category: ${metadata.category}`);
  if (metadata.tags && metadata.tags.length > 0) lines.push(`tags: ${metadata.tags.join(", ")}`);
  if (metadata.source) lines.push(`source: ${metadata.source}`);
  lines.push("---");
  lines.push(content);
  return lines.join("\n");
}

function extractTextFromMcpResult(payload: any): string {
  const result = payload?.result;
  if (!result) {
    return JSON.stringify(payload);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlocks = content
    .map((item: any) => {
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean);
  if (textBlocks.length > 0) {
    return textBlocks.join("\n\n");
  }
  return JSON.stringify(result, null, 2);
}

function parseMcpPayload(raw: string): any {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new Error("OpenBrain MCP returned empty payload");
  }

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, "").trim())
    .filter(Boolean)
    .filter((line) => line !== "[DONE]");

  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    const chunk = dataLines[i];
    if (!chunk.startsWith("{")) continue;
    try {
      return JSON.parse(chunk);
    } catch {
      // continue
    }
  }

  throw new Error(`OpenBrain MCP returned non-JSON payload: ${trimmed.slice(0, 400)}`);
}

async function callMcpTool({
  url,
  apiKey,
  headers,
  timeoutMs,
  toolName,
  args,
}: {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(headers || {}),
    };

    if (apiKey && !reqHeaders.Authorization && !reqHeaders.authorization) {
      reqHeaders.Authorization = `Bearer ${apiKey}`;
    }

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`OpenBrain MCP HTTP ${response.status}: ${raw.slice(0, 400)}`);
    }

    let payload: any;
    try {
      payload = parseMcpPayload(raw);
    } catch (e: any) {
      throw new Error(e?.message || `OpenBrain MCP parse failure: ${raw.slice(0, 400)}`);
    }

    if (payload?.error) {
      throw new Error(`OpenBrain MCP tool error: ${JSON.stringify(payload.error)}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

const plugin = {
  id: "openbrain-native",
  name: "OpenBrain Native",
  description: "Direct OpenBrain MCP tools without shell wrappers",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string" },
      apiKey: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      searchToolName: { type: "string", default: "search_thoughts" },
      captureToolName: { type: "string", default: "capture_thought" },
      listToolName: { type: "string", default: "list_thoughts" },
      defaultLimit: { type: "number", default: 8 },
      timeoutMs: { type: "number", default: 25000 },
      envelopeMode: { type: "boolean", default: true },
    },
    required: ["url"],
  },

  register(api: any) {
    const cfg = {
      searchToolName: "search_thoughts",
      captureToolName: "capture_thought",
      listToolName: "list_thoughts",
      defaultLimit: 8,
      timeoutMs: 25000,
      envelopeMode: true,
      ...(api.pluginConfig || {}),
    };

    api.logger.info?.("openbrain-native: registering tools");

    api.registerTool(
      {
        name: "openbrain_search",
        label: "OpenBrain Search",
        description: "Search OpenBrain semantic memory directly via MCP.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results" },
            threshold: { type: "number", description: "Similarity threshold" },
          },
          required: ["query"],
        },
        async execute(_toolCallId: string, params: any) {
          const query = String(params?.query || "").trim();
          if (!query) {
            return { content: [{ type: "text", text: "query is required" }] };
          }

          const args: Record<string, unknown> = {
            query,
            limit: Number.isFinite(params?.limit) ? Number(params.limit) : cfg.defaultLimit,
          };
          if (Number.isFinite(params?.threshold)) {
            args.threshold = Number(params.threshold);
          }

          try {
            const payload = await callMcpTool({
              url: cfg.url,
              apiKey: cfg.apiKey,
              headers: cfg.headers,
              timeoutMs: Number(cfg.timeoutMs),
              toolName: String(cfg.searchToolName),
              args,
            });

            return {
              content: [{ type: "text", text: extractTextFromMcpResult(payload) }],
              details: payload?.result ?? null,
            };
          } catch (err: any) {
            return { content: [{ type: "text", text: `openbrain_search failed: ${err?.message || String(err)}` }] };
          }
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "openbrain_capture",
        label: "OpenBrain Capture",
        description: "Capture a thought into OpenBrain via MCP.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "Thought content to capture" },
            category: { type: "string", description: "Optional category label" },
            tags: {
              anyOf: [
                { type: "string", description: "Comma-separated tags" },
                { type: "array", items: { type: "string" }, description: "Tag array" },
              ],
            },
            source: { type: "string", description: "Optional source label" },
          },
          required: ["content"],
        },
        async execute(_toolCallId: string, params: any) {
          const base = String(params?.content || "").trim();
          if (!base) {
            return { content: [{ type: "text", text: "content is required" }] };
          }

          const category = typeof params?.category === "string" ? params.category.trim() : "";
          const tags = normalizeTags(params?.tags);
          const source = typeof params?.source === "string" ? params.source.trim() : "";

          const finalContent =
            cfg.envelopeMode && (category || tags.length > 0 || source)
              ? wrapContentWithEnvelope(base, { category, tags, source })
              : base;

          try {
            const payload = await callMcpTool({
              url: cfg.url,
              apiKey: cfg.apiKey,
              headers: cfg.headers,
              timeoutMs: Number(cfg.timeoutMs),
              toolName: String(cfg.captureToolName),
              args: { content: finalContent },
            });

            return {
              content: [{ type: "text", text: extractTextFromMcpResult(payload) }],
              details: payload?.result ?? null,
            };
          } catch (err: any) {
            return { content: [{ type: "text", text: `openbrain_capture failed: ${err?.message || String(err)}` }] };
          }
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "openbrain_list_recent",
        label: "OpenBrain List Recent",
        description: "List recent thoughts from OpenBrain.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number" },
            type: { type: "string" },
            topic: { type: "string" },
            person: { type: "string" },
            days: { type: "number" },
          },
        },
        async execute(_toolCallId: string, params: any) {
          const args: Record<string, unknown> = {};
          for (const key of ["limit", "type", "topic", "person", "days"]) {
            if (params && params[key] !== undefined && params[key] !== null && params[key] !== "") {
              args[key] = params[key];
            }
          }
          if (args.limit === undefined) args.limit = cfg.defaultLimit;

          try {
            const payload = await callMcpTool({
              url: cfg.url,
              apiKey: cfg.apiKey,
              headers: cfg.headers,
              timeoutMs: Number(cfg.timeoutMs),
              toolName: String(cfg.listToolName),
              args,
            });

            return {
              content: [{ type: "text", text: extractTextFromMcpResult(payload) }],
              details: payload?.result ?? null,
            };
          } catch (err: any) {
            return { content: [{ type: "text", text: `openbrain_list_recent failed: ${err?.message || String(err)}` }] };
          }
        },
      },
      { optional: true },
    );
  },
};

export default plugin;
