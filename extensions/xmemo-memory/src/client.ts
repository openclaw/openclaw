// Thin XMemo REST client. All memory operations are remote HTTP calls.
// No local vector store or embedding model is required.

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
  metadata?: Record<string, unknown>;
};

export type XMemoTimelineEvent = {
  id: string;
  content: string;
  event_type?: string;
  occurred_at?: string;
};

export class XMemoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    private readonly agentInstanceId: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.token}`,
      "X-Memory-OS-Agent-ID": this.agentId,
      "X-Memory-OS-Agent-Instance-ID": this.agentInstanceId,
    };
  }

  private async request<T>(pathname: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${pathname}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers(),
        ...(options.headers as Record<string, string> ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(`XMemo ${pathname} failed (${response.status}): ${text}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return {} as T;
  }

  async remember(request: XMemoRememberRequest): Promise<XMemoRememberResponse> {
    return this.request<XMemoRememberResponse>("/v1/remember", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async recallContext(request: XMemoRecallContextRequest): Promise<XMemoRecallContextResponse> {
    return this.request<XMemoRecallContextResponse>("/v1/recall/context", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async searchMemory(request: XMemoSearchMemoryRequest): Promise<XMemoSearchMemoryResponse> {
    return this.request<XMemoSearchMemoryResponse>("/v1/memories/search", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async getMemory(id: string): Promise<XMemoMemory> {
    return this.request<XMemoMemory>(`/v1/memories/${encodeURIComponent(id)}`, {
      method: "GET",
    });
  }

  async updateMemory(id: string, request: XMemoUpdateMemoryRequest): Promise<XMemoMemory> {
    return this.request<XMemoMemory>(`/v1/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  async forgetMemory(id: string, request?: XMemoForgetMemoryRequest): Promise<unknown> {
    return this.request<unknown>(`/v1/memories/${encodeURIComponent(id)}/forget`, {
      method: "POST",
      body: JSON.stringify(request ?? {}),
    });
  }

  async createReminder(request: XMemoReminderRequest): Promise<XMemoReminder> {
    return this.request<XMemoReminder>("/v1/reminders", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async listReminders(params?: { bucket?: string; scope?: string | null; status?: string }): Promise<XMemoReminder[]> {
    const search = new URLSearchParams();
    if (params?.bucket) search.set("bucket", params.bucket);
    if (params?.scope) search.set("scope", params.scope);
    if (params?.status) search.set("status", params.status);
    const query = search.toString();
    return this.request<XMemoReminder[]>(`/v1/reminders${query ? `?${query}` : ""}`, { method: "GET" });
  }

  async completeReminder(id: string): Promise<XMemoReminder> {
    return this.request<XMemoReminder>(`/v1/reminders/${encodeURIComponent(id)}/complete`, {
      method: "POST",
    });
  }

  async recordEvent(request: XMemoTimelineEventRequest): Promise<XMemoTimelineEvent> {
    return this.request<XMemoTimelineEvent>("/v1/timeline/events", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async getTimeline(params?: { bucket?: string; scope?: string | null; limit?: number }): Promise<XMemoTimelineEvent[]> {
    const search = new URLSearchParams();
    if (params?.bucket) search.set("bucket", params.bucket);
    if (params?.scope) search.set("scope", params.scope);
    if (params?.limit) search.set("limit", String(params.limit));
    const query = search.toString();
    return this.request<XMemoTimelineEvent[]>(`/v1/timeline${query ? `?${query}` : ""}`, { method: "GET" });
  }
}
