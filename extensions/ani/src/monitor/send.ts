/**
 * Fetch wrapper with exponential backoff retry for transient failures.
 * Retries on network errors, 429 (rate limit), and 502/503/504 server errors.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, opts);

      // Retry on 429 (rate limit) — respect Retry-After header
      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfterSec = Number(res.headers.get("Retry-After") || 0);
        const retryDelay =
          retryAfterSec > 0
            ? Math.min(retryAfterSec, 30) * 1000
            : baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
        await res.body?.cancel(); // drain response to free connection
        await new Promise((r) => setTimeout(r, retryDelay));
        continue;
      }

      // Retry on server errors (502, 503, 504) but NOT on client errors (4xx)
      if (res.status >= 502 && res.status <= 504 && attempt < maxAttempts) {
        await res.body?.cancel(); // drain response to free connection
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr ?? new Error("fetchWithRetry: all attempts failed");
}

/** Interaction option for interactive cards. */
export interface AniInteractionOption {
  label: string;
  value: string;
}

/** Interaction layer payload for approval/selection UI. */
export interface AniInteraction {
  type: "approval" | "selection";
  prompt?: string;
  options?: AniInteractionOption[];
}

/** Artifact payload for ANI structured content. */
export interface AniArtifact {
  artifact_type: "html" | "code" | "mermaid" | "image";
  source: string;
  title?: string;
  language?: string;
}

/** Result from uploading a file to the ANI backend. */
export interface AniFileUploadResult {
  url: string;
  filename: string;
  size: number;
}

/**
 * Upload a file to the ANI backend via multipart form data.
 * Endpoint: POST /api/v1/files/upload (max 32MB).
 */
export async function uploadAniFile(opts: {
  serverUrl: string;
  apiKey: string;
  buffer: Buffer | Uint8Array;
  filename: string;
}): Promise<AniFileUploadResult> {
  const url = `${opts.serverUrl}/api/v1/files/upload`;
  const form = new FormData();
  const bytes = Uint8Array.from(opts.buffer);
  const blob = new Blob([bytes]);
  form.append("file", blob, opts.filename);

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI file upload failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as {
    data?: { url?: string; filename?: string; size?: number };
  };
  const data = json.data ?? {};
  return {
    url: data.url ?? "",
    filename: data.filename ?? opts.filename,
    size: data.size ?? 0,
  };
}

/** ANI attachment matching backend model.Attachment. */
export interface AniAttachment {
  type: string;
  url?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
  content?: string;
}

/** Send a message to an ANI conversation via REST API. */
export async function sendAniMessage(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  text: string;
  /** If provided, sends as content_type "artifact" instead of plain text. */
  artifact?: AniArtifact;
  /** Entity IDs to @mention (must be conversation participants). */
  mentions?: number[];
  /** Interaction layer for interactive cards (approval/selection UI). */
  interaction?: AniInteraction;
  /** File/media attachments to include with the message. */
  attachments?: AniAttachment[];
  /** Content type override (e.g. "image", "audio", "file", "video"). */
  contentType?: string;
  /** Message ID to reply to. */
  replyTo?: number;
  /** Stream identifier for streaming responses. */
  streamId?: string;
  /** Status layer for progress updates during streaming. */
  statusLayer?: { phase: string; progress: number; text: string };
}): Promise<{ messageId: number }> {
  const url = `${opts.serverUrl}/api/v1/messages/send`;

  const layers: Record<string, unknown> = opts.artifact
    ? { summary: opts.text, data: opts.artifact }
    : { summary: opts.text };

  if (opts.interaction) {
    layers.interaction = opts.interaction;
  }
  if (opts.statusLayer) {
    layers.status = opts.statusLayer;
  }

  // Determine content_type: artifact > explicit contentType > default (omit for text)
  let contentType: string | undefined;
  if (opts.artifact) {
    contentType = "artifact";
  } else if (opts.contentType) {
    contentType = opts.contentType;
  }

  const payload: Record<string, unknown> = {
    conversation_id: opts.conversationId,
    layers,
    ...(contentType ? { content_type: contentType } : {}),
    ...(opts.mentions && opts.mentions.length > 0 ? { mentions: opts.mentions } : {}),
    ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    ...(opts.streamId ? { stream_id: opts.streamId } : {}),
  };

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI send failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: { id?: number }; id?: number };
  const msg = json.data ?? json;
  return { messageId: msg.id ?? 0 };
}

/** Fetch conversation details (title, description, prompt, participants). */
export async function fetchConversation(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
}): Promise<AniConversation | null> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: AniConversation };
    return json.data ?? null;
  } catch {
    return null;
  }
}

/** Fetch conversation memories. */
export async function fetchConversationMemories(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
}): Promise<AniMemory[]> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/memories`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { memories?: AniMemory[] } };
    return json.data?.memories ?? [];
  } catch {
    return [];
  }
}

export interface AniConversation {
  id: number;
  conv_type?: string;
  title?: string;
  description?: string;
  prompt?: string;
  participants?: Array<{
    entity_id: number;
    role?: string;
    entity?: {
      id: number;
      display_name?: string;
      entity_type?: string;
    };
  }>;
}

export interface AniMemory {
  id: number;
  key: string;
  content: string;
}

export interface AniTaskEntity {
  id?: number;
  display_name?: string;
  entity_type?: string;
}

export interface AniTask {
  id: number;
  conversation_id: number;
  title: string;
  description?: string;
  assignee_id?: number | null;
  status: string;
  priority: string;
  due_date?: string | null;
  parent_task_id?: number | null;
  sort_order?: number;
  created_by: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  assignee?: AniTaskEntity | null;
  creator?: AniTaskEntity | null;
}

export async function listAniTasks(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  status?: string;
}): Promise<AniTask[]> {
  const query = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/tasks${query}`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI list tasks failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: AniTask[] };
  return json.data ?? [];
}

export async function getAniTask(opts: {
  serverUrl: string;
  apiKey: string;
  taskId: number;
}): Promise<AniTask> {
  const url = `${opts.serverUrl}/api/v1/tasks/${opts.taskId}`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI get task failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: AniTask };
  if (!json.data) {
    throw new Error("ANI get task failed: missing task payload");
  }
  return json.data;
}

export async function createAniTask(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  title: string;
  description?: string;
  assignee_id?: number;
  priority?: string;
  due_date?: string;
  parent_task_id?: number;
}): Promise<AniTask> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/tasks`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      title: opts.title,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.assignee_id != null ? { assignee_id: opts.assignee_id } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.due_date ? { due_date: opts.due_date } : {}),
      ...(opts.parent_task_id != null ? { parent_task_id: opts.parent_task_id } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI create task failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: AniTask };
  if (!json.data) {
    throw new Error("ANI create task failed: missing task payload");
  }
  return json.data;
}

export async function updateAniTask(opts: {
  serverUrl: string;
  apiKey: string;
  taskId: number;
  title?: string;
  description?: string;
  assignee_id?: number;
  status?: string;
  priority?: string;
  due_date?: string;
  sort_order?: number;
}): Promise<AniTask> {
  const url = `${opts.serverUrl}/api/v1/tasks/${opts.taskId}`;
  const body: Record<string, unknown> = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.assignee_id !== undefined) body.assignee_id = opts.assignee_id;
  if (opts.status !== undefined) body.status = opts.status;
  if (opts.priority !== undefined) body.priority = opts.priority;
  if (opts.due_date !== undefined) body.due_date = opts.due_date;
  if (opts.sort_order !== undefined) body.sort_order = opts.sort_order;

  const res = await fetchWithRetry(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`ANI update task failed (${res.status}): ${bodyText}`);
  }
  const json = (await res.json()) as { data?: AniTask };
  if (!json.data) {
    throw new Error("ANI update task failed: missing task payload");
  }
  return json.data;
}

export async function deleteAniTask(opts: {
  serverUrl: string;
  apiKey: string;
  taskId: number;
}): Promise<void> {
  const url = `${opts.serverUrl}/api/v1/tasks/${opts.taskId}`;
  const res = await fetchWithRetry(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI delete task failed (${res.status}): ${body}`);
  }
}

/** Verify the API key works and return entity info. */
export async function verifyAniConnection(opts: {
  serverUrl: string;
  apiKey: string;
}): Promise<{ entityId: number; name: string; entityType: string }> {
  const url = `${opts.serverUrl}/api/v1/me`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI /me failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as {
    data?: { id?: number; display_name?: string; entity_type?: string };
    id?: number;
    display_name?: string;
    entity_type?: string;
  };
  // ANI wraps response in { data: { ... }, ok: true }
  const entity = json.data ?? json;
  const entityId = entity.id ?? 0;
  if (!entityId) {
    throw new Error("ANI /me returned no entity ID — check API key validity");
  }
  return {
    entityId,
    name: entity.display_name ?? "unknown",
    entityType: entity.entity_type ?? "bot",
  };
}

/**
 * Send a transient progress event via POST /conversations/:id/progress.
 * This is NOT persisted to the database — broadcast to WebSocket clients only.
 */
export async function sendAniProgress(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  streamId: string;
  status: { phase: string; progress: number; text: string };
}): Promise<void> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/progress`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        stream_id: opts.streamId,
        status: opts.status,
      }),
      signal: AbortSignal.timeout(10_000),
    },
    2, // fire-and-forget: less aggressive retry
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI progress failed (${res.status}): ${body}`);
  }
}

/**
 * Send a typing indicator via POST /conversations/:id/typing.
 * This is NOT persisted — broadcast to WebSocket clients only.
 * Fire-and-forget: errors are silently ignored.
 */
export async function sendAniTyping(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  isProcessing?: boolean;
  phase?: string;
}): Promise<void> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/typing`;
  const body: Record<string, unknown> = {};
  if (opts.isProcessing) {
    body.is_processing = true;
    if (opts.phase) body.phase = opts.phase;
  }
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
    2, // fire-and-forget: less aggressive retry
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ANI typing failed (${res.status}): ${text}`);
  }
}

/** Toggle an emoji reaction on a message. POST /messages/:id/reactions */
export async function toggleAniReaction(opts: {
  serverUrl: string;
  apiKey: string;
  messageId: number;
  emoji: string;
}): Promise<void> {
  const url = `${opts.serverUrl}/api/v1/messages/${opts.messageId}/reactions`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ emoji: opts.emoji }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI reaction failed (${res.status}): ${body}`);
  }
}
