import { createHash } from "node:crypto";
import type { spawn } from "node:child_process";

export type FindResultItem = {
  uri: string;
  level?: number;
  abstract?: string;
  overview?: string;
  category?: string;
  score?: number;
  match_reason?: string;
};

export type FindResult = {
  memories?: FindResultItem[];
  resources?: FindResultItem[];
  skills?: FindResultItem[];
  total?: number;
};

export type CaptureMode = "semantic" | "keyword";
export type ScopeName = "user" | "agent";
export type RuntimeIdentity = {
  userId: string;
  agentId: string;
};
export type LocalClientCacheEntry = {
  client: OpenVikingClient;
  process: ReturnType<typeof spawn> | null;
};

export type PendingClientEntry = {
  promise: Promise<OpenVikingClient>;
  resolve: (c: OpenVikingClient) => void;
  reject: (err: unknown) => void;
};

export const localClientCache = new Map<string, LocalClientCacheEntry>();

// Module-level pending promise map: shared across all plugin registrations so
// that both [gateway] and [plugins] contexts await the same promise and
// don't create duplicate pending promises that never resolve.
export const localClientPendingPromises = new Map<string, PendingClientEntry>();

const MEMORY_URI_PATTERNS = [
  /^viking:\/\/user\/(?:[^/]+\/)?memories(?:\/|$)/,
  /^viking:\/\/agent\/(?:[^/]+\/)?memories(?:\/|$)/,
];
const USER_STRUCTURE_DIRS = new Set(["memories"]);
const AGENT_STRUCTURE_DIRS = new Set(["memories", "skills", "instructions", "workspaces"]);

function md5Short(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 12);
}

export function isMemoryUri(uri: string): boolean {
  return MEMORY_URI_PATTERNS.some((pattern) => pattern.test(uri));
}

export class OpenVikingClient {
  private spaceCache = new Map<string, Partial<Record<ScopeName, string>>>();
  private identityCache = new Map<string, RuntimeIdentity>();

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultAgentId: string,
    private readonly timeoutMs: number,
  ) {}

  getDefaultAgentId(): string {
    return this.defaultAgentId;
  }

  private async request<T>(path: string, init: RequestInit = {}, agentId?: string): Promise<T> {
    const effectiveAgentId = agentId ?? this.defaultAgentId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers ?? {});
      if (this.apiKey) {
        headers.set("X-API-Key", this.apiKey);
      }
      if (effectiveAgentId) {
        headers.set("X-OpenViking-Agent", effectiveAgentId);
        headers.set("X-OpenViking-Account", "default");
        headers.set("X-OpenViking-User", "agent");
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

  private async ls(uri: string, agentId?: string): Promise<Array<Record<string, unknown>>> {
    return this.request<Array<Record<string, unknown>>>(
      `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}&output=original`,
      {},
      agentId,
    );
  }

  private async getRuntimeIdentity(agentId?: string): Promise<RuntimeIdentity> {
    const effectiveAgentId = agentId ?? this.defaultAgentId;
    const cached = this.identityCache.get(effectiveAgentId);
    if (cached) {
      return cached;
    }
    const fallback: RuntimeIdentity = { userId: "default", agentId: effectiveAgentId || "default" };
    try {
      const status = await this.request<{ user?: unknown }>("/api/v1/system/status", {}, agentId);
      const userId =
        typeof status.user === "string" && status.user.trim() ? status.user.trim() : "default";
      const identity: RuntimeIdentity = { userId, agentId: effectiveAgentId || "default" };
      this.identityCache.set(effectiveAgentId, identity);
      return identity;
    } catch {
      this.identityCache.set(effectiveAgentId, fallback);
      return fallback;
    }
  }

  private async resolveScopeSpace(scope: ScopeName, agentId?: string): Promise<string> {
    const effectiveAgentId = agentId ?? this.defaultAgentId;
    const agentScopes = this.spaceCache.get(effectiveAgentId);
    const cached = agentScopes?.[scope];
    if (cached) {
      return cached;
    }

    const identity = await this.getRuntimeIdentity(agentId);
    const fallbackSpace =
      scope === "user" ? identity.userId : md5Short(`${identity.userId}:${identity.agentId}`);
    const reservedDirs = scope === "user" ? USER_STRUCTURE_DIRS : AGENT_STRUCTURE_DIRS;
    const preferredSpace =
      scope === "user" ? identity.userId : md5Short(`${identity.userId}:${identity.agentId}`);

    const saveSpace = (space: string) => {
      const existing = this.spaceCache.get(effectiveAgentId) ?? {};
      existing[scope] = space;
      this.spaceCache.set(effectiveAgentId, existing);
    };

    try {
      const entries = await this.ls(`viking://${scope}`, agentId);
      const spaces = entries
        .filter((entry) => entry?.isDir === true)
        .map((entry) => (typeof entry.name === "string" ? entry.name.trim() : ""))
        .filter((name) => name && !name.startsWith(".") && !reservedDirs.has(name));

      if (spaces.length > 0) {
        if (spaces.includes(preferredSpace)) {
          saveSpace(preferredSpace);
          return preferredSpace;
        }
        if (scope === "user" && spaces.includes("default")) {
          saveSpace("default");
          return "default";
        }
        if (spaces.length === 1) {
          saveSpace(spaces[0]!);
          return spaces[0]!;
        }
      }
    } catch {
      // Fall back to identity-derived space when listing fails.
    }

    saveSpace(fallbackSpace);
    return fallbackSpace;
  }

  private async normalizeTargetUri(targetUri: string, agentId?: string): Promise<string> {
    const trimmed = targetUri.trim().replace(/\/+$/, "");
    const match = trimmed.match(/^viking:\/\/(user|agent)(?:\/(.*))?$/);
    if (!match) {
      return trimmed;
    }
    const scope = match[1] as ScopeName;
    const rawRest = (match[2] ?? "").trim();
    if (!rawRest) {
      return trimmed;
    }
    const parts = rawRest.split("/").filter(Boolean);
    if (parts.length === 0) {
      return trimmed;
    }

    const reservedDirs = scope === "user" ? USER_STRUCTURE_DIRS : AGENT_STRUCTURE_DIRS;
    if (!reservedDirs.has(parts[0]!)) {
      return trimmed;
    }

    const space = await this.resolveScopeSpace(scope, agentId);
    return `viking://${scope}/${space}/${parts.join("/")}`;
  }

  async find(
    query: string,
    options: {
      targetUri: string;
      limit: number;
      scoreThreshold?: number;
    },
    agentId?: string,
  ): Promise<FindResult> {
    const normalizedTargetUri = await this.normalizeTargetUri(options.targetUri, agentId);
    const body = {
      query,
      target_uri: normalizedTargetUri,
      limit: options.limit,
      score_threshold: options.scoreThreshold,
    };
    return this.request<FindResult>("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify(body),
    }, agentId);
  }

  async read(uri: string, agentId?: string): Promise<string> {
    return this.request<string>(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
      {},
      agentId,
    );
  }

  async addSessionMessage(sessionId: string, role: string, content: string, agentId?: string): Promise<void> {
    await this.request<{ session_id: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role, content }),
      },
      agentId,
    );
  }

  /** GET session — server auto-creates if absent; also loads messages from storage before extract. */
  async getSession(sessionId: string, agentId?: string): Promise<{ message_count?: number }> {
    return this.request<{ message_count?: number }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      agentId,
    );
  }

  /**
   * Commit a session: archive (Phase 1) and extract memories (Phase 2).
   * wait=false (default): Phase 2 runs in background, returns task_id for polling.
   * wait=true: blocks until Phase 2 completes, returns memories_extracted count.
   */
  async commitSession(
    sessionId: string,
    options?: { wait?: boolean; agentId?: string },
  ): Promise<{
    session_id: string;
    status: string;
    task_id?: string;
    archive_uri?: string;
    archived?: boolean;
    memories_extracted?: number;
  }> {
    const wait = options?.wait ?? false;
    return this.request<{
      session_id: string;
      status: string;
      task_id?: string;
      archive_uri?: string;
      archived?: boolean;
      memories_extracted?: number;
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit?wait=${wait}`, {
      method: "POST",
      body: JSON.stringify({}),
    }, options?.agentId);
  }

  async deleteSession(sessionId: string, agentId?: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, agentId);
  }

  async deleteUri(uri: string, agentId?: string): Promise<void> {
    await this.request(`/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=false`, {
      method: "DELETE",
    }, agentId);
  }
}
