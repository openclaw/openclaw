import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { memoryOpenVikingConfigSchema } from "./config.js";

type FindResultItem = {
  uri: string;
  is_leaf?: boolean;
  abstract?: string;
  overview?: string;
  category?: string;
  score?: number;
  match_reason?: string;
};

type FindResult = {
  memories?: FindResultItem[];
  resources?: FindResultItem[];
  skills?: FindResultItem[];
  total?: number;
};

const MEMORY_URI_PREFIXES = ["viking://user/memories", "viking://agent/memories"];

const MEMORY_TRIGGERS = [
  /remember|preference|prefer|important|decision|decided|always|never/i,
  /记住|偏好|喜欢|重要|决定|总是|永远|优先/i,
  /[\w.-]+@[\w.-]+\.\w+/,
  /\+\d{10,}/,
];

function getCaptureDecision(text: string): { shouldCapture: boolean; reason: string } {
  if (text.length < 10 || text.length > 1000) {
    return { shouldCapture: false, reason: "length_out_of_range" };
  }
  if (text.includes("<relevant-memories>")) {
    return { shouldCapture: false, reason: "injected_memory_context" };
  }
  for (const trigger of MEMORY_TRIGGERS) {
    if (trigger.test(text)) {
      return { shouldCapture: true, reason: `matched_trigger:${trigger.toString()}` };
    }
  }
  return { shouldCapture: false, reason: "no_trigger_matched" };
}

function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function isMemoryUri(uri: string): boolean {
  return MEMORY_URI_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

function normalizeDedupeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isEventOrCaseMemory(item: FindResultItem): boolean {
  const category = (item.category ?? "").toLowerCase();
  const uri = item.uri.toLowerCase();
  return (
    category === "events" ||
    category === "cases" ||
    uri.includes("/events/") ||
    uri.includes("/cases/")
  );
}

function getMemoryDedupeKey(item: FindResultItem): string {
  const abstract = normalizeDedupeText(item.abstract ?? item.overview ?? "");
  const category = (item.category ?? "").toLowerCase() || "unknown";
  if (abstract && !isEventOrCaseMemory(item)) {
    return `abstract:${category}:${abstract}`;
  }
  return `uri:${item.uri}`;
}

function postProcessMemories(
  items: FindResultItem[],
  options: {
    limit: number;
    scoreThreshold: number;
    leafOnly?: boolean;
  },
): FindResultItem[] {
  const deduped: FindResultItem[] = [];
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => clampScore(b.score) - clampScore(a.score));
  for (const item of sorted) {
    if (options.leafOnly && item.is_leaf !== true) {
      continue;
    }
    if (clampScore(item.score) < options.scoreThreshold) {
      continue;
    }
    const key = getMemoryDedupeKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= options.limit) {
      break;
    }
  }
  return deduped;
}

function formatMemoryLines(items: FindResultItem[]): string {
  return items
    .map((item, index) => {
      const score = clampScore(item.score);
      const abstract = item.abstract?.trim() || item.overview?.trim() || item.uri;
      const category = item.category ?? "memory";
      return `${index + 1}. [${category}] ${abstract} (${(score * 100).toFixed(0)}%)`;
    })
    .join("\n");
}

function isPreferencesMemory(item: FindResultItem): boolean {
  return (
    item.category === "preferences" ||
    item.uri.includes("/preferences/") ||
    item.uri.endsWith("/preferences")
  );
}

function rankForInjection(item: FindResultItem): number {
  // Prefer concrete memory leaves; prefer user preferences when scores are close.
  const baseScore = clampScore(item.score);
  const leafBoost = item.is_leaf ? 1 : 0;
  const preferenceBoost = isPreferencesMemory(item) ? 0.05 : 0;
  return baseScore + leafBoost + preferenceBoost;
}

function pickMemoriesForInjection(items: FindResultItem[], limit: number): FindResultItem[] {
  if (items.length === 0 || limit <= 0) {
    return [];
  }

  const sorted = [...items].sort((a, b) => rankForInjection(b) - rankForInjection(a));
  const deduped: FindResultItem[] = [];
  const seen = new Set<string>();
  for (const item of sorted) {
    const abstractKey = (item.abstract ?? item.overview ?? "").trim().toLowerCase();
    const key = abstractKey || item.uri;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  const leaves = deduped.filter((item) => item.is_leaf);
  if (leaves.length >= limit) {
    return leaves.slice(0, limit);
  }

  const picked = [...leaves];
  const used = new Set(leaves.map((item) => item.uri));
  for (const item of deduped) {
    if (picked.length >= limit) {
      break;
    }
    if (used.has(item.uri)) {
      continue;
    }
    picked.push(item);
  }
  return picked;
}

class OpenVikingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers ?? {});
      if (this.apiKey) {
        headers.set("X-API-Key", this.apiKey);
      }
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        result?: T;
        error?: { code?: string; message?: string };
      };

      if (!response.ok || payload.status === "error") {
        const code = payload.error?.code ? ` [${payload.error.code}]` : "";
        const message = payload.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`OpenViking request failed${code}: ${message}`);
      }

      return (payload.result ?? payload) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<void> {
    await this.request<{ status: string }>("/health");
  }

  async find(
    query: string,
    options: {
      targetUri: string;
      limit: number;
      scoreThreshold?: number;
      sessionId?: string;
    },
  ): Promise<FindResult> {
    const body = {
      query,
      target_uri: options.targetUri,
      limit: options.limit,
      score_threshold: options.scoreThreshold,
      session_id: options.sessionId,
    };
    return this.request<FindResult>("/api/v1/search/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async createSession(): Promise<string> {
    const result = await this.request<{ session_id: string }>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return result.session_id;
  }

  async addSessionMessage(sessionId: string, role: string, content: string): Promise<void> {
    await this.request<{ session_id: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role, content }),
      },
    );
  }

  async extractSessionMemories(sessionId: string): Promise<Array<Record<string, unknown>>> {
    return this.request<Array<Record<string, unknown>>>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/extract`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async deleteUri(uri: string): Promise<void> {
    await this.request(`/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=false`, {
      method: "DELETE",
    });
  }
}

function extractTextsFromUserMessages(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") {
      continue;
    }
    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const blockObj = block as Record<string, unknown>;
        if (blockObj.type === "text" && typeof blockObj.text === "string") {
          texts.push(blockObj.text);
        }
      }
    }
  }
  return texts;
}

const memoryPlugin = {
  id: "memory-openviking",
  name: "Memory (OpenViking)",
  description: "OpenViking-backed long-term memory with auto-recall/capture",
  kind: "memory" as const,
  configSchema: memoryOpenVikingConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryOpenVikingConfigSchema.parse(api.pluginConfig);
    const client = new OpenVikingClient(cfg.baseUrl, cfg.apiKey, cfg.timeoutMs);

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall (OpenViking)",
        description:
          "Search long-term memories from OpenViking. Use when you need past user preferences, facts, or decisions.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default: plugin config)" }),
          ),
          scoreThreshold: Type.Optional(
            Type.Number({ description: "Minimum score (0-1, default: plugin config)" }),
          ),
          targetUri: Type.Optional(
            Type.String({ description: "Search scope URI (default: plugin config)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query } = params as { query: string };
          const limit =
            typeof (params as { limit?: number }).limit === "number"
              ? Math.max(1, Math.floor((params as { limit: number }).limit))
              : cfg.recallLimit;
          const scoreThreshold =
            typeof (params as { scoreThreshold?: number }).scoreThreshold === "number"
              ? Math.max(0, Math.min(1, (params as { scoreThreshold: number }).scoreThreshold))
              : cfg.recallScoreThreshold;
          const targetUri =
            typeof (params as { targetUri?: string }).targetUri === "string"
              ? (params as { targetUri: string }).targetUri
              : cfg.targetUri;
          const requestLimit = Math.max(limit * 4, limit);
          const result = await client.find(query, {
            targetUri,
            limit: requestLimit,
            scoreThreshold: 0,
          });
          const memories = postProcessMemories(result.memories ?? [], {
            limit,
            scoreThreshold,
          });
          if (memories.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant OpenViking memories found." }],
              details: { count: 0, total: result.total ?? 0, scoreThreshold },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Found ${memories.length} memories:\n\n${formatMemoryLines(memories)}`,
              },
            ],
            details: {
              count: memories.length,
              memories,
              total: result.total ?? memories.length,
              scoreThreshold,
              requestLimit,
            },
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store (OpenViking)",
        description:
          "Store text in OpenViking memory pipeline by writing to a session and running memory extraction.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to store as memory source text" }),
          role: Type.Optional(Type.String({ description: "Session role, default user" })),
          sessionId: Type.Optional(Type.String({ description: "Existing OpenViking session ID" })),
        }),
        async execute(_toolCallId, params) {
          const { text } = params as { text: string };
          const role =
            typeof (params as { role?: string }).role === "string"
              ? (params as { role: string }).role
              : "user";
          const sessionIdIn = (params as { sessionId?: string }).sessionId;

          let sessionId = sessionIdIn;
          let createdTempSession = false;
          try {
            if (!sessionId) {
              sessionId = await client.createSession();
              createdTempSession = true;
            }
            await client.addSessionMessage(sessionId, role, text);
            const extracted = await client.extractSessionMemories(sessionId);
            return {
              content: [
                {
                  type: "text",
                  text: `Stored in OpenViking session ${sessionId} and extracted ${extracted.length} memories.`,
                },
              ],
              details: { action: "stored", sessionId, extractedCount: extracted.length, extracted },
            };
          } finally {
            if (createdTempSession && sessionId) {
              await client.deleteSession(sessionId).catch(() => {});
            }
          }
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget (OpenViking)",
        description:
          "Forget memory by URI, or search then delete when a strong single match is found.",
        parameters: Type.Object({
          uri: Type.Optional(Type.String({ description: "Exact memory URI to delete" })),
          query: Type.Optional(Type.String({ description: "Search query to find memory URI" })),
          targetUri: Type.Optional(
            Type.String({ description: "Search scope URI (default: plugin config)" }),
          ),
          limit: Type.Optional(Type.Number({ description: "Search limit (default: 5)" })),
          scoreThreshold: Type.Optional(
            Type.Number({ description: "Minimum score (0-1, default: plugin config)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const uri = (params as { uri?: string }).uri;
          if (uri) {
            if (!isMemoryUri(uri)) {
              return {
                content: [{ type: "text", text: `Refusing to delete non-memory URI: ${uri}` }],
                details: { action: "rejected", uri },
              };
            }
            await client.deleteUri(uri);
            return {
              content: [{ type: "text", text: `Forgotten: ${uri}` }],
              details: { action: "deleted", uri },
            };
          }

          const query = (params as { query?: string }).query;
          if (!query) {
            return {
              content: [{ type: "text", text: "Provide uri or query." }],
              details: { error: "missing_param" },
            };
          }

          const limit =
            typeof (params as { limit?: number }).limit === "number"
              ? Math.max(1, Math.floor((params as { limit: number }).limit))
              : 5;
          const scoreThreshold =
            typeof (params as { scoreThreshold?: number }).scoreThreshold === "number"
              ? Math.max(0, Math.min(1, (params as { scoreThreshold: number }).scoreThreshold))
              : cfg.recallScoreThreshold;
          const targetUri =
            typeof (params as { targetUri?: string }).targetUri === "string"
              ? (params as { targetUri: string }).targetUri
              : cfg.targetUri;
          const requestLimit = Math.max(limit * 4, 20);

          const result = await client.find(query, {
            targetUri,
            limit: requestLimit,
            scoreThreshold: 0,
          });
          const candidates = postProcessMemories(result.memories ?? [], {
            limit: requestLimit,
            scoreThreshold,
            leafOnly: true,
          }).filter((item) => isMemoryUri(item.uri));
          if (candidates.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No matching leaf memory candidates found. Try a more specific query.",
                },
              ],
              details: { action: "none", scoreThreshold },
            };
          }
          const top = candidates[0];
          if (candidates.length === 1 && clampScore(top.score) >= 0.85) {
            await client.deleteUri(top.uri);
            return {
              content: [{ type: "text", text: `Forgotten: ${top.uri}` }],
              details: { action: "deleted", uri: top.uri, score: top.score ?? 0 },
            };
          }

          const list = candidates
            .map((item) => `- ${item.uri} (${(clampScore(item.score) * 100).toFixed(0)}%)`)
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${candidates.length} candidates. Specify uri:\n${list}`,
              },
            ],
            details: { action: "candidates", candidates, scoreThreshold, requestLimit },
          };
        },
      },
      { name: "memory_forget" },
    );

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }
        try {
          const candidateLimit = Math.max(cfg.recallLimit * 4, cfg.recallLimit);
          const result = await client.find(event.prompt, {
            targetUri: cfg.targetUri,
            limit: candidateLimit,
            scoreThreshold: 0,
          });
          const processed = postProcessMemories(result.memories ?? [], {
            limit: candidateLimit,
            scoreThreshold: cfg.recallScoreThreshold,
          });
          const memories = pickMemoriesForInjection(processed, cfg.recallLimit);
          if (memories.length === 0) {
            return;
          }
          const memoryContext = memories
            .map((item) => `- [${item.category ?? "memory"}] ${item.abstract ?? item.uri}`)
            .join("\n");
          api.logger.info?.(
            `memory-openviking: injecting ${memories.length} memories into context`,
          );
          return {
            prependContext:
              "<relevant-memories>\nThe following OpenViking memories may be relevant:\n" +
              `${memoryContext}\n` +
              "</relevant-memories>",
          };
        } catch (err) {
          api.logger.warn(`memory-openviking: auto-recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          api.logger.info(
            `memory-openviking: auto-capture skipped (success=${String(event.success)}, messages=${event.messages?.length ?? 0})`,
          );
          return;
        }
        try {
          const texts = extractTextsFromUserMessages(event.messages);
          api.logger.info(
            `memory-openviking: auto-capture evaluating ${texts.length} text candidates`,
          );
          const decisions = texts
            .map((text) => ({ text, decision: getCaptureDecision(text) }))
            .filter((item) => item.text);
          for (const item of decisions.slice(0, 5)) {
            const preview = item.text.length > 80 ? `${item.text.slice(0, 80)}...` : item.text;
            api.logger.info(
              `memory-openviking: capture-check shouldCapture=${String(item.decision.shouldCapture)} reason=${item.decision.reason} text="${preview}"`,
            );
          }
          const toCapture = decisions
            .filter((item) => item.decision.shouldCapture)
            .map((item) => item.text)
            .slice(0, 3);
          if (toCapture.length === 0) {
            api.logger.info("memory-openviking: auto-capture skipped (no matched texts)");
            return;
          }
          const sessionId = await client.createSession();
          try {
            for (const text of toCapture) {
              await client.addSessionMessage(sessionId, "user", text);
            }
            const extracted = await client.extractSessionMemories(sessionId);
            api.logger.info(
              `memory-openviking: auto-captured ${toCapture.length} messages, extracted ${extracted.length} memories`,
            );
          } finally {
            await client.deleteSession(sessionId).catch(() => {});
          }
        } catch (err) {
          api.logger.warn(`memory-openviking: auto-capture failed: ${String(err)}`);
        }
      });
    }

    api.registerService({
      id: "memory-openviking",
      start: async () => {
        await client.healthCheck().catch(() => {});
        api.logger.info(
          `memory-openviking: initialized (url: ${cfg.baseUrl}, targetUri: ${cfg.targetUri}, search: hybrid endpoint)`,
        );
      },
      stop: () => {
        api.logger.info("memory-openviking: stopped");
      },
    });
  },
};

export default memoryPlugin;
