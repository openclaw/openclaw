// Thin XMemo REST client. All memory operations are remote HTTP calls.
// No local vector store or embedding model is required.

import type { XMemoAuthMode } from "./config.js";

export type XMemoRememberRequest = {
  content: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  memory_type?: "auto" | "semantic" | "episodic" | "procedural" | "working" | "identity";
  semantic_key?: string | null;
  importance?: number;
  confidence?: number;
  expires_at?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

export type XMemoRememberResponse = {
  id: string;
  status?: string;
};

export type XMemoRecallContextRequest = {
  query: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  memory_type?: string;
  status?: string;
  threshold?: number;
  max_items?: number;
  max_tokens?: number;
  prefer_working?: boolean;
};

export type XMemoRecallContextItem = {
  id: string;
  content: string;
  snippet?: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  score?: number;
  memory_type?: string;
  updated_at?: string;
};

export type XMemoRecallContextResponse = {
  items: XMemoRecallContextItem[];
  context_text?: string;
  budget?: { tokens?: number; items?: number };
  coverage?: unknown;
  agent_boundary?: unknown;
};

export type XMemoSearchMemoryRequest = {
  query: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  max_items?: number;
  threshold?: number;
};

export type XMemoSearchMemoryResult = {
  id: string;
  content: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  score?: number;
  memory_type?: string;
};

export type XMemoSearchMemoryResponse = {
  results: XMemoSearchMemoryResult[];
  coverage?: unknown;
  agent_boundary?: unknown;
};

export type XMemoMemory = {
  id: string;
  content: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  memory_type?: string;
  status?: string;
  importance?: number;
  confidence?: number;
  updated_at?: string;
  created_at?: string;
};

export type XMemoUpdateMemoryRequest = {
  content?: string | null;
  path?: string | null;
  bucket?: string | null;
  scope?: string | null;
  team_id?: string | null;
  memory_type?: string | null;
  status?: string | null;
  importance?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  merge_metadata?: boolean;
  merge_provenance?: boolean;
  detect_conflicts?: boolean;
};

export type XMemoForgetMemoryRequest = {
  mode?: "soft_delete" | "hard_delete" | "redact";
  reason?: string | null;
  replacement_content?: string | null;
};

export type XMemoReminderRequest = {
  content: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  due_at?: string | null;
  metadata?: Record<string, unknown>;
};

export type XMemoReminder = {
  id: string;
  content: string;
  status?: string;
  due_at?: string;
};

export type XMemoReminderListResponse = {
  reminders: XMemoReminder[];
};

export type XMemoTimelineEventRequest = {
  content: string;
  event_type?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  session_id?: string | null;
  occurred_at?: string | null;
  importance?: number;
  confidence?: number;
  source?: string | null;
  metadata?: Record<string, unknown>;
};

export type XMemoTimelineEvent = {
  id: string;
  content: string;
  event_type?: string;
  occurred_at?: string;
};

export type XMemoTokenValidateResponse = {
  status: "valid";
  scopes?: string[];
  setup_state?: string;
};

function redactErrorMessage(message: string, apiKey: string): string {
  if (!apiKey) {
    return message;
  }
  // Replace the literal key so it is never echoed in logs, CLI output, or tool results.
  return message.replaceAll(apiKey, "***");
}

/** Structured HTTP error from the XMemo REST client. */
export class XMemoClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly pathname?: string,
  ) {
    super(message);
    this.name = "XMemoClientError";
  }
}

export class XMemoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly agentId: string,
    private readonly agentInstanceId: string,
    private readonly authMode: XMemoAuthMode = "api-key",
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Memory-OS-Agent-ID": this.agentId,
      "X-Memory-OS-Agent-Instance-ID": this.agentInstanceId,
    };
    if (this.authMode === "api-key" || this.authMode === "both") {
      headers["X-API-Key"] = this.apiKey;
    }
    if (this.authMode === "bearer" || this.authMode === "both") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(pathname: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${pathname}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers(),
        ...(options.headers as Record<string, string> | undefined),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      const rawMessage = `XMemo ${pathname} failed (${response.status}): ${text}`;
      throw new XMemoClientError(
        redactErrorMessage(rawMessage, this.apiKey),
        response.status,
        pathname,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return {} as T;
  }

  private buildSearchParams(
    params: Record<string, string | number | boolean | null | undefined>,
  ): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      search.set(key, String(value));
    }
    const query = search.toString();
    return query ? `?${query}` : "";
  }

  async remember(
    request: XMemoRememberRequest,
    signal?: AbortSignal,
  ): Promise<XMemoRememberResponse> {
    return this.request<XMemoRememberResponse>("/v1/remember", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async validateToken(signal?: AbortSignal): Promise<XMemoTokenValidateResponse> {
    return this.request<XMemoTokenValidateResponse>("/v1/auth/token/validate", {
      method: "GET",
      signal,
    });
  }

  async recallContext(
    request: XMemoRecallContextRequest,
    signal?: AbortSignal,
  ): Promise<XMemoRecallContextResponse> {
    return this.request<XMemoRecallContextResponse>("/v1/recall/context", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async searchMemory(
    request: XMemoSearchMemoryRequest,
    signal?: AbortSignal,
  ): Promise<XMemoSearchMemoryResponse> {
    const query = this.buildSearchParams({
      query: request.query,
      path: request.path,
      bucket: request.bucket,
      scope: request.scope,
      team_id: request.team_id,
      limit: request.max_items,
      threshold: request.threshold,
    });
    return this.request<XMemoSearchMemoryResponse>(`/v1/memories/search${query}`, {
      method: "GET",
      signal,
    });
  }

  async getMemory(id: string, signal?: AbortSignal): Promise<XMemoMemory> {
    try {
      return await this.request<XMemoMemory>(`/v1/memories/${encodeURIComponent(id)}`, {
        method: "GET",
        signal,
      });
    } catch (error) {
      // Only fall back to search-by-id when the direct GET endpoint is missing or
      // unavailable (404/405). Auth, timeout, and server errors should surface as-is.
      if (!(error instanceof XMemoClientError) || (error.status !== 404 && error.status !== 405)) {
        throw error;
      }
      const search = await this.searchMemory(
        {
          query: id,
          bucket: undefined,
          scope: null,
          team_id: null,
          max_items: 5,
        },
        signal,
      );
      const match = search.results.find((r) => r.id === id);
      if (match) {
        return {
          id: match.id,
          content: match.content,
          path: match.path,
          bucket: match.bucket,
          scope: match.scope,
          memory_type: match.memory_type,
        };
      }
      throw error;
    }
  }

  async updateMemory(
    id: string,
    request: XMemoUpdateMemoryRequest,
    signal?: AbortSignal,
  ): Promise<XMemoMemory> {
    return this.request<XMemoMemory>(`/v1/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
      signal,
    });
  }

  async forgetMemory(
    id: string,
    request?: XMemoForgetMemoryRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request<unknown>(`/v1/memories/${encodeURIComponent(id)}/forget`, {
      method: "POST",
      body: JSON.stringify(request ?? {}),
      signal,
    });
  }

  async createReminder(
    request: XMemoReminderRequest,
    signal?: AbortSignal,
  ): Promise<XMemoReminder> {
    return this.request<XMemoReminder>("/v1/reminders", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async listReminders(
    params?: {
      bucket?: string;
      scope?: string | null;
      item_status?: string;
    },
    signal?: AbortSignal,
  ): Promise<XMemoReminderListResponse> {
    const query = this.buildSearchParams({
      bucket: params?.bucket,
      scope: params?.scope,
      item_status: params?.item_status,
    });
    return this.request<XMemoReminderListResponse>(`/v1/reminders${query}`, {
      method: "GET",
      signal,
    });
  }

  async completeReminder(id: string, signal?: AbortSignal): Promise<XMemoReminder> {
    return this.request<XMemoReminder>(`/v1/reminders/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      signal,
    });
  }

  async recordEvent(
    request: XMemoTimelineEventRequest,
    signal?: AbortSignal,
  ): Promise<XMemoTimelineEvent> {
    return this.request<XMemoTimelineEvent>("/v1/timeline/events", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async getTimeline(
    params?: {
      bucket?: string;
      scope?: string | null;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<XMemoTimelineEvent[]> {
    const query = this.buildSearchParams({
      bucket: params?.bucket,
      scope: params?.scope,
      limit: params?.limit,
    });
    return this.request<XMemoTimelineEvent[]>(`/v1/timeline${query}`, {
      method: "GET",
      signal,
    });
  }
}
