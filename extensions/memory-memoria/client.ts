import type { MemoriaMemoryType, MemoriaPluginConfig, MemoriaTrustTier } from "./config.js";

export type MemoriaMemoryRecord = {
  memory_id: string;
  content: string;
  memory_type?: string;
  trust_tier?: string | null;
  confidence?: number | null;
  session_id?: string | null;
  is_active?: boolean;
  observed_at?: string | null;
  updated_at?: string | null;
};

export type MemoriaListMemoriesResponse = {
  items: MemoriaMemoryRecord[];
  count: number;
  user_id: string;
  backend: string;
  partial?: boolean;
  include_inactive?: boolean;
  limitations?: string[];
};

export type MemoriaStatsResponse = {
  backend: string;
  user_id: string;
  activeMemoryCount: number;
  inactiveMemoryCount: number | null;
  byType: Record<string, number>;
  entityCount: number | null;
  snapshotCount: number | null;
  branchCount: number | null;
  healthWarnings: string[];
  partial?: boolean;
  limitations?: string[];
};

type MemoriaListPageResponse = {
  items: MemoriaMemoryRecord[];
  next_cursor?: string | null;
};

export const EMBEDDED_UNAVAILABLE_MESSAGE =
  "memory-memoria embedded backend is not bootstrapped by OpenClaw core. " +
  "Provide a user-managed Python Memoria runtime, or use backend=http with apiUrl/apiKey.";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    query.set(key, String(value));
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : "";
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizeMemoryRecord(value: unknown): MemoriaMemoryRecord {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    memory_id: typeof record.memory_id === "string" ? record.memory_id : "",
    content: typeof record.content === "string" ? record.content : "",
    memory_type:
      typeof record.memory_type === "string"
        ? record.memory_type
        : typeof record.type === "string"
          ? record.type
          : undefined,
    trust_tier:
      typeof record.trust_tier === "string" || record.trust_tier === null
        ? (record.trust_tier as string | null)
        : undefined,
    confidence:
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? record.confidence
        : null,
    session_id:
      typeof record.session_id === "string" || record.session_id === null
        ? (record.session_id as string | null)
        : undefined,
    is_active: typeof record.is_active === "boolean" ? record.is_active : undefined,
    observed_at:
      typeof record.observed_at === "string" || record.observed_at === null
        ? (record.observed_at as string | null)
        : undefined,
    updated_at:
      typeof record.updated_at === "string" || record.updated_at === null
        ? (record.updated_at as string | null)
        : undefined,
  };
}

function extractErrorMessage(payload: unknown): string {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  if (payload && typeof payload === "object") {
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
    if (detail && typeof detail === "object") {
      const detailMessage = (detail as Record<string, unknown>).message;
      if (typeof detailMessage === "string" && detailMessage.trim()) {
        return detailMessage.trim();
      }
    }
    const message = (payload as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return "unknown Memoria error";
}

function normalizeTypeCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {
    profile: 0,
    semantic: 0,
    procedural: 0,
    working: 0,
    tool_result: 0,
  };

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return counts;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      counts[key] = raw;
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const total = (raw as Record<string, unknown>).total;
      if (typeof total === "number" && Number.isFinite(total)) {
        counts[key] = total;
      }
    }
  }

  return counts;
}

type MemoriaClientOps = {
  health(userId: string): Promise<{ status: string; warnings?: string[] }>;
  storeMemory(params: {
    userId: string;
    content: string;
    memoryType: MemoriaMemoryType;
    trustTier?: MemoriaTrustTier;
    sessionId?: string;
    source?: string;
  }): Promise<MemoriaMemoryRecord>;
  search(params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }): Promise<MemoriaMemoryRecord[]>;
  retrieve(params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }): Promise<MemoriaMemoryRecord[]>;
  getMemory(params: { userId: string; memoryId: string }): Promise<MemoriaMemoryRecord | null>;
  listMemories(params: {
    userId: string;
    memoryType?: MemoriaMemoryType;
    limit: number;
    sessionId?: string;
    includeInactive?: boolean;
  }): Promise<MemoriaListMemoriesResponse>;
  stats(userId: string): Promise<MemoriaStatsResponse>;
  deleteMemory(params: {
    userId: string;
    memoryId: string;
    reason?: string;
  }): Promise<{ purged: number }>;
};

type MemoriaClientLogger = {
  warn?: (message: string) => void;
};

class MemoriaHttpClient implements MemoriaClientOps {
  constructor(
    private readonly config: MemoriaPluginConfig,
    private readonly logger?: MemoriaClientLogger,
  ) {}

  private warn(message: string) {
    this.logger?.warn?.(`memory-memoria: ${message}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.config.apiUrl) {
      throw new Error("apiUrl is required when backend=http");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      const response = await fetch(joinUrl(this.config.apiUrl, path), {
        method,
        headers: {
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      const payload = raw ? tryParseJson(raw) : undefined;

      if (!response.ok) {
        const detail = extractErrorMessage(payload ?? raw);
        throw new Error(`${method} ${path} failed (${response.status}): ${detail}`);
      }

      return (payload ?? raw) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(_userId: string) {
    return this.request<{ status: string; warnings?: string[] }>("GET", "/health");
  }

  async storeMemory(params: {
    userId: string;
    content: string;
    memoryType: MemoriaMemoryType;
    trustTier?: MemoriaTrustTier;
    sessionId?: string;
    source?: string;
  }): Promise<MemoriaMemoryRecord> {
    const result = await this.request<MemoriaMemoryRecord>("POST", "/v1/memories", {
      user_id: params.userId,
      content: params.content,
      memory_type: params.memoryType,
      trust_tier: params.trustTier,
      session_id: params.sessionId,
      source: params.source ?? "openclaw:memory_store",
    });
    return normalizeMemoryRecord(result);
  }

  async search(params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }): Promise<MemoriaMemoryRecord[]> {
    try {
      const result = await this.request<MemoriaMemoryRecord[]>("POST", "/v1/memories/search", {
        user_id: params.userId,
        query: params.query,
        top_k: params.topK,
        memory_types: params.memoryTypes,
        session_id: params.sessionId,
        include_cross_session: params.includeCrossSession ?? true,
      });
      return result.map((entry) => normalizeMemoryRecord(entry));
    } catch (error) {
      this.warn(`search endpoint failed; falling back to retrieve: ${String(error)}`);
      return this.retrieve(params);
    }
  }

  async retrieve(params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }): Promise<MemoriaMemoryRecord[]> {
    const result = await this.request<MemoriaMemoryRecord[]>("POST", "/v1/memories/retrieve", {
      user_id: params.userId,
      query: params.query,
      top_k: params.topK,
      memory_types: params.memoryTypes,
      session_id: params.sessionId,
      include_cross_session: params.includeCrossSession ?? true,
    });
    return result.map((entry) => normalizeMemoryRecord(entry));
  }

  private async listMemoriesPage(params: {
    userId: string;
    cursor?: string;
    memoryType?: MemoriaMemoryType;
  }) {
    return this.request<MemoriaListPageResponse>(
      "GET",
      `/v1/memories${encodeQuery({
        user_id: params.userId,
        limit: 200,
        cursor: params.cursor,
        memory_type: params.memoryType,
      })}`,
    );
  }

  async getMemory(params: {
    userId: string;
    memoryId: string;
  }): Promise<MemoriaMemoryRecord | null> {
    try {
      const result = await this.request<MemoriaMemoryRecord>(
        "GET",
        `/v1/memories/${encodeURIComponent(params.memoryId)}${encodeQuery({ user_id: params.userId })}`,
      );
      return normalizeMemoryRecord(result);
    } catch (error) {
      this.warn(`getMemory endpoint failed; falling back to list scan: ${String(error)}`);
      let cursor: string | undefined;
      for (let page = 0; page < this.config.maxListPages; page += 1) {
        const response = await this.listMemoriesPage({
          userId: params.userId,
          cursor,
        });
        const match = response.items.find((item) => item.memory_id === params.memoryId);
        if (match) {
          return normalizeMemoryRecord(match);
        }
        cursor = response.next_cursor ?? undefined;
        if (!cursor) {
          break;
        }
      }
      return null;
    }
  }

  async listMemories(params: {
    userId: string;
    memoryType?: MemoriaMemoryType;
    limit: number;
    sessionId?: string;
    includeInactive?: boolean;
  }): Promise<MemoriaListMemoriesResponse> {
    const limitations: string[] = [];
    if (params.includeInactive) {
      limitations.push("HTTP backend cannot list inactive memories.");
    }
    if (params.sessionId) {
      limitations.push("HTTP backend cannot filter memory_list by sessionId.");
    }

    const items: MemoriaMemoryRecord[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < this.config.maxListPages && items.length < params.limit; page += 1) {
      const response = await this.listMemoriesPage({
        userId: params.userId,
        cursor,
        memoryType: params.memoryType,
      });
      items.push(...response.items.map((entry) => normalizeMemoryRecord(entry)));
      cursor = response.next_cursor ?? undefined;
      if (!cursor) {
        break;
      }
    }

    return {
      items: items.slice(0, params.limit),
      count: Math.min(items.length, params.limit),
      user_id: params.userId,
      backend: "http",
      partial: limitations.length > 0,
      include_inactive: params.includeInactive ?? false,
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  }

  async stats(userId: string): Promise<MemoriaStatsResponse> {
    try {
      const stats = await this.request<{
        activeMemoryCount?: number;
        inactiveMemoryCount?: number;
        byType?: Record<string, number>;
        entityCount?: number;
        snapshotCount?: number;
        branchCount?: number;
        healthWarnings?: string[];
      }>("GET", `/v1/memories/stats${encodeQuery({ user_id: userId })}`);

      return {
        backend: "http",
        user_id: userId,
        activeMemoryCount:
          typeof stats.activeMemoryCount === "number" ? Math.max(0, stats.activeMemoryCount) : 0,
        inactiveMemoryCount:
          typeof stats.inactiveMemoryCount === "number"
            ? Math.max(0, stats.inactiveMemoryCount)
            : null,
        byType: normalizeTypeCounts(stats.byType),
        entityCount: typeof stats.entityCount === "number" ? Math.max(0, stats.entityCount) : null,
        snapshotCount:
          typeof stats.snapshotCount === "number" ? Math.max(0, stats.snapshotCount) : null,
        branchCount: typeof stats.branchCount === "number" ? Math.max(0, stats.branchCount) : null,
        healthWarnings: Array.isArray(stats.healthWarnings)
          ? stats.healthWarnings.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    } catch {
      const list = await this.listMemories({ userId, limit: 500 });
      const byType: Record<string, number> = {};
      for (const item of list.items) {
        const type = item.memory_type ?? "unknown";
        byType[type] = (byType[type] ?? 0) + 1;
      }

      return {
        backend: "http",
        user_id: userId,
        activeMemoryCount: list.count,
        inactiveMemoryCount: null,
        byType,
        entityCount: null,
        snapshotCount: null,
        branchCount: null,
        healthWarnings: [],
        partial: true,
        limitations: ["Detailed stats endpoint unavailable; derived from memory_list."],
      };
    }
  }

  deleteMemory(params: {
    userId: string;
    memoryId: string;
    reason?: string;
  }): Promise<{ purged: number }> {
    return this.request<{ purged: number }>(
      "DELETE",
      `/v1/memories/${encodeURIComponent(params.memoryId)}${encodeQuery({
        user_id: params.userId,
        reason: params.reason,
      })}`,
    );
  }
}

class MemoriaEmbeddedClient implements MemoriaClientOps {
  constructor(private readonly config: MemoriaPluginConfig) {}

  private unsupported(): never {
    const base = `${EMBEDDED_UNAVAILABLE_MESSAGE} configured pythonExecutable=${this.config.pythonExecutable}`;
    const extras = this.config.dbUrl ? ` dbUrl=${this.config.dbUrl}` : "";
    throw new Error(`${base}${extras}`);
  }

  async health(_userId: string): Promise<{ status: string; warnings?: string[] }> {
    this.unsupported();
  }

  async storeMemory(_params: {
    userId: string;
    content: string;
    memoryType: MemoriaMemoryType;
    trustTier?: MemoriaTrustTier;
    sessionId?: string;
    source?: string;
  }): Promise<MemoriaMemoryRecord> {
    this.unsupported();
  }

  async search(_params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }): Promise<MemoriaMemoryRecord[]> {
    this.unsupported();
  }

  async retrieve(_params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }): Promise<MemoriaMemoryRecord[]> {
    this.unsupported();
  }

  async getMemory(_params: {
    userId: string;
    memoryId: string;
  }): Promise<MemoriaMemoryRecord | null> {
    this.unsupported();
  }

  async listMemories(_params: {
    userId: string;
    memoryType?: MemoriaMemoryType;
    limit: number;
    sessionId?: string;
    includeInactive?: boolean;
  }): Promise<MemoriaListMemoriesResponse> {
    this.unsupported();
  }

  async stats(_userId: string): Promise<MemoriaStatsResponse> {
    this.unsupported();
  }

  async deleteMemory(_params: {
    userId: string;
    memoryId: string;
    reason?: string;
  }): Promise<{ purged: number }> {
    this.unsupported();
  }
}

export class MemoriaClient {
  private readonly impl: MemoriaClientOps;

  constructor(config: MemoriaPluginConfig, options: { logger?: MemoriaClientLogger } = {}) {
    this.impl =
      config.backend === "http"
        ? new MemoriaHttpClient(config, options.logger)
        : new MemoriaEmbeddedClient(config);
  }

  health(userId: string) {
    return this.impl.health(userId);
  }

  storeMemory(params: {
    userId: string;
    content: string;
    memoryType: MemoriaMemoryType;
    trustTier?: MemoriaTrustTier;
    sessionId?: string;
    source?: string;
  }) {
    return this.impl.storeMemory(params);
  }

  search(params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }) {
    return this.impl.search(params);
  }

  retrieve(params: {
    userId: string;
    query: string;
    topK: number;
    memoryTypes?: MemoriaMemoryType[];
    sessionId?: string;
    includeCrossSession?: boolean;
  }) {
    return this.impl.retrieve(params);
  }

  getMemory(params: { userId: string; memoryId: string }) {
    return this.impl.getMemory(params);
  }

  listMemories(params: {
    userId: string;
    memoryType?: MemoriaMemoryType;
    limit: number;
    sessionId?: string;
    includeInactive?: boolean;
  }) {
    return this.impl.listMemories(params);
  }

  stats(userId: string) {
    return this.impl.stats(userId);
  }

  deleteMemory(params: { userId: string; memoryId: string; reason?: string }) {
    return this.impl.deleteMemory(params);
  }
}
