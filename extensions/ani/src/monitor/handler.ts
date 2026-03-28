import { randomBytes } from "node:crypto";
import type { CoreConfig } from "../types.js";
import { createReplyPrefixContext, createTypingCallbacks, type RuntimeEnv } from "../sdk-compat.js";
import { createInboundDebouncer } from "./debounce.js";
import {
  sendAniMessage,
  sendAniProgress,
  fetchConversation,
  fetchConversationMemories,
  toggleAniReaction,
  type AniArtifact,
  type AniConversation,
  type AniMemory,
} from "./send.js";

export type AniWsMessage = {
  type?: string;
  // ANI wraps payload in `data`
  data?: {
    id?: number;
    conversation_id?: number;
    sender_id?: number;
    sender_type?: string;
    layers?: {
      summary?: string;
      detail?: string;
      data?: unknown;
    };
    created_at?: string;
    // sender entity info (enriched by ANI server)
    sender?: {
      id?: number;
      display_name?: string;
      entity_type?: string;
    };
    // Mentions: entity IDs mentioned in this message
    mentions?: number[];
    // Interaction layer (approval/selection cards)
    // conversation info
    conversation?: {
      id?: number;
      title?: string;
      conv_type?: string;
    };
    attachments?: Array<{
      type?: string;
      url?: string;
      filename?: string;
      mime_type?: string;
      size?: number;
      duration?: number;
      content?: string;
    }>;
  };
};

export type AniHandlerParams = {
  core: ReturnType<typeof import("../runtime.js").getAniRuntime>;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  logger: {
    info: (message: string | Record<string, unknown>, ...meta: unknown[]) => void;
    warn: (meta: Record<string, unknown>, message: string) => void;
  };
  logVerbose: (message: string) => void;
  serverUrl: string;
  apiKey: string;
  selfEntityId: number;
  selfName: string;
  accountId: string;
};

// ---------------------------------------------------------------------------
// Artifact support: system prompt injection + outbound parsing
// ---------------------------------------------------------------------------

const ANI_ARTIFACT_SYSTEM_PROMPT = `
## Artifact Output

When you need to produce rich visual or structured content (SVG graphics, HTML pages, diagrams, or substantial code blocks), wrap the output in an <artifact> tag so it can be rendered interactively in the chat UI.

Format:
<artifact type="TYPE" title="TITLE" language="LANG">
CONTENT
</artifact>

Supported types:
- html  — HTML/SVG content (including inline CSS/JS). Use this for charts, diagrams drawn as SVG, interactive widgets.
- code  — Source code. Set language="python" (or js, go, sql, etc.) for syntax highlighting.
- mermaid — Mermaid diagram markup (flowchart, sequence, gantt, etc.).

Rules:
- Only use <artifact> for content that benefits from rendering (SVG, HTML, mermaid, long code). Short inline code snippets should stay as normal markdown.
- Always provide a descriptive title.
- For SVG, output the full <svg> element inside type="html". Use viewBox (not fixed width/height) so it scales responsively. Ensure all text labels and data values are fully visible with no overlap — add enough vertical spacing between rows (min 40px per row for bar charts).
- You may include a brief text explanation before or after the artifact tag.
- Do NOT nest artifact tags.
`.trim();

/**
 * Parse <artifact> tags from model reply text.
 * Returns an array of { before, artifact, after } segments.
 */
export function parseArtifacts(text: string): Array<{
  textBefore: string;
  artifact?: AniArtifact;
  raw?: string;
}> {
  const TAG_RE =
    /<artifact\s+type="(?<type>[^"]+)"(?:\s+title="(?<title>[^"]*)")?(?:\s+language="(?<lang>[^"]*)")?\s*>\n?(?<source>[\s\S]*?)\n?<\/artifact>/g;

  const segments: Array<{ textBefore: string; artifact?: AniArtifact; raw?: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(TAG_RE)) {
    const before = text.slice(lastIndex, match.index);
    const artType = match.groups?.type ?? "html";
    const mappedType: AniArtifact["artifact_type"] =
      artType === "mermaid"
        ? "mermaid"
        : artType === "code"
          ? "code"
          : artType === "image"
            ? "image"
            : "html";

    segments.push({
      textBefore: before,
      artifact: {
        artifact_type: mappedType,
        source: match.groups?.source ?? "",
        title: match.groups?.title || undefined,
        language: match.groups?.lang || undefined,
      },
      raw: match[0],
    });
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  // Remaining text after last artifact (or entire text if no artifacts found)
  const trailing = text.slice(lastIndex);
  if (trailing.trim() || segments.length === 0) {
    segments.push({ textBefore: trailing });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Attachment processing: download text files inline, describe others
// ---------------------------------------------------------------------------

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/yaml"];
const TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".py",
  ".js",
  ".ts",
  ".go",
  ".rs",
  ".sql",
];
const MAX_TEXT_FILE_SIZE = 102400; // 100KB

export function isTextFile(mimeType?: string, filename?: string): boolean {
  if (mimeType && TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return true;
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    return TEXT_EXTENSIONS.includes(ext);
  }
  return false;
}

function formatFileSize(bytes?: number): string {
  if (bytes == null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Classify a MIME type into a human-readable category. */
function classifyMime(mimeType?: string): { category: string; label: string } {
  if (!mimeType) return { category: "file", label: "unknown type" };
  if (mimeType.startsWith("image/")) {
    const fmt = mimeType.replace("image/", "").toUpperCase();
    return { category: "image", label: `${fmt} image` };
  }
  if (mimeType.startsWith("audio/")) {
    const fmt = mimeType.replace("audio/", "").toUpperCase();
    return { category: "audio", label: `${fmt} audio` };
  }
  if (mimeType.startsWith("video/")) {
    const fmt = mimeType.replace("video/", "").toUpperCase();
    return { category: "video", label: `${fmt} video` };
  }
  if (mimeType === "application/pdf") return { category: "document", label: "PDF document" };
  if (mimeType.includes("word") || mimeType.includes("document"))
    return { category: "document", label: "Word document" };
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet"))
    return { category: "document", label: "Excel spreadsheet" };
  if (mimeType.includes("powerpoint") || mimeType.includes("presentation"))
    return { category: "document", label: "PowerPoint presentation" };
  if (mimeType === "application/zip") return { category: "archive", label: "ZIP archive" };
  if (mimeType.includes("tar") || mimeType.includes("gzip"))
    return { category: "archive", label: "compressed archive" };
  return { category: "file", label: mimeType };
}

/** Format an attachment description for the model without exposing protected download URLs. */
function formatAttachmentDescription(
  filename: string,
  mimeType: string | undefined,
  size: number | undefined,
  requiresAuthAccess: boolean,
  duration?: number,
): string {
  const { category, label } = classifyMime(mimeType);
  const sizeStr = formatFileSize(size);
  const durationStr = duration ? `, ${duration}s` : "";
  const accessStr = requiresAuthAccess
    ? " — available via authenticated ANI attachment access"
    : "";

  switch (category) {
    case "image":
      return `[Image attached: ${filename} (${label}, ${sizeStr})${accessStr}]`;
    case "document":
      return `[Document attached: ${filename} (${label}, ${sizeStr})${accessStr}]`;
    case "audio":
      return `[Audio attached: ${filename} (${label}${durationStr}, ${sizeStr})${accessStr}]`;
    case "video":
      return `[Video attached: ${filename} (${label}${durationStr}, ${sizeStr})${accessStr}]`;
    case "archive":
      return `[Archive attached: ${filename} (${label}, ${sizeStr})${accessStr}]`;
    default:
      return `[File attached: ${filename} (${label}, ${sizeStr})${accessStr}]`;
  }
}

async function processAttachments(
  attachments: NonNullable<NonNullable<AniWsMessage["data"]>["attachments"]>,
  serverUrl: string,
  apiKey: string,
): Promise<string> {
  const parts: string[] = [];

  for (const att of attachments) {
    const filename = att.filename || "unknown";
    const url = att.url;

    if (!url) {
      parts.push(
        formatAttachmentDescription(filename, att.mime_type, att.size, false, att.duration),
      );
      continue;
    }

    // Build full URL (ANI uses relative paths like /files/...)
    const fullUrl = url.startsWith("http") ? url : `${serverUrl}${url}`;

    // For text files small enough, download and inline the content
    if (isTextFile(att.mime_type, att.filename) && (att.size ?? 0) <= MAX_TEXT_FILE_SIZE) {
      try {
        const res = await fetch(fullUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          // Validate actual response size before reading body to prevent DoS
          const contentLength = Number(res.headers.get("content-length") ?? "0");
          if (contentLength > MAX_TEXT_FILE_SIZE) {
            parts.push(
              formatAttachmentDescription(
                filename,
                att.mime_type,
                contentLength,
                true,
                att.duration,
              ),
            );
          } else {
            const content = await res.text();
            if (content.length > MAX_TEXT_FILE_SIZE) {
              // Actual body exceeded limit despite header; fall back to description
              parts.push(
                formatAttachmentDescription(
                  filename,
                  att.mime_type,
                  content.length,
                  true,
                  att.duration,
                ),
              );
            } else {
              parts.push(`--- Attached file: ${filename} ---\n${content}\n--- End of file ---`);
            }
          }
        } else {
          parts.push(
            formatAttachmentDescription(filename, att.mime_type, att.size, true, att.duration),
          );
        }
      } catch {
        parts.push(
          formatAttachmentDescription(filename, att.mime_type, att.size, true, att.duration),
        );
      }
    } else {
      // Non-text or large files: describe them, but do not leak protected download URLs
      parts.push(
        formatAttachmentDescription(filename, att.mime_type, att.size, true, att.duration),
      );
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Media download: save attachments to disk for OpenClaw media pipeline
// ---------------------------------------------------------------------------

type SavedAttachment = { path: string; contentType?: string };

/**
 * Download ANI attachments and save them to OpenClaw's media directory.
 * This enables the media-understanding pipeline (vision, audio transcription, etc.)
 * which requires local file paths via MediaPath/MediaPaths context fields.
 */
async function downloadAndSaveAttachments(
  attachments: NonNullable<NonNullable<AniWsMessage["data"]>["attachments"]>,
  serverUrl: string,
  apiKey: string,
  saveFn: (
    buffer: Buffer,
    contentType?: string,
    subdir?: string,
    maxBytes?: number,
    originalFilename?: string,
  ) => Promise<{ path: string; contentType?: string }>,
  logVerbose: (msg: string) => void,
): Promise<SavedAttachment[]> {
  const saved: SavedAttachment[] = [];

  for (const att of attachments) {
    const url = att.url;
    if (!url) continue;

    const fullUrl = url.startsWith("http") ? url : `${serverUrl}${url}`;
    try {
      const res = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        logVerbose(`ani: media download failed (${res.status}) for ${att.filename ?? url}`);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = att.mime_type ?? res.headers.get("content-type") ?? undefined;

      const result = await saveFn(
        buffer,
        contentType,
        "inbound",
        10 * 1024 * 1024, // 10MB limit for save
        att.filename ?? undefined,
      );

      saved.push({ path: result.path, contentType: result.contentType });
      logVerbose(
        `ani: saved media ${att.filename ?? "file"} → ${result.path} (${result.contentType})`,
      );
    } catch (err) {
      logVerbose(`ani: media save failed for ${att.filename ?? url}: ${String(err)}`);
    }
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/** Generate a short random stream ID. */
function generateStreamId(): string {
  return `stream-${randomBytes(6).toString("hex")}`;
}

/**
 * Creates a handler function for incoming ANI WebSocket messages.
 * Only handles `message_new` events, routes them through the OpenClaw
 * AI agent pipeline, and delivers replies via ANI REST API.
 *
 * Phase 2: Replies are streamed incrementally. On the first chunk a
 * stream_start message is sent with a generated stream_id. Subsequent
 * chunks become stream_delta messages with progress status layers.
 * The final flush sends a stream_end message (persisted by the backend).
 * Artifacts are still buffered and sent only in the final flush.
 */
export function createAniMessageHandler(params: AniHandlerParams) {
  const {
    core,
    cfg,
    runtime,
    logger,
    logVerbose,
    serverUrl,
    apiKey,
    selfEntityId,
    selfName,
    accountId,
  } = params;

  const startupMs = Date.now();

  // ---------------------------------------------------------------------------
  // Inbound debouncing: coalesce rapid messages from the same sender
  // ---------------------------------------------------------------------------
  const debouncer = createInboundDebouncer(1500);

  // ---------------------------------------------------------------------------
  // Concurrency limiting: max parallel AI dispatches per conversation
  // ---------------------------------------------------------------------------
  const MAX_CONCURRENT = 2;
  const concurrencyMap = new Map<number, number>();
  const concurrencyQueue = new Map<number, Array<() => void>>();

  function acquireSlot(convId: number): boolean {
    const current = concurrencyMap.get(convId) || 0;
    if (current >= MAX_CONCURRENT) return false;
    concurrencyMap.set(convId, current + 1);
    return true;
  }

  function releaseSlot(convId: number) {
    const current = concurrencyMap.get(convId) || 0;
    if (current <= 1) concurrencyMap.delete(convId);
    else concurrencyMap.set(convId, current - 1);

    // Process queued dispatch if any
    const queue = concurrencyQueue.get(convId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) concurrencyQueue.delete(convId);
      next();
    }
  }

  function enqueueOrRun(convId: number, fn: () => Promise<void>): void {
    if (acquireSlot(convId)) {
      fn().finally(() => releaseSlot(convId));
    } else {
      logVerbose(`ani: concurrency limit reached for conv=${convId}, queueing dispatch`);
      const queue = concurrencyQueue.get(convId) ?? [];
      queue.push(() => {
        acquireSlot(convId);
        fn().finally(() => releaseSlot(convId));
      });
      concurrencyQueue.set(convId, queue);
    }
  }

  // ---------------------------------------------------------------------------
  // Revocation tracking: when a user revokes a message that triggered agent
  // processing, we flag the stream so the deliver callback skips remaining blocks.
  // ---------------------------------------------------------------------------

  /** Maps trigger messageId → streamId assigned during processing. */
  const messageToStreamMap = new Map<string, string>();

  /** Set of trigger messageIds whose source messages have been revoked. */
  const revokedMessages = new Set<string>();

  // ---------------------------------------------------------------------------
  // Stream cancellation: AbortController per active stream. When the user sends
  // a task.cancel event, we abort the controller so the deliver callback skips
  // remaining chunks and the dispatch is interrupted as quickly as possible.
  // ---------------------------------------------------------------------------

  /** Maps streamId → AbortController for in-progress dispatches. */
  const activeStreams = new Map<string, { controller: AbortController; conversationId: number }>();

  // Cache conversation metadata (refreshed every 5 minutes)
  const convCache = new Map<
    number,
    { conv: AniConversation; memories: AniMemory[]; fetchedAt: number }
  >();
  const CACHE_TTL = 5 * 60 * 1000;
  const CACHE_MAX_SIZE = 100;

  async function getConversationContext(conversationId: number): Promise<{
    conv: AniConversation | null;
    memories: AniMemory[];
  }> {
    const cached = convCache.get(conversationId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return { conv: cached.conv, memories: cached.memories };
    }
    const [conv, memories] = await Promise.all([
      fetchConversation({ serverUrl, apiKey, conversationId }),
      fetchConversationMemories({ serverUrl, apiKey, conversationId }),
    ]);
    if (conv) {
      // Evict oldest entry if cache is at capacity
      if (convCache.size >= CACHE_MAX_SIZE && !convCache.has(conversationId)) {
        let oldestKey: number | undefined;
        let oldestTime = Infinity;
        for (const [key, entry] of convCache) {
          if (entry.fetchedAt < oldestTime) {
            oldestTime = entry.fetchedAt;
            oldestKey = key;
          }
        }
        if (oldestKey !== undefined) convCache.delete(oldestKey);
      }
      convCache.set(conversationId, { conv, memories, fetchedAt: Date.now() });
    }
    return { conv, memories };
  }

  function buildConversationSystemPrompt(
    conv: AniConversation | null,
    memories: AniMemory[],
    conversationId: number,
  ): string {
    const parts: string[] = [];

    // Identity
    parts.push(`You are ${selfName}.`);

    // Current conversation context
    const convType = conv?.conv_type ?? "group";
    parts.push(`## Current Conversation\n\nConversation ID: ${conversationId}\nType: ${convType}`);

    // Conversation instructions (set by owner)
    if (conv?.prompt?.trim()) {
      parts.push(`## Instructions\n\n${conv.prompt.trim()}`);
    }

    // Conversation description
    if (conv?.description?.trim()) {
      parts.push(`## Conversation Description\n\n${conv.description.trim()}`);
    }

    // Participants (with entity_id for cross-bot mention/collaboration)
    if (conv?.participants && conv.participants.length > 0) {
      const memberLines = conv.participants.map((p) => {
        const name = p.entity?.display_name ?? `entity-${p.entity_id}`;
        const type = p.entity?.entity_type ?? "unknown";
        const role = p.role ?? "member";
        return `- ${name} (${type}, ${role}, id=${p.entity_id})`;
      });
      parts.push(`## Participants\n\n${memberLines.join("\n")}`);
    }

    // Multi-bot group behavior: teach the agent when to stay silent
    if (
      conv?.participants &&
      conv.participants.filter((p) => p.entity?.entity_type === "bot").length > 1
    ) {
      parts.push(
        [
          "## Group Behavior",
          "",
          "This is a multi-bot group. Follow these rules strictly:",
          "",
          "**When to respond:**",
          "- A human @mentions you by name with a direct task for you → respond.",
          "- Another bot @mentions you (task handoff) → respond.",
          "",
          "**When to stay silent (reply with exactly [SILENT]):**",
          "- The message @mentions another bot but NOT you → [SILENT].",
          "- Another bot posted a message and did NOT @mention you → [SILENT].",
          "- The message assigns tasks to multiple bots sequentially (e.g. 'Bot_A do X, then Bot_B do Y') and your task depends on another bot finishing first → [SILENT]. Wait for that bot to @mention you with results.",
          "",
          "**How to @mention (IMPORTANT — avoid loops):**",
          "- ONLY use @TheirName when you need them to take action (task handoff).",
          "- If you are just replying, confirming, or acknowledging — write their name WITHOUT the @ prefix.",
          "  Example: '胖胖虾 的结果已收到，任务完成。' (no @, no notification)",
          "  Example: '@小龙虾 请处理这个数据' (with @, triggers notification)",
          "- NEVER @mention a bot just to say 'received' or 'done' — this causes infinite reply loops.",
          "",
          "[SILENT] means you choose not to speak. The system will suppress the message entirely.",
        ].join("\n"),
      );
    }

    // Memories
    if (memories.length > 0) {
      const memLines = memories.map((m) => `- **${m.key}**: ${m.content}`);
      parts.push(`## Conversation Memory\n\n${memLines.join("\n")}`);
    }

    // Artifact support instructions
    parts.push(ANI_ARTIFACT_SYSTEM_PROMPT);

    // Tool awareness: tell the agent about available ANI tools
    parts.push(
      [
        "## Available Tools",
        "",
        "- **ani_fetch_chat_history_messages**: Retrieve full conversation history from the ANI platform. Use when users reference earlier messages, files, or context — especially messages you were not @mentioned in. Default 5 messages, max 50.",
        "- **ani_send_file**: Create and send a file to this conversation (text content or disk file).",
        "- **ani_list_conversation_tasks**: List the current roadmap/tasks for this conversation, optionally filtered by status.",
        "- **ani_get_task**: Fetch the details of a single task by task ID.",
        "- **ani_create_task**: Create a new conversation task when the user asks you to add work items.",
        "- **ani_update_task**: Update task status, assignee, priority, title, description, due date, or sort order.",
        "- **ani_delete_task**: Delete a task when explicitly requested and allowed by ANI permissions.",
      ].join("\n"),
    );

    return parts.join("\n\n");
  }

  /**
   * Build a lighter system prompt for direct (1:1) conversations.
   * Skips participant list and group description since there are only two entities.
   */
  function buildDirectSystemPrompt(
    conv: AniConversation | null,
    memories: AniMemory[],
    conversationId: number,
  ): string {
    const parts: string[] = [];

    parts.push(`You are ${selfName}.`);

    // Current conversation context
    parts.push(`## Current Conversation\n\nConversation ID: ${conversationId}\nType: direct`);

    if (conv?.prompt?.trim()) {
      parts.push(`## Instructions\n\n${conv.prompt.trim()}`);
    }

    if (memories.length > 0) {
      const memLines = memories.map((m) => `- **${m.key}**: ${m.content}`);
      parts.push(`## Conversation Memory\n\n${memLines.join("\n")}`);
    }

    parts.push(ANI_ARTIFACT_SYSTEM_PROMPT);

    parts.push(
      [
        "## Available Tools",
        "",
        "- **ani_fetch_chat_history_messages**: Retrieve full conversation history from the ANI platform. Use when users reference earlier messages, files, or context you don't have. Default 5 messages, max 50.",
        "- **ani_send_file**: Create and send a file to this conversation (text content or disk file).",
        "- **ani_list_conversation_tasks**: List the current roadmap/tasks for this conversation, optionally filtered by status.",
        "- **ani_get_task**: Fetch the details of a single task by task ID.",
        "- **ani_create_task**: Create a new conversation task when the user asks you to add work items.",
        "- **ani_update_task**: Update task status, assignee, priority, title, description, due date, or sort order.",
        "- **ani_delete_task**: Delete a task when explicitly requested and allowed by ANI permissions.",
      ].join("\n"),
    );

    return parts.join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // Core dispatch logic (called after debounce window or immediately for attachments)
  // ---------------------------------------------------------------------------

  type DispatchParams = {
    combinedText: string;
    messageIds: string[];
    conversationId: number;
    senderId: number;
    senderName: string;
    senderType: string;
    attachments: NonNullable<NonNullable<AniWsMessage["data"]>["attachments"]>;
    attachmentText: string;
    savedMedia: SavedAttachment[];
    msg: NonNullable<AniWsMessage["data"]>;
  };

  async function dispatchToAgent(params: DispatchParams): Promise<void> {
    const {
      combinedText: text,
      messageIds,
      conversationId,
      senderId,
      senderName,
      senderType,
      attachments,
      attachmentText,
      savedMedia,
      msg,
    } = params;
    const messageId = messageIds[0] ?? "";

    return new Promise<void>((resolve, reject) => {
      enqueueOrRun(conversationId, async () => {
        let streamId: string | undefined;
        try {
          // Fetch conversation context (cached, refreshed every 5 min)
          const { conv: convContext, memories } = await getConversationContext(conversationId);
          const conversationTitle =
            convContext?.title ?? msg.conversation?.title ?? `conv-${conversationId}`;

          const convType = convContext?.conv_type ?? msg.conversation?.conv_type ?? "group";
          const isDirect = convType === "direct";

          const groupSystemPrompt = isDirect
            ? buildDirectSystemPrompt(convContext, memories, conversationId)
            : buildConversationSystemPrompt(convContext, memories, conversationId);

          logger.info(
            `ani: inbound conv=${conversationId} type=${convType} from=${senderName}(${senderId}) attachments=${attachments.length} hasText=${Boolean(text.trim())} msgIds=${messageIds.length}`,
          );

          // Route through OpenClaw agent pipeline
          const peerKind = isDirect ? "dm" : "channel";
          const route = core.channel.routing.resolveAgentRoute({
            cfg,
            channel: "ani",
            peer: {
              kind: peerKind,
              id: String(conversationId),
            },
          });

          const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });

          const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const previousTimestamp = core.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey: route.sessionKey,
          });

          const rawBody = attachmentText ? `${text}\n\n${attachmentText}` : text;
          logVerbose(
            `ani: rawBody for envelope (${rawBody.length} chars): ${rawBody.slice(0, 500)}`,
          );

          const body = core.channel.reply.formatAgentEnvelope({
            channel: "ANI",
            from: senderName,
            timestamp: msg.created_at ? new Date(msg.created_at).getTime() : undefined,
            previousTimestamp,
            envelope: envelopeOptions,
            body: rawBody,
          });
          logVerbose(`ani: formatted body (${body.length} chars): ${body.slice(0, 500)}`);

          const mediaPaths = savedMedia.map((m) => m.path);
          const mediaTypes = savedMedia.map((m) => m.contentType ?? "application/octet-stream");

          const chatType = isDirect ? ("direct" as const) : ("channel" as const);
          const ctxPayload = core.channel.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: rawBody,
            RawBody: text,
            CommandBody: text,
            From: isDirect ? `ani:dm:${senderId}` : `ani:channel:${conversationId}`,
            To: `ani:conv:${conversationId}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: chatType,
            ConversationLabel: senderName,
            SenderName: senderName,
            SenderId: String(senderId),
            ...(mediaPaths.length > 0
              ? {
                  MediaPath: mediaPaths[0],
                  MediaPaths: mediaPaths,
                  MediaType: mediaTypes[0],
                  MediaTypes: mediaTypes,
                }
              : {}),
            ...(isDirect
              ? {}
              : {
                  GroupSubject: conversationTitle,
                  GroupChannel: String(conversationId),
                }),
            GroupSystemPrompt: groupSystemPrompt,
            Provider: "ani" as const,
            Surface: "ani" as const,
            MessageSid: messageId,
            Timestamp: msg.created_at ? new Date(msg.created_at).getTime() : undefined,
            CommandAuthorized: true,
            CommandSource: "text" as const,
            OriginatingChannel: "ani" as const,
            OriginatingTo: `ani:conv:${conversationId}`,
          });

          await core.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err) => {
              logger.warn(
                {
                  error: String(err),
                  storePath,
                  sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
                },
                "failed updating session meta",
              );
            },
          });

          const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "ani");
          const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

          const typingCallbacks = createTypingCallbacks({
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
            onStartError: () => {},
            onStopError: () => {},
          });

          let didSendReply = false;

          const participantNameMap = new Map<string, number>();
          if (convContext?.participants) {
            for (const p of convContext.participants) {
              const name = p.entity?.display_name;
              if (name && p.entity_id !== selfEntityId) {
                participantNameMap.set(name, p.entity_id);
              }
            }
          }

          function extractMentionsFromText(text: string): number[] {
            const found: number[] = [];
            for (const [name, id] of participantNameMap) {
              if (text.includes(`@${name}`)) {
                found.push(id);
              }
            }
            return found;
          }

          streamId = generateStreamId();
          const replyBuffer: string[] = [];
          let totalChars = 0;

          for (const mid of messageIds) {
            if (mid) messageToStreamMap.set(mid, streamId);
          }

          const streamAbortController = new AbortController();
          activeStreams.set(streamId, { controller: streamAbortController, conversationId });

          const { dispatcher, replyOptions, markDispatchIdle } =
            core.channel.reply.createReplyDispatcherWithTyping({
              responsePrefix: prefixContext.responsePrefix,
              responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
              humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
              deliver: async (payload, info) => {
                if (messageIds.some((mid) => mid && revokedMessages.has(mid))) {
                  logVerbose(`ani: skipping reply block — trigger message was revoked`);
                  return;
                }

                if (streamAbortController.signal.aborted) {
                  logVerbose(`ani: skipping reply block — stream ${streamId} was cancelled`);
                  return;
                }

                const replyText = payload.text ?? "";
                if (!replyText.trim()) return;

                replyBuffer.push(replyText);
                totalChars += replyText.length;

                if (replyText.trim() === "[SILENT]" || replyText.trim().startsWith("[SILENT]")) {
                  logVerbose(`ani: agent chose [SILENT], suppressing block`);
                  return;
                }

                const autoMentions = extractMentionsFromText(replyText);
                const segments = parseArtifacts(replyText);
                const hasArtifacts = segments.some((s) => s.artifact);

                if (hasArtifacts) {
                  for (const seg of segments) {
                    try {
                      const plainText = seg.textBefore.trim();
                      if (plainText) {
                        const chunks = core.channel.text.chunkMarkdownText(plainText, textLimit);
                        for (const chunk of chunks.length > 0 ? chunks : [plainText]) {
                          const trimmed = chunk.trim();
                          if (!trimmed) continue;
                          await sendAniMessage({
                            serverUrl,
                            apiKey,
                            conversationId,
                            text: trimmed,
                            streamId,
                            mentions: autoMentions,
                          });
                        }
                      }
                      if (seg.artifact) {
                        await sendAniMessage({
                          serverUrl,
                          apiKey,
                          conversationId,
                          text: seg.artifact.title ?? "Artifact",
                          artifact: seg.artifact,
                          streamId,
                          mentions: autoMentions,
                        });
                      }
                    } catch (segErr) {
                      logger.warn(
                        { error: String(segErr), conversationId },
                        "ani: artifact segment send failed",
                      );
                    }
                  }
                } else {
                  const chunks = core.channel.text.chunkMarkdownText(replyText, textLimit);
                  for (const chunk of chunks.length > 0 ? chunks : [replyText]) {
                    const trimmed = chunk.trim();
                    if (!trimmed) continue;
                    await sendAniMessage({
                      serverUrl,
                      apiKey,
                      conversationId,
                      text: trimmed,
                      streamId,
                      mentions: autoMentions,
                    });
                  }
                }
                didSendReply = true;
                logVerbose(
                  `ani: sent block (${replyText.length} chars, kind=${info?.kind ?? "unknown"})`,
                );
              },
              onSkip: (_payload, info) => {
                if (info.reason !== "silent") {
                  logVerbose(`ani: skipped reply block (reason=${info.reason})`);
                }
              },
              onError: (err, info) => {
                runtime.error?.(`ani ${info.kind} reply failed: ${String(err)}`);
              },
              onReplyStart: typingCallbacks.onReplyStart,
              onIdle: typingCallbacks.onIdle,
            });

          const { queuedFinal } = await core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {
              ...replyOptions,
              onModelSelected: prefixContext.onModelSelected,
            },
          });
          markDispatchIdle();

          if (queuedFinal) didSendReply = true;

          if (didSendReply) {
            const preview = text.replace(/\s+/g, " ").slice(0, 160);
            core.system.enqueueSystemEvent(`ANI message from ${senderName}: ${preview}`, {
              sessionKey: route.sessionKey,
              contextKey: `ani:message:${conversationId}:${messageId}`,
            });
            logVerbose(
              `ani: delivered reply to conv=${conversationId} streamId=${streamId} chunks=${replyBuffer.length}`,
            );
          }

          if (!didSendReply && !queuedFinal) {
            await sendAniMessage({
              serverUrl,
              apiKey,
              conversationId,
              text: "No response generated. Please try again.",
              streamId,
            });
          }

          for (const mid of messageIds) {
            if (mid) {
              messageToStreamMap.delete(mid);
              revokedMessages.delete(mid);
            }
          }
          activeStreams.delete(streamId);
          resolve();
        } catch (err) {
          if (streamId) {
            activeStreams.delete(streamId);
            for (const mid of messageIds) {
              if (mid) {
                messageToStreamMap.delete(mid);
                revokedMessages.delete(mid);
              }
            }
          }
          runtime.error?.(`ani dispatch error: ${String(err)}`);
          reject(err);
        }
      });
    });
  }

  const handler = async (wsMsg: AniWsMessage) => {
    try {
      // Handle message revocation: flag the trigger so deliver callback skips remaining blocks
      if (wsMsg.type === "message.revoked") {
        const revokedId = String(wsMsg.data?.id ?? "");
        const conversationId = wsMsg.data?.conversation_id;
        if (revokedId) {
          revokedMessages.add(revokedId);
          logVerbose(`ani: message ${revokedId} revoked in conv=${conversationId ?? "?"}`);

          // Notify the agent session about the revocation
          const streamId = messageToStreamMap.get(revokedId);
          core.system.enqueueSystemEvent(
            `User revoked message ${revokedId} in conversation ${conversationId ?? "unknown"}`,
            {
              contextKey: `ani:revoked:${conversationId ?? 0}:${revokedId}`,
              ...(streamId ? { sessionKey: streamId } : {}),
            },
          );
        }
        return;
      }

      // Handle task cancellation: abort the in-progress dispatch for the given stream
      if (wsMsg.type === "task.cancel" || wsMsg.type === "stream.cancel") {
        const cancelStreamId = (wsMsg.data as Record<string, unknown> | undefined)?.stream_id as
          | string
          | undefined;
        if (cancelStreamId) {
          const entry = activeStreams.get(cancelStreamId);
          if (entry) {
            logger.info(
              `ani: stream cancelled by user, streamId=${cancelStreamId} conv=${entry.conversationId}`,
            );
            entry.controller.abort();
            activeStreams.delete(cancelStreamId);

            // Send a cancellation progress event so the frontend knows the stream stopped
            sendAniProgress({
              serverUrl,
              apiKey,
              conversationId: entry.conversationId,
              streamId: cancelStreamId,
              status: { phase: "cancelled", progress: 100, text: "Stopped by user" },
            }).catch((err) => {
              logVerbose(`ani: cancel progress send failed: ${String(err)}`);
            });
          } else {
            logVerbose(`ani: task.cancel for unknown streamId=${cancelStreamId}`);
          }
        }
        return;
      }

      // Only handle new messages (ANI uses "message.new" with dot)
      if (wsMsg.type !== "message.new") {
        logVerbose(`ani: ignoring ws event type=${wsMsg.type ?? "unknown"}`);
        return;
      }

      let msg = wsMsg.data;
      if (!msg) return;

      // Handle enriched WS format (mention_with_context): { message, context_messages }
      if (!msg.layers && (msg as any).message) {
        msg = (msg as any).message;
      }

      // Skip own messages
      if (msg.sender_id === selfEntityId) return;

      const conversationId = msg.conversation_id;
      if (!conversationId) return;

      // Prefer data.body (full content) over summary (may be truncated by frontend)
      const dataBody =
        typeof msg.layers?.data === "object" && msg.layers?.data !== null
          ? (msg.layers.data as Record<string, unknown>).body
          : undefined;
      const text =
        (typeof dataBody === "string" ? dataBody : null) ??
        msg.layers?.summary ??
        msg.layers?.detail ??
        "";

      // Process attachments:
      // 1. Download and save to disk for OpenClaw media pipeline (MediaPath/MediaType)
      // 2. Also produce text descriptions for context (attachmentText)
      const attachments = msg.attachments ?? [];
      logVerbose(
        `ani: attachments count=${attachments.length} raw=${JSON.stringify(attachments).slice(0, 500)}`,
      );
      let attachmentText = "";
      let savedMedia: SavedAttachment[] = [];
      if (attachments.length > 0) {
        // Save files to disk for media-understanding pipeline (vision, audio, etc.)
        savedMedia = await downloadAndSaveAttachments(
          attachments,
          serverUrl,
          apiKey,
          core.media.saveMediaBuffer,
          logVerbose,
        );
        // Also generate text descriptions as supplementary context
        attachmentText = await processAttachments(attachments, serverUrl, apiKey);
        logVerbose(
          `ani: attachmentText (${attachmentText.length} chars) savedMedia=${savedMedia.length}: ${attachmentText.slice(0, 300)}`,
        );
      }

      if (!text.trim() && attachments.length === 0) return;

      const senderId = msg.sender_id ?? 0;
      const senderName = msg.sender?.display_name ?? `entity-${senderId}`;
      const senderType = msg.sender?.entity_type ?? msg.sender_type ?? "unknown";
      const messageId = String(msg.id ?? "");

      // Send ack-reaction if configured (confirms message receipt).
      const ackEmoji = cfg.messages?.ackReaction?.trim();
      if (ackEmoji && msg.id) {
        toggleAniReaction({ serverUrl, apiKey, messageId: msg.id, emoji: ackEmoji }).catch(
          (err) => {
            logVerbose(`ani: ack-reaction failed for msg=${msg.id}: ${String(err)}`);
          },
        );
      }

      // Debounce text-only messages from the same sender in the same conversation.
      // Messages with attachments bypass debouncing since they need immediate processing.
      const hasAttachments = attachments.length > 0;
      if (!hasAttachments && text.trim()) {
        const debounceKey = `${conversationId}:${senderId}`;
        debouncer.debounce(debounceKey, text, messageId, (combinedText, messageIds) => {
          logVerbose(
            `ani: debounce fired for ${debounceKey}, ${messageIds.length} message(s) coalesced`,
          );
          dispatchToAgent({
            combinedText,
            messageIds,
            conversationId,
            senderId,
            senderName,
            senderType,
            attachments: [],
            attachmentText: "",
            savedMedia: [],
            msg,
          }).catch((err) => {
            runtime.error?.(`ani debounced handler error: ${String(err)}`);
          });
        });
        return;
      }

      // Messages with attachments: dispatch immediately (no debouncing)
      await dispatchToAgent({
        combinedText: text,
        messageIds: [messageId],
        conversationId,
        senderId,
        senderName,
        senderType,
        attachments,
        attachmentText,
        savedMedia,
        msg,
      });
    } catch (err) {
      runtime.error?.(`ani handler error: ${String(err)}`);
    }
  };

  return handler;
}
