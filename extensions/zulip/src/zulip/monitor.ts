import * as child_process from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  ChannelAccountSnapshot,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveChannelMediaMaxBytes,
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import {
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingsEnabled,
} from "../../../../src/channels/thread-bindings-policy.js";
import { resolveReplyFormattingMode } from "../../../../src/lionroot/config/reply-formatting.js";
import { formatReplyForChannel } from "../../../../src/lionroot/infra/format-reply.js";
import { getZulipRuntime } from "../runtime.js";
import type { ZulipXCaseConfig } from "../types.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  fetchZulipMe,
  fetchZulipMessages,
  getZulipStreamId,
  registerZulipQueue,
  getZulipEvents,
  sendZulipStreamMessage,
  sendZulipTyping,
  addZulipReaction,
  removeZulipReaction,
  updateZulipMessage,
  normalizeZulipBaseUrl,
  type ZulipClient,
  type ZulipMessage,
  type ZulipSubmessageEvent,
} from "./client.js";
import {
  claimZulipComponentEntry,
  consumeZulipComponentMessageEntries,
  loadZulipComponentRegistry,
  removeZulipComponentEntry,
} from "./components-registry.js";
import { formatZulipComponentEventText, readZulipComponentSpec } from "./components.js";
import { createZulipDraftStream, type ZulipDraftTarget } from "./draft-stream.js";
import { ZulipExecApprovalHandler } from "./exec-approvals.js";
import { resolveZulipModelPickerCallbackAction } from "./model-picker.js";
import { logZulipResolutionSummary, resolveZulipUserInputs } from "./resolve-users.js";
import { sendZulipComponentMessage } from "./send-components.js";
import { sendMessageZulip } from "./send.js";
import {
  createZulipTopicBindingManager,
  resolveZulipTopicConversationId,
  resolveZulipTopicSessionBinding,
} from "./topic-bindings.js";

const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const ZULIP_CACHE_DIR = path.join(OPENCLAW_STATE_DIR, "cache", "zulip");
const ZULIP_UPLOAD_CACHE_DIR = path.join(ZULIP_CACHE_DIR, "uploads");

// Ensure cache directory exists
try {
  for (const dir of [ZULIP_CACHE_DIR, ZULIP_UPLOAD_CACHE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
} catch {
  // Ignore errors during module load
}

/**
 * Extract Zulip user_uploads URLs from message content.
 * Matches markdown links like [filename](/user_uploads/...)
 */
function extractZulipUploadUrls(content: string): Array<{ name: string; path: string }> {
  const matches: Array<{ name: string; path: string }> = [];
  // Match markdown links: [name](/user_uploads/...)
  const markdownRegex = /\[([^\]]+)\]\(\/user_uploads\/([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownRegex.exec(content)) !== null) {
    matches.push({ name: match[1], path: `/user_uploads/${match[2]}` });
  }
  // Also match bare URLs
  const bareRegex = /\/user_uploads\/[\w/.-]+/g;
  while ((match = bareRegex.exec(content)) !== null) {
    // Skip if already captured in markdown
    if (!matches.some((m) => m.path === match![0])) {
      const filename = match[0].split("/").pop() ?? "upload";
      matches.push({ name: filename, path: match[0] });
    }
  }
  return matches;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceUploadReferences(
  content: string,
  upload: { name: string; path: string },
  replacement: string,
): string {
  const markdownRef = new RegExp(
    `\\[${escapeRegex(upload.name)}\\]\\(${escapeRegex(upload.path)}\\)`,
    "g",
  );
  const bareRef = new RegExp(escapeRegex(upload.path), "g");
  return content.replace(markdownRef, replacement).replace(bareRef, replacement);
}

/**
 * Download a Zulip upload and return its bytes.
 */
type ZulipUploadDownloadResult = {
  buffer: Buffer | null;
  tooLarge: boolean;
  contentType?: string;
};

async function downloadZulipUpload(
  client: ZulipClient,
  uploadPath: string,
  maxBytes: number,
): Promise<ZulipUploadDownloadResult> {
  try {
    const url = `${client.baseUrl}${uploadPath}`;
    const res = await fetch(url, {
      headers: { Authorization: client.authHeader },
    });
    if (!res.ok) {
      console.error(`[zulip] Failed to download ${uploadPath}: ${res.status}`);
      return { buffer: null, tooLarge: false };
    }

    const contentLengthHeader = res.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { buffer: null, tooLarge: true };
    }

    let totalBytes = 0;
    const chunks: Buffer[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          return { buffer: null, tooLarge: true };
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxBytes) {
        return { buffer: null, tooLarge: true };
      }
      chunks.push(buffer);
    }
    const buffer = Buffer.concat(chunks);
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
    return { buffer, tooLarge: false, contentType };
  } catch (err) {
    console.error(`[zulip] Error downloading ${uploadPath}: ${String(err)}`);
    return { buffer: null, tooLarge: false };
  }
}

/** Extensions treated as readable text (content inlined into the prompt). */
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".bash",
  ".log",
  ".env",
  ".cfg",
  ".ini",
  ".conf",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".sql",
  ".swift",
]);

const MAX_INLINE_TEXT_BYTES = 100_000; // ~100 KB cap for inlined text

function isTextFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Process message content: download any Zulip uploads and return info about them.
 * Text files are read and inlined directly into the prompt.
 * Binary/image files get paths noted for tool-based access.
 */
export async function processZulipUploads(
  client: ZulipClient,
  content: string,
  maxBytes: number,
  saveMedia: (params: {
    buffer: Buffer;
    contentType: string | undefined;
    fileName: string;
  }) => Promise<{ path: string; contentType?: string } | null>,
): Promise<{
  attachmentInfo: string;
  strippedContent: string;
  mediaPaths: string[];
  mediaTypes: string[];
}> {
  const uploads = extractZulipUploadUrls(content);
  if (uploads.length === 0) {
    return { attachmentInfo: "", strippedContent: content, mediaPaths: [], mediaTypes: [] };
  }

  const attachmentLines: string[] = [];
  let strippedContent = content;
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];

  for (const upload of uploads) {
    const download = await downloadZulipUpload(client, upload.path, maxBytes);
    const downloaded = download.buffer;
    if (downloaded) {
      if (isTextFile(upload.name)) {
        if (downloaded.length <= MAX_INLINE_TEXT_BYTES) {
          try {
            const text = downloaded.toString("utf-8");
            attachmentLines.push(
              `📎 File "${upload.name}" (contents already included below; do not use tools to open it unless a filesystem path is explicitly provided):\n\`\`\`\n${text}\n\`\`\``,
            );
          } catch {
            attachmentLines.push(`📎 File "${upload.name}": ${downloaded.length} bytes`);
          }
        } else {
          const saved = await saveMedia({
            buffer: downloaded,
            contentType: download.contentType,
            fileName: upload.name,
          }).catch(() => null);
          if (saved) {
            mediaPaths.push(saved.path);
            if (saved.contentType) {
              mediaTypes.push(saved.contentType);
            }
            attachmentLines.push(
              `📎 File "${upload.name}" (${Math.round(downloaded.length / 1024)} KB — too large to inline; cached for model analysis at path: ${saved.path})`,
            );
          } else {
            attachmentLines.push(
              `📎 File "${upload.name}" (${Math.round(downloaded.length / 1024)} KB — too large to inline; failed to cache for model analysis)`,
            );
          }
        }
      } else {
        attachmentLines.push(`📎 Attachment "${upload.name}": prepared for model analysis`);
        const saved = await saveMedia({
          buffer: downloaded,
          contentType: download.contentType,
          fileName: upload.name,
        }).catch(() => null);
        if (saved) {
          mediaPaths.push(saved.path);
          if (saved.contentType) {
            mediaTypes.push(saved.contentType);
          }
        } else {
          attachmentLines.push(
            `📎 Attachment "${upload.name}": (downloaded but failed to cache for analysis)`,
          );
        }
      }

      strippedContent = replaceUploadReferences(
        strippedContent,
        upload,
        isTextFile(upload.name) && downloaded.length <= MAX_INLINE_TEXT_BYTES
          ? `[inline file contents already included below: ${upload.name}]`
          : `[attached: ${upload.name}]`,
      );
    } else {
      if (download.tooLarge) {
        attachmentLines.push(
          `📎 File "${upload.name}": (download skipped — exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit)`,
        );
        strippedContent = replaceUploadReferences(
          strippedContent,
          upload,
          `[attached: ${upload.name} — too large to download]`,
        );
      } else {
        attachmentLines.push(
          `📎 File "${upload.name}": (download failed — file could not be retrieved from Zulip)`,
        );
        strippedContent = replaceUploadReferences(
          strippedContent,
          upload,
          `[attached: ${upload.name} — download failed]`,
        );
      }
    }
  }

  return {
    attachmentInfo:
      attachmentLines.length > 0
        ? `\n[Attached files; inline text contents are already included here when available]\n${attachmentLines.join("\n")}`
        : "",
    strippedContent,
    mediaPaths,
    mediaTypes,
  };
}

export function buildZulipAgentBody(params: {
  cleanText: string;
  strippedContent: string;
  attachmentInfo: string;
  botMentionRegex: RegExp;
  messageId: number;
}): {
  cleanStripped: string;
  textWithAttachments: string;
  bodyForAgent: string;
} {
  const cleanStripped = params.strippedContent
    .replace(params.botMentionRegex, "")
    .replace(/\s+/g, " ")
    .trim();
  const textWithAttachments = params.attachmentInfo
    ? `${cleanStripped}${params.attachmentInfo}`
    : params.cleanText;
  return {
    cleanStripped,
    textWithAttachments,
    bodyForAgent: `${textWithAttachments}\n[zulip message id: ${params.messageId}]`,
  };
}

export type MonitorZulipOpts = {
  botEmail?: string;
  botApiKey?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

/** Map common Unicode emoji to Zulip emoji names for ack reactions. */
const EMOJI_TO_ZULIP_NAME: Record<string, string> = {
  "👀": "eyes",
  "👍": "thumbs_up",
  "✅": "check",
  "🤔": "thinking",
  "⏳": "hourglass",
  "🔄": "arrows_counterclockwise",
  "💬": "speech_balloon",
  "🧠": "brain",
  "⚡": "zap",
  "🦞": "lobster",
  "💻": "computer",
  "🎨": "art",
  "🎮": "video_game",
  "🎯": "dart",
  "📈": "chart_with_upwards_trend",
  "🌱": "seedling",
  "🪺": "nesting_dolls",
};

function emojiToZulipName(emoji: string): string {
  return EMOJI_TO_ZULIP_NAME[emoji] ?? "eyes";
}

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const STREAM_ID_CACHE_TTL_MS = 10 * 60_000;

// Simple dedup cache
const recentIds = new Map<string, number>();

function dedup(key: string): boolean {
  const now = Date.now();
  // prune old
  if (recentIds.size > RECENT_MESSAGE_MAX) {
    const cutoff = now - RECENT_MESSAGE_TTL_MS;
    for (const [k, ts] of recentIds) {
      if (ts < cutoff) {
        recentIds.delete(k);
      }
    }
  }
  if (recentIds.has(key)) {
    return true;
  }
  recentIds.set(key, now);
  return false;
}

function resolveRuntime(opts: MonitorZulipOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(zulip|user):/i, "")
    .toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  return Array.from(new Set(entries.map((e) => normalizeAllowEntry(String(e))).filter(Boolean)));
}

function isSenderAllowed(params: {
  senderEmail: string;
  senderId: number;
  allowFrom: string[];
}): boolean {
  if (params.allowFrom.length === 0) {
    return false;
  }
  if (params.allowFrom.includes("*")) {
    return true;
  }
  const email = params.senderEmail.toLowerCase();
  const id = String(params.senderId);
  return params.allowFrom.some((e) => e === email || e === id);
}

function messageKind(msg: ZulipMessage): "dm" | "stream" {
  return msg.type === "private" ? "dm" : "stream";
}

function chatType(kind: "dm" | "stream"): "direct" | "channel" {
  return kind === "dm" ? "direct" : "channel";
}

/** Extract stream name from display_recipient (string for streams, array for DMs). */
function streamName(msg: ZulipMessage): string {
  if (typeof msg.display_recipient === "string") {
    return msg.display_recipient;
  }
  return "";
}

/** Build the "to" target string for routing replies back. */
function buildReplyTo(msg: ZulipMessage): string {
  if (msg.type === "stream") {
    return `stream:${streamName(msg)}:topic:${msg.subject}`;
  }
  // DM: send to sender
  return `dm:${msg.sender_id}`;
}

async function resolveZulipTopicHistory(params: {
  client: ZulipClient;
  stream: string;
  topic: string;
  currentMessageId: number;
  limit?: number;
}): Promise<ZulipMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  try {
    const messages = await fetchZulipMessages(params.client, {
      anchor: "newest",
      numBefore: maxMessages + 1,
      numAfter: 0,
      narrow: [
        { operator: "stream", operand: params.stream },
        { operator: "topic", operand: params.topic },
      ],
    });

    return messages
      .filter((message) => message.id !== params.currentMessageId)
      .filter((message) => Boolean(message.content?.trim()))
      .slice()
      .toSorted((a, b) => a.id - b.id)
      .slice(-maxMessages);
  } catch {
    return [];
  }
}

type ZulipTopicHistoryEnvelope = {
  channel: "Zulip";
  from: string;
  timestamp?: number;
  body: string;
  chatType: "channel";
  sender: { name: string; id: string };
};

export function formatZulipTopicHistoryBody(params: {
  messages: ZulipMessage[];
  botUserId: number;
  formatInboundEnvelope: (envelope: ZulipTopicHistoryEnvelope) => string;
}): string | undefined {
  if (params.messages.length === 0) {
    return undefined;
  }
  const historyParts: string[] = [];
  for (const historyMsg of params.messages) {
    const historySenderName = historyMsg.sender_full_name || historyMsg.sender_email;
    const role = historyMsg.sender_id === params.botUserId ? "assistant" : "user";
    const msgWithId = `${historyMsg.content}\n[zulip message id: ${historyMsg.id}]`;
    historyParts.push(
      params.formatInboundEnvelope({
        channel: "Zulip",
        from: `${historySenderName} (${role})`,
        timestamp: historyMsg.timestamp ? historyMsg.timestamp * 1000 : undefined,
        body: msgWithId,
        chatType: "channel",
        sender: { name: historySenderName, id: String(historyMsg.sender_id) },
      }),
    );
  }
  return historyParts.length > 0 ? historyParts.join("\n\n") : undefined;
}

export async function resolveZulipTopicContext(params: {
  client: ZulipClient;
  kind: "dm" | "stream";
  streamName: string;
  topic: string;
  currentMessageId: number;
  botUserId: number;
  initialHistoryLimit: number;
  sessionPreviousTimestamp?: number;
  formatInboundEnvelope: (envelope: ZulipTopicHistoryEnvelope) => string;
  logVerbose?: (message: string) => void;
}): Promise<{
  threadHistoryBody?: string;
  threadLabel?: string;
  isFirstTopicTurn: boolean;
}> {
  if (params.kind === "dm" || !params.streamName) {
    return { isFirstTopicTurn: false };
  }

  const threadLabel = `Zulip topic #${params.streamName} > ${params.topic}`;
  const isFirstTopicTurn = !params.sessionPreviousTimestamp;
  if (!isFirstTopicTurn) {
    params.logVerbose?.(`zulip: skip topic history for existing session ${threadLabel}`);
    return { threadLabel, isFirstTopicTurn };
  }
  if (params.initialHistoryLimit <= 0) {
    params.logVerbose?.(
      `zulip: topic history disabled for ${threadLabel} (initialHistoryLimit=${params.initialHistoryLimit})`,
    );
    return { threadLabel, isFirstTopicTurn };
  }

  const topicHistory = await resolveZulipTopicHistory({
    client: params.client,
    stream: params.streamName,
    topic: params.topic,
    currentMessageId: params.currentMessageId,
    limit: params.initialHistoryLimit,
  });
  const threadHistoryBody = formatZulipTopicHistoryBody({
    messages: topicHistory,
    botUserId: params.botUserId,
    formatInboundEnvelope: params.formatInboundEnvelope,
  });
  if (threadHistoryBody) {
    params.logVerbose?.(
      `zulip: populated topic history with ${topicHistory.length} messages for new session`,
    );
  }

  return {
    threadHistoryBody,
    threadLabel,
    isFirstTopicTurn,
  };
}

export function resolveZulipComponentReplyTarget(params: {
  replyTo?: string;
  senderId: number;
}): string {
  return params.replyTo?.trim() || `dm:${params.senderId}`;
}

type XCaseStatus = "open" | "in_progress" | "noaction" | "moved" | "error";

type XCaseRecord = {
  id: string;
  url: string;
  status: XCaseStatus;
  createdAt: number;
  updatedAt: number;
  originMessageId: string;
  originStream: string;
  originTopic: string;
  originSenderId: number;
  originSenderEmail: string;
  /** Where the intake card lives (single intake topic). */
  intakeStream: string;
  intakeTopic: string;
  /** Where analysis is posted (may be shared per-agent inbox or a dedicated topic). */
  analysisStream: string;
  analysisTopic: string;
  /** True when analysisTopic is intended to be dedicated to this case (used for topic->case inference). */
  dedicatedTopic: boolean;
  routePeerId: string;
  expertAgentId?: string;
  routeKey?: string;
  cardMessageId?: string;
  analysisFirstMessageId?: string;
  analysisLastMessageId?: string;
  analysisPostAsAccountId?: string;
  lastError?: string;
};

type XCaseStore = {
  version: 2;
  cases: XCaseRecord[];
};

type XCaseCommand =
  | { op: "help" }
  | { op: "list"; scope: "open" | "all" }
  | { op: "status"; caseId?: string }
  | { op: "continue"; caseId?: string; note?: string }
  | { op: "move"; caseId?: string; stream?: string; topic?: string }
  | { op: "close"; caseId?: string; reason?: string }
  | { op: "noaction"; caseId?: string; reason?: string };

const X_LINK_RE = /\bhttps?:\/\/(?:mobile\.)?(?:x\.com|twitter\.com)\/[^\s<>"')\]]+/gi;
const TRAILING_PUNCTUATION_RE = /[),.\]]+$/;

function normalizeXUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim().replace(TRAILING_PUNCTUATION_RE, ""));
    const host = parsed.hostname.toLowerCase();
    if (!(host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com")) {
      return null;
    }
    if (host === "mobile.twitter.com") {
      parsed.hostname = "twitter.com";
    }
    parsed.hash = "";
    parsed.searchParams.delete("s");
    parsed.searchParams.delete("t");
    parsed.searchParams.delete("utm_source");
    parsed.searchParams.delete("utm_medium");
    parsed.searchParams.delete("utm_campaign");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractXLinks(text: string, maxLinks: number): string[] {
  if (!text.trim()) {
    return [];
  }
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of text.matchAll(X_LINK_RE)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const normalized = normalizeXUrl(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    links.push(normalized);
    if (links.length >= maxLinks) {
      break;
    }
  }
  return links;
}

// ── Tweet Expansion ─────────────────────────────────────────────────
// When a Zulip message contains X/Twitter links, fetch the tweet text
// via `bird read --json` and reply with a formatted quote block.
// Tagged with [tweet-expand] so Neo4j/agents can filter these out.

const TWEET_EXPAND_CACHE = new Map<string, number>(); // url → timestamp
const TWEET_EXPAND_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — don't re-expand same tweet
const TWEET_EXPAND_TAG = "[tweet-expand]";

function pruneTweetExpandCache(): void {
  const now = Date.now();
  for (const [key, ts] of TWEET_EXPAND_CACHE) {
    if (now - ts > TWEET_EXPAND_TTL_MS) {
      TWEET_EXPAND_CACHE.delete(key);
    }
  }
}

interface BirdTweet {
  id: string;
  text: string;
  author?: { username?: string; name?: string };
  createdAt?: string;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
}

function birdReadTweet(url: string): Promise<BirdTweet | null> {
  return new Promise((resolve) => {
    child_process.execFile(
      "bird",
      ["read", "--json", url],
      { timeout: 15_000, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err || !stdout?.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as BirdTweet);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function formatTweetQuote(tweet: BirdTweet, url: string): string {
  const author = tweet.author?.name ?? tweet.author?.username ?? "Unknown";
  const handle = tweet.author?.username ? `@${tweet.author.username}` : "";
  const stats: string[] = [];
  if (tweet.likeCount) {
    stats.push(`${tweet.likeCount} likes`);
  }
  if (tweet.retweetCount) {
    stats.push(`${tweet.retweetCount} RTs`);
  }
  if (tweet.replyCount) {
    stats.push(`${tweet.replyCount} replies`);
  }
  const statsLine = stats.length > 0 ? `\n*${stats.join(" · ")}*` : "";

  return [
    TWEET_EXPAND_TAG,
    `> **${author}** ${handle}`,
    `> ${tweet.text.replace(/\n/g, "\n> ")}`,
    `>${statsLine}`,
    `> [original](${url})`,
  ].join("\n");
}

async function expandTweetsInMessage(params: {
  client: ZulipClient;
  msg: ZulipMessage;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { client, msg, logVerbose } = params;
  if (msg.type === "private") {
    return;
  } // only expand in streams
  const rawText = msg.content ?? "";
  if (rawText.includes(TWEET_EXPAND_TAG)) {
    return;
  } // skip our own expansions

  const links = extractXLinks(rawText, 3);
  if (links.length === 0) {
    return;
  }

  pruneTweetExpandCache();

  const stream = typeof msg.display_recipient === "string" ? msg.display_recipient : "";
  const topic = msg.subject ?? "";
  if (!stream || !topic) {
    return;
  }

  for (const url of links) {
    if (TWEET_EXPAND_CACHE.has(url)) {
      logVerbose(`zulip: tweet already expanded recently: ${url}`);
      continue;
    }
    TWEET_EXPAND_CACHE.set(url, Date.now());

    const tweet = await birdReadTweet(url);
    if (!tweet?.text) {
      logVerbose(`zulip: bird read failed for ${url}`);
      continue;
    }

    const content = formatTweetQuote(tweet, url);
    try {
      await sendZulipStreamMessage(client, { stream, topic, content });
      logVerbose(`zulip: expanded tweet ${url} in ${stream}/${topic}`);
    } catch (err) {
      logVerbose(`zulip: failed to send tweet expansion: ${String(err)}`);
    }
  }
}

// ── End Tweet Expansion ─────────────────────────────────────────────

function buildXCaseId(url: string): string {
  const statusMatch = url.match(/\/status\/(\d+)/);
  if (statusMatch?.[1]) {
    return `x-${statusMatch[1]}`;
  }
  return `x-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 10)}`;
}

function parseXCaseCommand(text: string): XCaseCommand | null {
  const trimmed = text.trim();
  if (!/^\/xcase\b/i.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split(/\s+/).slice(1);
  const op = parts[0]?.toLowerCase();
  if (!op || op === "help") {
    return { op: "help" };
  }
  if (op === "list") {
    const scope = parts[1]?.toLowerCase() === "all" ? "all" : "open";
    return { op: "list", scope };
  }
  const isCaseId = (value?: string) => Boolean(value && /^x-[a-z0-9]+$/i.test(value));
  if (op === "status") {
    return { op: "status", caseId: isCaseId(parts[1]) ? parts[1] : undefined };
  }
  if (op === "continue") {
    const args = parts.slice(1);
    const caseId = isCaseId(args[0]) ? args[0] : undefined;
    const noteStart = caseId ? 1 : 0;
    return {
      op: "continue",
      caseId,
      note: args.slice(noteStart).join(" ").trim() || undefined,
    };
  }
  if (op === "noaction") {
    const args = parts.slice(1);
    const caseId = isCaseId(args[0]) ? args[0] : undefined;
    const reasonStart = caseId ? 1 : 0;
    return {
      op: "noaction",
      caseId,
      reason: args.slice(reasonStart).join(" ").trim() || undefined,
    };
  }
  if (op === "close") {
    const args = parts.slice(1);
    const caseId = isCaseId(args[0]) ? args[0] : undefined;
    const reasonStart = caseId ? 1 : 0;
    return {
      op: "close",
      caseId,
      reason: args.slice(reasonStart).join(" ").trim() || undefined,
    };
  }
  if (op === "move") {
    const args = parts.slice(1);
    let index = 0;
    let caseId: string | undefined;
    let stream: string | undefined;
    if (args[index] && isCaseId(args[index])) {
      caseId = args[index];
      index += 1;
    }
    if (args[index]?.toLowerCase().startsWith("stream:")) {
      stream = args[index].slice("stream:".length).trim() || undefined;
      index += 1;
    }
    return {
      op: "move",
      caseId,
      stream,
      topic: args.slice(index).join(" ").trim() || undefined,
    };
  }
  return { op: "help" };
}

function normalizeTopicSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
}

function buildAnalysisTopic(caseId: string, url: string): string {
  const slug = normalizeTopicSegment(url.split("/").slice(-2).join("-")).slice(0, 30);
  return `x/${caseId}${slug ? `-${slug}` : ""}`;
}

function resolveXCaseTopicMode(xcase: ZulipXCaseConfig): "always" | "on_continue" | "never" {
  const explicit = xcase.caseTopicMode;
  if (explicit === "always" || explicit === "on_continue" || explicit === "never") {
    return explicit;
  }
  if (xcase.perCaseTopic === false) {
    return "never";
  }
  return "always";
}

function normalizeRouteKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "");
}

function buildRouteTokenMatchers(
  xcase: ZulipXCaseConfig,
): Array<{ key: string; tokens: string[] }> {
  const routes = xcase.routes ?? {};
  const items: Array<{ key: string; tokens: string[] }> = [];
  for (const [rawKey, cfg] of Object.entries(routes)) {
    const key = normalizeRouteKey(rawKey);
    if (!key) {
      continue;
    }
    const tokens = new Set<string>([key]);
    for (const alias of cfg.aliases ?? []) {
      const t = normalizeRouteKey(alias);
      if (t) {
        tokens.add(t);
      }
    }
    items.push({ key, tokens: Array.from(tokens) });
  }
  return items;
}

function resolveRouteConfigByNormalizedKey(
  xcase: ZulipXCaseConfig,
  normalizedKey: string,
): { key: string; cfg: NonNullable<ZulipXCaseConfig["routes"]>[string] } | undefined {
  const key = normalizeRouteKey(normalizedKey);
  if (!key) {
    return undefined;
  }
  for (const [rawKey, cfg] of Object.entries(xcase.routes ?? {})) {
    if (normalizeRouteKey(rawKey) === key) {
      return { key, cfg };
    }
  }
  return undefined;
}

function resolveRouteKeyFromText(text: string, xcase: ZulipXCaseConfig): string | undefined {
  const matchers = buildRouteTokenMatchers(xcase);
  if (matchers.length === 0) {
    return undefined;
  }

  const raw = text.toLowerCase();
  for (const matcher of matchers) {
    for (const token of matcher.tokens) {
      // Explicit override forms:
      //   #exdi, @exdi, to:exdi, agent:exdi, route:exdi
      const explicitRe = new RegExp(`(^|\\s)([#@]|to:|agent:|route:)${escapeRegex(token)}\\b`, "i");
      if (explicitRe.test(raw)) {
        return matcher.key;
      }

      // Plain mention: exdi / artie / etc. (whole word)
      const plainRe = new RegExp(`\\b${escapeRegex(token)}\\b`, "i");
      if (plainRe.test(raw)) {
        return matcher.key;
      }
    }
  }

  const fallback = xcase.defaultRoute ? normalizeRouteKey(xcase.defaultRoute) : "";
  if (fallback && resolveRouteConfigByNormalizedKey(xcase, fallback)) {
    return fallback;
  }
  if (fallback) {
    return fallback;
  }
  return undefined;
}

function isInCommandPost(params: {
  xcase: ZulipXCaseConfig;
  stream: string;
  topic: string;
}): boolean {
  if (!params.xcase.commandPostStream) {
    return false;
  }
  if (params.stream !== params.xcase.commandPostStream) {
    return false;
  }
  const topic = params.xcase.commandPostTopic?.trim();
  return !topic || params.topic === topic;
}

function shouldAutoTriage(params: {
  xcase: ZulipXCaseConfig;
  inCommandPost: boolean;
  wasMentioned: boolean;
}): boolean {
  if (params.xcase.enabled !== true) {
    return false;
  }
  const mode = params.xcase.autoTriage ?? "command_post_only";
  if (mode === "off") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  if (mode === "mentioned") {
    return params.wasMentioned;
  }
  return params.inCommandPost;
}

function formatXCaseHelp(): string {
  return [
    "**XCase commands**",
    "`/xcase list [all]`",
    "`/xcase status <caseId?>`",
    "`/xcase continue <caseId?> [note...]`",
    "`/xcase move <caseId?> [stream:NAME] <new topic>`",
    "`/xcase close <caseId?> [reason...]` (alias: `/xcase noaction`)",
    "`/xcase noaction <caseId?> [reason...]`",
    "",
    "Notes:",
    "- If you're not in a dedicated per-case topic, include the `<caseId>` (e.g. `x-123...`).",
    "- You can route captures with `#exdi`, `@artie`, or by mentioning the route key in your message text.",
  ].join("\n");
}

function formatXCaseRecord(record: XCaseRecord): string {
  return [
    `**${record.id}** · ${record.status}`,
    record.url,
    `expert: ${record.expertAgentId ?? "auto-route"} · route: ${record.routeKey ?? "default"} · analysis: #${record.analysisStream} > ${record.analysisTopic}`,
    `updated: ${new Date(record.updatedAt).toISOString()}`,
  ].join("\n");
}

type UnknownRecord = Record<string, unknown>;

function asUnknownRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function readUnknownString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readUnknownNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readXCaseStatus(value: unknown): XCaseStatus {
  return value === "open" || value === "in_progress" || value === "noaction" || value === "moved"
    ? value
    : "error";
}

function loadXCaseStore(storeFilePath: string): Map<string, XCaseRecord> {
  try {
    if (!fs.existsSync(storeFilePath)) {
      return new Map();
    }
    const parsed = asUnknownRecord(JSON.parse(fs.readFileSync(storeFilePath, "utf-8")));
    if (!parsed || !Array.isArray(parsed.cases)) {
      return new Map();
    }
    const parsedCases = parsed.cases
      .map((entry) => asUnknownRecord(entry))
      .filter((entry): entry is UnknownRecord => Boolean(entry));
    const version = readUnknownNumber(parsed.version, 0);

    // v1 -> v2 migration (best-effort)
    if (version === 1) {
      const migrated: XCaseRecord[] = parsedCases
        .map((r) => {
          const intakeStream = readUnknownString(r.commandPostStream).trim();
          const intakeTopic = readUnknownString(r.inboxTopic).trim();
          const analysisStream = intakeStream;
          const analysisTopic = readUnknownString(r.analysisTopic, intakeTopic).trim();
          const dedicatedTopic = analysisTopic !== intakeTopic;
          const id = readUnknownString(r.id).trim();
          const url = readUnknownString(r.url).trim();
          if (!id || !url || !intakeStream || !intakeTopic || !analysisTopic) {
            return null;
          }
          const record: XCaseRecord = {
            id,
            url,
            status: readXCaseStatus(r.status),
            createdAt: readUnknownNumber(r.createdAt, Date.now()),
            updatedAt: readUnknownNumber(r.updatedAt, Date.now()),
            originMessageId: readUnknownString(r.originMessageId),
            originStream: readUnknownString(r.originStream),
            originTopic: readUnknownString(r.originTopic),
            originSenderId: readUnknownNumber(r.originSenderId, 0),
            originSenderEmail: readUnknownString(r.originSenderEmail),
            intakeStream,
            intakeTopic,
            analysisStream,
            analysisTopic,
            dedicatedTopic,
            routePeerId: readUnknownString(r.routePeerId),
            expertAgentId: readUnknownString(r.expertAgentId).trim() || undefined,
            lastError: readUnknownString(r.lastError).trim() || undefined,
          };
          return record;
        })
        .filter(Boolean) as XCaseRecord[];
      return new Map(migrated.map((record) => [record.id, record]));
    }

    if (version !== 2) {
      return new Map();
    }
    const cases = parsedCases as XCaseRecord[];
    return new Map(cases.map((record) => [record.id, record]));
  } catch {
    return new Map();
  }
}

function saveXCaseStore(storeFilePath: string, store: Map<string, XCaseRecord>) {
  try {
    const payload: XCaseStore = {
      version: 2,
      cases: Array.from(store.values()).toSorted((a, b) => b.updatedAt - a.updatedAt),
    };
    fs.writeFileSync(storeFilePath, JSON.stringify(payload, null, 2));
  } catch {
    // Non-fatal: xcase persistence is best effort.
  }
}

function chooseExpertAgentId(params: {
  config: ZulipXCaseConfig;
  caseId: string;
}): string | undefined {
  if (params.config.expertAgentId?.trim()) {
    return params.config.expertAgentId.trim();
  }
  const pool = (params.config.expertAgentIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (pool.length === 0) {
    return undefined;
  }
  const hash = crypto.createHash("md5").update(params.caseId).digest();
  const index = hash[0] % pool.length;
  return pool[index];
}

export async function monitorZulipProvider(opts: MonitorZulipOpts = {}): Promise<void> {
  const core = getZulipRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({ cfg, accountId: opts.accountId });

  const botEmail = opts.botEmail?.trim() || account.botEmail?.trim();
  const botApiKey = opts.botApiKey?.trim() || account.botApiKey?.trim();
  if (!botEmail || !botApiKey) {
    throw new Error(`Zulip bot credentials missing for account "${account.accountId}"`);
  }
  const baseUrl = normalizeZulipBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(`Zulip baseUrl missing for account "${account.accountId}"`);
  }

  // Handle self-signed certs
  const tlsReject = account.config.tlsRejectUnauthorized;
  if (tlsReject === false && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const client = createZulipClient({ baseUrl, botEmail, botApiKey });
  const botUser = await fetchZulipMe(client);
  const botUserId = botUser.user_id;
  const botName = botUser.full_name || botEmail;
  runtime.log?.(`zulip connected as ${botName} (id=${botUserId})`);

  const resolvedConfigAllowFrom = await resolveZulipUserInputs({
    client,
    inputs: account.config.allowFrom ?? [],
  }).catch((error) => {
    runtime.error?.(`zulip allowFrom resolution failed: ${String(error)}`);
    return [];
  });
  const resolvedConfigGroupAllowFrom = await resolveZulipUserInputs({
    client,
    inputs: account.config.groupAllowFrom ?? [],
  }).catch((error) => {
    runtime.error?.(`zulip groupAllowFrom resolution failed: ${String(error)}`);
    return [];
  });
  logZulipResolutionSummary({
    label: "zulip allowFrom",
    resolutions: resolvedConfigAllowFrom,
    runtime,
  });
  logZulipResolutionSummary({
    label: "zulip groupAllowFrom",
    resolutions: resolvedConfigGroupAllowFrom,
    runtime,
  });

  const execApprovalsHandler = account.config.execApprovals?.enabled
    ? new ZulipExecApprovalHandler({
        client,
        accountId: account.accountId,
        config: account.config.execApprovals,
        cfg,
        runtime,
        widgetsEnabled: account.config.widgetsEnabled === true,
      })
    : null;
  const topicBindingsEnabled = resolveThreadBindingsEnabled({
    channelEnabledRaw: account.config.threadBindings?.enabled,
    sessionEnabledRaw: cfg.session?.threadBindings?.enabled,
  });
  const topicBindingsManager = topicBindingsEnabled
    ? createZulipTopicBindingManager({
        accountId: account.accountId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
          channelIdleHoursRaw: account.config.threadBindings?.idleHours,
          sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMs({
          channelMaxAgeHoursRaw: account.config.threadBindings?.maxAgeHours,
          sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours,
        }),
      })
    : null;

  const logger = core.logging.getChildLogger({ module: "zulip" });
  const logVerbose = (msg: string) => {
    if (core.logging.shouldLogVerbose()) {
      logger.debug?.(msg);
    }
  };

  await loadZulipComponentRegistry(account.accountId);

  const sendStaleComponentNotice = async (senderId: number) => {
    try {
      await sendMessageZulip(
        `dm:${senderId}`,
        "That Zulip action is no longer active. Please rerun the command or request a fresh prompt.",
        {
          cfg,
          accountId: account.accountId,
        },
      );
    } catch (err) {
      logVerbose(`zulip: failed to send stale component notice: ${String(err)}`);
    }
  };

  const resolvedAllowFromEntries = resolvedConfigAllowFrom.flatMap((entry) =>
    [entry.id, entry.email].filter((value): value is string => Boolean(value)),
  );
  const resolvedGroupAllowFromEntries = resolvedConfigGroupAllowFrom.flatMap((entry) =>
    [entry.id, entry.email].filter((value): value is string => Boolean(value)),
  );

  const canonicalConfigAllowFrom = normalizeAllowList([
    ...(account.config.allowFrom ?? []),
    ...resolvedAllowFromEntries,
  ]);
  const canonicalConfigGroupAllowFrom = normalizeAllowList([
    ...(account.config.groupAllowFrom ?? []),
    ...resolvedGroupAllowFromEntries,
  ]);

  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => undefined,
      accountId: account.accountId,
    }) ?? 8 * 1024 * 1024;

  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();
  const xcaseConfig = account.config.xcase;
  const xcaseStorePath = path.join(ZULIP_CACHE_DIR, `xcases-${account.accountId}.json`);
  const xcases = loadXCaseStore(xcaseStorePath);
  const xcaseByTopic = new Map<string, string>();
  const xcaseInFlight = new Set<string>();
  const topicKey = (stream: string, topic: string) => `${stream}:${topic}`;

  for (const record of xcases.values()) {
    if (record.dedicatedTopic) {
      xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), record.id);
    }
  }

  const persistXCases = () => saveXCaseStore(xcaseStorePath, xcases);
  const pruneXCases = () => {
    const maxCases = xcaseConfig?.maxOpenCases ?? 500;
    if (xcases.size <= maxCases) {
      return;
    }
    const records = Array.from(xcases.values()).toSorted((a, b) => b.updatedAt - a.updatedAt);
    for (const record of records.slice(maxCases)) {
      xcases.delete(record.id);
    }
    persistXCases();
  };

  // Stream ID cache for typing indicators
  const streamIdCache = new Map<string, { id: number; expiresAt: number }>();
  const resolveStreamId = async (name: string): Promise<number | undefined> => {
    const cached = streamIdCache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.id;
    }
    try {
      const id = await getZulipStreamId(client, name);
      streamIdCache.set(name, { id, expiresAt: Date.now() + STREAM_ID_CACHE_TTL_MS });
      return id;
    } catch {
      return undefined;
    }
  };

  const sendTypingIndicator = async (msg: ZulipMessage) => {
    try {
      if (msg.type === "stream" && msg.stream_id) {
        await sendZulipTyping(client, { op: "start", streamId: msg.stream_id, topic: msg.subject });
      } else if (msg.type === "stream") {
        const sName = streamName(msg);
        const id = sName ? await resolveStreamId(sName) : undefined;
        if (id) {
          await sendZulipTyping(client, { op: "start", streamId: id, topic: msg.subject });
        }
      } else {
        await sendZulipTyping(client, { op: "start", to: [msg.sender_id] });
      }
    } catch (err) {
      logVerbose(`zulip typing failed: ${String(err)}`);
    }
  };

  const sendXCaseMessage = async (
    stream: string,
    topic: string,
    text: string,
    opts: { accountId?: string } = {},
  ) => {
    await sendMessageZulip(`stream:${stream}:topic:${topic}`, text, {
      accountId: opts.accountId ?? account.accountId,
    });
  };

  const renderXCaseCard = (record: XCaseRecord): string => {
    const routePart = record.routeKey ? ` · ${record.routeKey}` : "";
    const expert = record.expertAgentId ?? "auto-route";
    const analysisWhere = `#${record.analysisStream} > ${record.analysisTopic}`;
    const analysisLink = record.analysisFirstMessageId
      ? `${baseUrl}/#narrow/near/${record.analysisFirstMessageId}`
      : "";
    const errorLine = record.lastError ? `error: ${record.lastError}` : "";
    const chatLine = record.dedicatedTopic
      ? "chat: reply in the case topic"
      : `chat: /xcase continue ${record.id}`;
    return [
      `xcase ${record.id} · ${record.status}${routePart}`,
      record.url,
      `expert: ${expert}`,
      `analysis: ${analysisWhere}`,
      analysisLink,
      chatLine,
      errorLine,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const upsertXCaseCard = async (record: XCaseRecord) => {
    const cardText = renderXCaseCard(record);
    const sendNew = async () => {
      const res = await sendMessageZulip(
        `stream:${record.intakeStream}:topic:${record.intakeTopic}`,
        cardText,
        { accountId: account.accountId },
      );
      record.cardMessageId = res.messageId;
      record.updatedAt = Date.now();
      persistXCases();
    };

    const messageId = record.cardMessageId ? Number(record.cardMessageId) : NaN;
    if (!Number.isFinite(messageId) || messageId <= 0) {
      await sendNew();
      return;
    }

    try {
      await updateZulipMessage(client, { messageId, content: cardText });
    } catch (err) {
      logVerbose(`zulip xcase: card update failed, posting new card: ${String(err)}`);
      await sendNew();
    }
  };

  const runXCaseAnalysis = async (params: {
    record: XCaseRecord;
    sourceText: string;
    senderName: string;
    senderId: number;
    note?: string;
    kind?: "initial" | "followup";
  }) => {
    if (xcaseInFlight.has(params.record.id)) {
      await upsertXCaseCard(params.record);
      return;
    }

    xcaseInFlight.add(params.record.id);
    params.record.status = "in_progress";
    params.record.updatedAt = Date.now();
    persistXCases();
    await upsertXCaseCard(params.record);

    try {
      const routePeerPrefix = xcaseConfig?.routePeerPrefix?.trim() || "xcase";
      params.record.routePeerId = `${routePeerPrefix}:${params.record.id}`;
      const expertRoute = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
        peer: {
          kind: "channel",
          id: params.record.routePeerId,
        },
      });

      const expertAgentId = params.record.expertAgentId || expertRoute.agentId;
      const expertSessionKey = `agent:${expertAgentId}:zulip:xcase:${params.record.id}`;
      const targetTo = `stream:${params.record.analysisStream}:topic:${params.record.analysisTopic}`;
      const analysisText =
        params.kind === "followup"
          ? [
              `XCase ${params.record.id}`,
              `URL: ${params.record.url}`,
              params.note ? `Operator note: ${params.note}` : "",
              "Operator follow-up:",
              params.sourceText,
              "",
              "Respond to the follow-up in context of this case. Be concise and concrete.",
            ]
              .filter(Boolean)
              .join("\n")
          : [
              `XCase ${params.record.id}`,
              `URL: ${params.record.url}`,
              params.note ? `Operator note: ${params.note}` : "",
              "Please analyze this link for applicability to our team.",
              "Respond with concise sections:",
              "1) Summary",
              "2) Relevance to us",
              "3) Risks or opportunities",
              "4) Recommended action",
              "",
              "Source context:",
              params.sourceText,
            ]
              .filter(Boolean)
              .join("\n");
      const inboundBody = core.channel.reply.formatInboundEnvelope({
        channel: "Zulip",
        from: `${params.senderName} (user)`,
        body: `${analysisText}\n[xcase id: ${params.record.id}]`,
        chatType: "channel",
        sender: { name: params.senderName, id: String(params.senderId) },
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: inboundBody,
        RawBody: analysisText,
        CommandBody: analysisText,
        From: `zulip:xcase:${params.record.id}`,
        To: targetTo,
        SessionKey: expertSessionKey,
        AccountId: expertRoute.accountId,
        ChatType: "channel",
        ConversationLabel: `#${params.record.analysisStream} > ${params.record.analysisTopic}`,
        GroupSubject: `${params.record.analysisStream} > ${params.record.analysisTopic}`,
        GroupChannel: `#${params.record.analysisStream}`,
        SenderName: params.senderName,
        SenderId: String(params.senderId),
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        MessageSid: `${params.record.id}:${Date.now()}`,
        WasMentioned: true,
        CommandAuthorized: true,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: targetTo,
      });

      const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", account.accountId, {
        fallbackLimit: account.textChunkLimit ?? 10000,
      });
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
      });
      const prefixContext = createReplyPrefixContext({ cfg, agentId: expertAgentId });
      const deliverAccountId = params.record.analysisPostAsAccountId ?? account.accountId;
      let firstMessageId: string | undefined;
      let lastMessageId: string | undefined;
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: prefixContext.responsePrefix,
          responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, expertAgentId),
          deliver: async (payload: ReplyPayload) => {
            const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
            const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
            const interactiveSpec = (() => {
              const raw = payload.channelData?.zulip;
              if (!raw) {
                return null;
              }
              try {
                return readZulipComponentSpec(raw);
              } catch (err) {
                logVerbose(
                  `zulip: invalid xcase widget payload, falling back to text: ${String(err)}`,
                );
                return null;
              }
            })();
            if (interactiveSpec) {
              const firstMediaUrl = mediaUrls[0];
              const res = await sendZulipComponentMessage(targetTo, text, interactiveSpec, {
                cfg,
                accountId: deliverAccountId,
                sessionKey: ctxPayload.SessionKey,
                agentId: expertAgentId,
                mediaUrl: firstMediaUrl,
              });
              if (!firstMessageId) {
                firstMessageId = res.messageId;
              }
              lastMessageId = res.messageId;
              for (const mediaUrl of mediaUrls.slice(1)) {
                const mediaRes = await sendMessageZulip(targetTo, "", {
                  cfg,
                  accountId: deliverAccountId,
                  mediaUrl,
                });
                lastMessageId = mediaRes.messageId;
              }
              return;
            }
            if (mediaUrls.length === 0) {
              const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
              const chunks = core.channel.text.chunkMarkdownTextWithMode(
                text,
                textLimit,
                chunkMode,
              );
              for (const chunk of chunks.length > 0 ? chunks : [text]) {
                if (!chunk) {
                  continue;
                }
                const res = await sendMessageZulip(targetTo, chunk, {
                  accountId: deliverAccountId,
                });
                if (!firstMessageId) {
                  firstMessageId = res.messageId;
                }
                lastMessageId = res.messageId;
              }
            } else {
              let first = true;
              for (const mediaUrl of mediaUrls) {
                const caption = first ? text : "";
                first = false;
                const res = await sendMessageZulip(targetTo, caption, {
                  accountId: deliverAccountId,
                  mediaUrl,
                });
                if (!firstMessageId) {
                  firstMessageId = res.messageId;
                }
                lastMessageId = res.messageId;
              }
            }
          },
          onError: (err, info) => {
            runtime.error?.(`zulip xcase ${info.kind} reply failed: ${String(err)}`);
          },
        });

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected: prefixContext.onModelSelected,
        },
      });
      markDispatchIdle();

      params.record.status = "open";
      params.record.updatedAt = Date.now();
      params.record.lastError = undefined;
      if (firstMessageId) {
        params.record.analysisFirstMessageId = firstMessageId;
      }
      if (lastMessageId) {
        params.record.analysisLastMessageId = lastMessageId;
      }
      persistXCases();
      await upsertXCaseCard(params.record);
    } catch (err) {
      params.record.status = "error";
      params.record.lastError = String(err);
      params.record.updatedAt = Date.now();
      persistXCases();
      await upsertXCaseCard(params.record);
    } finally {
      xcaseInFlight.delete(params.record.id);
    }
  };

  /**
   * Handle a submessage event (widget callback).
   * Resolves the component entry from the registry and dispatches
   * the callback as an inbound message to the agent session.
   */
  const handleSubmessageEvent = async (event: ZulipSubmessageEvent): Promise<void> => {
    // Only handle widget-type submessages
    if (event.msg_type !== "widget") {
      return;
    }

    // Skip our own submessages (bot clicking its own buttons)
    if (event.sender_id === botUserId) {
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.content) as Record<string, unknown>;
    } catch {
      return; // Malformed JSON — ignore
    }

    // Only handle ocform callbacks
    if (data.type !== "ocform_callback") {
      return;
    }

    const buttonId = data.button_id;
    if (typeof buttonId !== "string") {
      return;
    }

    const claimResult = await claimZulipComponentEntry({
      accountId: account.accountId,
      id: buttonId,
      senderId: event.sender_id,
    });
    if (claimResult.kind === "missing" || claimResult.kind === "expired") {
      runtime.log?.(`zulip: ocform callback for stale button '${buttonId}', notifying clicker`);
      await sendStaleComponentNotice(event.sender_id);
      return;
    }
    if (claimResult.kind === "consumed") {
      runtime.log?.(`zulip: ocform callback for consumed button '${buttonId}', notifying clicker`);
      await sendStaleComponentNotice(event.sender_id);
      return;
    }
    if (claimResult.kind === "unauthorized") {
      runtime.log?.(`zulip: ocform callback from unauthorized user ${event.sender_id}`);
      return;
    }

    const entry = claimResult.entry;
    const sessionKey = entry.sessionKey;
    const agentId = entry.agentId;
    const componentChatType = entry.chatType ?? "channel";
    const replyTarget = resolveZulipComponentReplyTarget({
      replyTo: entry.replyTo,
      senderId: event.sender_id,
    });
    const consumeWidgetMessage = async () => {
      if (entry.reusable) {
        return;
      }
      if (typeof entry.messageId === "number" && Number.isFinite(entry.messageId) && entry.messageId > 0) {
        await consumeZulipComponentMessageEntries({
          accountId: entry.accountId,
          messageId: entry.messageId,
        });
        return;
      }
      await removeZulipComponentEntry(entry.id, entry.accountId);
    };

    const approvalResult = execApprovalsHandler
      ? await execApprovalsHandler.handleCallback({
          callbackData: entry.callbackData,
          senderId: event.sender_id,
        })
      : { handled: false, consume: false };
    if (approvalResult.handled) {
      if (approvalResult.consume) {
        await consumeWidgetMessage();
      }
      return;
    }

    const modelPickerAction = await resolveZulipModelPickerCallbackAction({
      cfg,
      callbackData: entry.callbackData,
      agentId,
      sessionKey,
      allowedUserIds: entry.allowedUsers,
    });
    if (modelPickerAction) {
      if (modelPickerAction.kind === "render") {
        await sendZulipComponentMessage(
          replyTarget,
          modelPickerAction.render.text,
          modelPickerAction.render.spec,
          {
            cfg,
            accountId: entry.accountId,
            sessionKey,
            agentId,
          },
        );
        await consumeWidgetMessage();
        return;
      }
      if (modelPickerAction.kind === "text") {
        await sendMessageZulip(replyTarget, modelPickerAction.text, {
          cfg,
          accountId: entry.accountId,
        });
        await consumeWidgetMessage();
        return;
      }
      runtime.log?.(
        `zulip: model picker selection from user ${event.sender_id}: ${modelPickerAction.commandText} (message ${event.message_id})`,
      );
      const inboundBody = core.channel.reply.formatInboundEnvelope({
        channel: "Zulip",
        from: `user:${event.sender_id}`,
        body: modelPickerAction.commandText,
        chatType: componentChatType,
        sender: { name: `user:${event.sender_id}`, id: String(event.sender_id) },
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: inboundBody,
        RawBody: modelPickerAction.commandText,
        CommandBody: modelPickerAction.commandText,
        From: `zulip:ocform:${event.sender_id}`,
        To: entry.replyTo ?? `ocform:${event.message_id}`,
        SessionKey: sessionKey,
        AccountId: entry.accountId,
        ChatType: componentChatType,
        ConversationLabel: entry.replyTo ?? `ocform callback (message ${event.message_id})`,
        SenderName: `user:${event.sender_id}`,
        SenderId: String(event.sender_id),
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        MessageSid: `ocform:${event.submessage_id}`,
        WasMentioned: true,
        CommandAuthorized: true,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: entry.replyTo ?? `ocform:${event.message_id}`,
      });

      const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", entry.accountId, {
        fallbackLimit: account.textChunkLimit ?? 10000,
      });
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "zulip",
        accountId: entry.accountId,
      });
      const prefixContext = createReplyPrefixContext({ cfg, agentId });

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: prefixContext.responsePrefix,
          responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
          deliver: async (payload: ReplyPayload) => {
            const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", entry.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            const interactiveSpec = (() => {
              const raw = payload.channelData?.zulip;
              if (!raw) {
                return null;
              }
              try {
                return readZulipComponentSpec(raw);
              } catch (err) {
                logVerbose(
                  `zulip: invalid ocform reply widget payload, falling back to text: ${String(err)}`,
                );
                return null;
              }
            })();
            if (interactiveSpec) {
              await sendZulipComponentMessage(replyTarget, text, interactiveSpec, {
                cfg,
                accountId: entry.accountId,
                sessionKey,
                agentId,
              });
              return;
            }
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) {
                continue;
              }
              await sendMessageZulip(replyTarget, chunk, {
                cfg,
                accountId: entry.accountId,
              });
            }
          },
          onError: (err, info) => {
            runtime.error?.(`zulip ocform ${info.kind} reply failed: ${String(err)}`);
          },
        });

      try {
        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected: prefixContext.onModelSelected,
          },
        });
        await consumeWidgetMessage();
      } finally {
        markDispatchIdle();
      }
      return;
    }



    const label = typeof data.label === "string" ? data.label : entry.label;
    const eventText = formatZulipComponentEventText({
      label,
      buttonId,
      senderName: `user:${event.sender_id}`,
      callbackData: entry.callbackData,
    });

    runtime.log?.(
      `zulip: ocform callback from user ${event.sender_id}: ${eventText} (message ${event.message_id})`,
    );

    // Dispatch the callback as an inbound message to the agent session.
    // Use the session key stored in the registry entry so the callback
    // lands in the same conversation that created the widget.

    const inboundBody = core.channel.reply.formatInboundEnvelope({
      channel: "Zulip",
      from: `user:${event.sender_id}`,
      body: eventText,
      chatType: componentChatType,
      sender: { name: `user:${event.sender_id}`, id: String(event.sender_id) },
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: inboundBody,
      RawBody: eventText,
      CommandBody: eventText,
      From: `zulip:ocform:${event.sender_id}`,
      To: entry.replyTo ?? `ocform:${event.message_id}`,
      SessionKey: sessionKey,
      AccountId: entry.accountId,
      ChatType: componentChatType,
      ConversationLabel: entry.replyTo ?? `ocform callback (message ${event.message_id})`,
      SenderName: `user:${event.sender_id}`,
      SenderId: String(event.sender_id),
      Provider: "zulip" as const,
      Surface: "zulip" as const,
      MessageSid: `ocform:${event.submessage_id}`,
      WasMentioned: true,
      CommandAuthorized: true,
      OriginatingChannel: "zulip" as const,
      OriginatingTo: entry.replyTo ?? `ocform:${event.message_id}`,
    });

    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", entry.accountId, {
      fallbackLimit: account.textChunkLimit ?? 10000,
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: entry.accountId,
    });
    const prefixContext = createReplyPrefixContext({ cfg, agentId });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        responsePrefix: prefixContext.responsePrefix,
        responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
        deliver: async (payload: ReplyPayload) => {
          const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
          const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", entry.accountId);
          const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
          const interactiveSpec = (() => {
            const raw = payload.channelData?.zulip;
            if (!raw) {
              return null;
            }
            try {
              return readZulipComponentSpec(raw);
            } catch (err) {
              logVerbose(
                `zulip: invalid ocform reply widget payload, falling back to text: ${String(err)}`,
              );
              return null;
            }
          })();
          if (interactiveSpec) {
            await sendZulipComponentMessage(replyTarget, text, interactiveSpec, {
              cfg,
              accountId: entry.accountId,
              sessionKey,
              agentId,
            });
            return;
          }
          for (const chunk of chunks.length > 0 ? chunks : [text]) {
            if (!chunk) {
              continue;
            }
            await sendMessageZulip(replyTarget, chunk, {
              cfg,
              accountId: entry.accountId,
            });
          }
        },
        onError: (err, info) => {
          runtime.error?.(`zulip ocform ${info.kind} reply failed: ${String(err)}`);
        },
      });

    try {
      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected: prefixContext.onModelSelected,
        },
      });
      await consumeWidgetMessage();
    } finally {
      markDispatchIdle();
    }
  };

  const handleMessage = async (msg: ZulipMessage) => {
    const msgKey = `${account.accountId}:${msg.id}`;
    if (dedup(msgKey)) {
      return;
    }

    // Skip own messages
    if (msg.sender_id === botUserId) {
      return;
    }

    // Skip messages from other bots UNLESS this bot was explicitly @mentioned
    // (allows agent coordination when mentioned, prevents infinite loops otherwise)
    const isBotSender =
      msg.sender_email?.endsWith("-bot@macpro.tail63777e.ts.net") ||
      msg.sender_email?.endsWith("-bot-bot@macpro.tail63777e.ts.net") ||
      msg.is_bot === true;
    const wasMentionedByBot =
      isBotSender &&
      (msg.flags?.includes("mentioned") ||
        msg.flags?.includes("wildcard_mentioned") ||
        (msg.content ?? "")
          .toLowerCase()
          .includes(`@**${botUser.full_name?.toLowerCase() ?? ""}**`));
    if (isBotSender && !wasMentionedByBot) {
      logVerbose(`zulip: skip bot message from ${msg.sender_email} (not mentioned)`);
      return;
    }

    // Fire-and-forget: expand X/Twitter links — only for the stream-owning bot
    const tweetStreamName = typeof msg.display_recipient === "string" ? msg.display_recipient : "";
    const tweetStreamOwner =
      tweetStreamName &&
      !(
        account.config.streams?.[tweetStreamName]?.requireMention ??
        account.config.requireMention ??
        true
      );
    if (tweetStreamOwner) {
      void expandTweetsInMessage({ client, msg, logVerbose }).catch((err) =>
        logVerbose(`zulip: tweet expansion error: ${err}`),
      );
    }

    const kind = messageKind(msg);
    const cType = chatType(kind);

    const senderEmail = msg.sender_email;
    const senderName = msg.sender_full_name || senderEmail;
    const senderId = msg.sender_id;

    // Access control
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const groupPolicy =
      account.config.groupPolicy ?? cfg.channels?.defaults?.groupPolicy ?? "allowlist";
    const configAllowFrom = canonicalConfigAllowFrom;
    const configGroupAllowFrom = canonicalConfigGroupAllowFrom;
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing
        .readAllowFromStore({ channel: "zulip", accountId: account.accountId })
        .catch(() => []),
    );
    const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
    const effectiveGroupAllowFrom = Array.from(
      new Set([
        ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
        ...storeAllowFrom,
      ]),
    );

    const senderAllowed = isSenderAllowed({ senderEmail, senderId, allowFrom: effectiveAllowFrom });
    const groupSenderAllowed = isSenderAllowed({
      senderEmail,
      senderId,
      allowFrom: effectiveGroupAllowFrom,
    });

    const rawText = msg.content?.trim() ?? "";
    const botMentionRegex = new RegExp(`@\\*\\*${escapeRegex(botName)}\\*\\*`, "gi");
    const cleanText = rawText.replace(botMentionRegex, "").replace(/\s+/g, " ").trim();
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "zulip",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const hasXCaseCommandSyntax = /^\/xcase\b/i.test(cleanText);
    const isControlCommand = allowTextCommands && (hasControlCommand || hasXCaseCommandSyntax);
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveAllowFrom.length > 0, allowed: senderAllowed },
        { configured: effectiveGroupAllowFrom.length > 0, allowed: groupSenderAllowed },
      ],
      allowTextCommands,
      hasControlCommand: hasControlCommand || hasXCaseCommandSyntax,
    });
    const commandAuthorized =
      kind === "dm" ? dmPolicy === "open" || senderAllowed : commandGate.commandAuthorized;

    // DM gating
    if (kind === "dm") {
      if (dmPolicy === "disabled") {
        logVerbose(`zulip: drop dm (disabled) sender=${senderEmail}`);
        return;
      }
      if (dmPolicy !== "open" && !senderAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "zulip",
            accountId: account.accountId,
            id: String(senderId),
            meta: { name: senderName, email: senderEmail },
          });
          if (created) {
            try {
              await sendMessageZulip(
                `dm:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "zulip",
                  idLine: `Your Zulip user id: ${senderId} (${senderEmail})`,
                  code,
                }),
                { accountId: account.accountId },
              );
            } catch (err) {
              logVerbose(`zulip: pairing reply failed: ${String(err)}`);
            }
          }
        }
        return;
      }
    } else {
      // Stream gating
      if (groupPolicy === "disabled") {
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          return;
        }
        if (!groupSenderAllowed) {
          return;
        }
      }
    }

    if (kind !== "dm" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "zulip",
        reason: "control command (unauthorized)",
        target: String(senderId),
      });
      return;
    }

    // Mention detection
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, undefined);
    const wasMentioned =
      kind !== "dm" &&
      (msg.flags?.includes("mentioned") ||
        msg.flags?.includes("wildcard_mentioned") ||
        rawText.toLowerCase().includes(`@**${botName.toLowerCase()}**`) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));

    const sName = streamName(msg);
    const topic = msg.subject || "(no topic)";

    // Session key: stream + topic = thread
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
      peer: {
        kind: kind === "dm" ? "direct" : "channel",
        id: kind === "dm" ? String(senderId) : `${sName}:${topic}`,
      },
    });

    const topicConversationId =
      kind !== "dm" && sName ? resolveZulipTopicConversationId({ stream: sName, topic }) : null;
    const existingTopicBinding =
      kind !== "dm" && topicBindingsManager && topicConversationId
        ? topicBindingsManager.getByConversationId(topicConversationId)
        : undefined;
    if (existingTopicBinding && topicConversationId) {
      topicBindingsManager?.touchConversation(
        topicConversationId,
        msg.timestamp ? msg.timestamp * 1000 : undefined,
      );
    }
    let sessionKey =
      kind === "dm"
        ? route.sessionKey
        : (existingTopicBinding?.targetSessionKey ?? `${route.sessionKey}:topic:${topic}`);
    const historyKey =
      kind === "dm"
        ? null
        : (existingTopicBinding?.targetSessionKey ?? topicConversationId ?? sessionKey);
    const sessionCfg = cfg.session;
    const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });

    // Check stream-level requireMention override (like Discord's per-channel config)
    const streamConfig = kind !== "dm" && sName ? account.config.streams?.[sName] : undefined;
    const shouldRequireMention =
      kind !== "dm" && (streamConfig?.requireMention ?? account.requireMention ?? true);

    // Record pending history for non-triggered messages
    const recordPendingHistory = () => {
      const trimmed = rawText.trim();
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: senderName,
                body: trimmed,
                timestamp: msg.timestamp ? msg.timestamp * 1000 : undefined,
                messageId: String(msg.id),
              }
            : null,
      });
    };

    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention;

    const isDedicatedXCaseTopic =
      kind !== "dm" && sName ? xcaseByTopic.has(topicKey(sName, topic)) : false;

    // Special-case: allow xcase auto-triage intake + dedicated xcase topics to work without @mention.
    const shouldBypassMentionForXCase =
      kind !== "dm" &&
      shouldRequireMention &&
      !effectiveWasMentioned &&
      Boolean(xcaseConfig?.enabled) &&
      (isDedicatedXCaseTopic ||
        Boolean(
          xcaseConfig &&
          shouldAutoTriage({
            xcase: xcaseConfig,
            inCommandPost: isInCommandPost({ xcase: xcaseConfig, stream: sName, topic }),
            wasMentioned: false,
          }) &&
          extractXLinks(cleanText, xcaseConfig.maxLinksPerMessage ?? 3).length > 0,
        ));

    if (
      kind !== "dm" &&
      shouldRequireMention &&
      !effectiveWasMentioned &&
      !shouldBypassMentionForXCase
    ) {
      recordPendingHistory();
      return;
    }

    if (!cleanText) {
      return;
    }

    const xcaseCommand = parseXCaseCommand(cleanText);
    if (xcaseCommand) {
      if (!allowTextCommands) {
        logVerbose("zulip xcase: text commands disabled, ignoring command");
        return;
      }
      const commandTo = buildReplyTo(msg);
      if (!xcaseConfig?.enabled) {
        await sendMessageZulip(
          commandTo,
          "xcase is disabled for this account. Enable channels.zulip.xcase.enabled first.",
          { accountId: account.accountId },
        );
        return;
      }
      const resolveCaseId = (requested?: string): string | undefined => {
        const normalizedRequested = requested?.trim();
        if (normalizedRequested && xcases.has(normalizedRequested)) {
          return normalizedRequested;
        }
        const caseFromTopic =
          kind !== "dm" && sName ? xcaseByTopic.get(topicKey(sName, topic)) : undefined;
        if (caseFromTopic) {
          return caseFromTopic;
        }
        const links = extractXLinks(cleanText, 1);
        if (links.length === 1) {
          const inferred = buildXCaseId(links[0]);
          if (xcases.has(inferred)) {
            return inferred;
          }
        }
        return normalizedRequested;
      };
      const loadCase = (requested?: string): XCaseRecord | null => {
        const resolvedId = resolveCaseId(requested);
        if (!resolvedId) {
          return null;
        }
        return xcases.get(resolvedId) ?? null;
      };

      switch (xcaseCommand.op) {
        case "help":
          await sendMessageZulip(commandTo, formatXCaseHelp(), { accountId: account.accountId });
          return;
        case "list": {
          const all = Array.from(xcases.values()).toSorted((a, b) => b.updatedAt - a.updatedAt);
          const items =
            xcaseCommand.scope === "all" ? all : all.filter((record) => record.status === "open");
          if (items.length === 0) {
            await sendMessageZulip(
              commandTo,
              `xcase list (${xcaseCommand.scope}): no cases found.`,
              { accountId: account.accountId },
            );
            return;
          }
          const lines = items
            .slice(0, 20)
            .map(
              (record) =>
                `- ${record.id} · ${record.status} · ${record.routeKey ?? "default"} · #${record.analysisStream} > ${record.analysisTopic}`,
            );
          await sendMessageZulip(
            commandTo,
            [`xcase list (${xcaseCommand.scope}):`, ...lines].join("\n"),
            {
              accountId: account.accountId,
            },
          );
          return;
        }
        case "status": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase status: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          await sendMessageZulip(commandTo, formatXCaseRecord(record), {
            accountId: account.accountId,
          });
          return;
        }
        case "noaction": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase noaction: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          record.status = "noaction";
          record.updatedAt = Date.now();
          persistXCases();
          if (xcaseCommand.reason) {
            record.lastError = `closed: ${xcaseCommand.reason}`;
          } else {
            record.lastError = undefined;
          }
          await upsertXCaseCard(record);
          await sendMessageZulip(commandTo, `xcase ${record.id}: closed (no-action).`, {
            accountId: account.accountId,
          });
          return;
        }
        case "close": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase close: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          record.status = "noaction";
          record.updatedAt = Date.now();
          persistXCases();
          if (xcaseCommand.reason) {
            record.lastError = `closed: ${xcaseCommand.reason}`;
          } else {
            record.lastError = undefined;
          }
          await upsertXCaseCard(record);
          await sendMessageZulip(commandTo, `xcase ${record.id}: closed.`, {
            accountId: account.accountId,
          });
          return;
        }
        case "move": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase move: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          if (!xcaseCommand.topic) {
            await sendMessageZulip(commandTo, "xcase move: target topic is required.", {
              accountId: account.accountId,
            });
            return;
          }
          if (record.dedicatedTopic) {
            xcaseByTopic.delete(topicKey(record.analysisStream, record.analysisTopic));
          }
          if (xcaseCommand.stream?.trim()) {
            record.analysisStream = xcaseCommand.stream.trim();
          }
          record.analysisTopic = xcaseCommand.topic.trim();
          record.status = "moved";
          record.updatedAt = Date.now();
          record.dedicatedTopic = true;
          xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), record.id);
          persistXCases();
          await sendXCaseMessage(
            record.analysisStream,
            record.analysisTopic,
            [
              `xcase ${record.id} moved here.`,
              record.url,
              "Use `/xcase continue` in this topic for follow-up analysis.",
            ].join("\n"),
            { accountId: record.analysisPostAsAccountId },
          );
          await upsertXCaseCard(record);
          await sendMessageZulip(
            commandTo,
            `xcase ${record.id}: moved to #${record.analysisStream} > ${record.analysisTopic}`,
            { accountId: account.accountId },
          );
          return;
        }
        case "continue": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase continue: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          const topicMode = xcaseConfig ? resolveXCaseTopicMode(xcaseConfig) : "always";
          if (topicMode === "on_continue" && !record.dedicatedTopic) {
            const newTopic = buildAnalysisTopic(record.id, record.url);
            record.analysisTopic = newTopic;
            record.dedicatedTopic = true;
            record.updatedAt = Date.now();
            xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), record.id);
            persistXCases();
            await sendXCaseMessage(
              record.analysisStream,
              record.analysisTopic,
              [`xcase ${record.id} thread opened here.`, record.url].join("\n"),
              { accountId: record.analysisPostAsAccountId },
            );
          }
          await sendMessageZulip(
            commandTo,
            `xcase ${record.id}: running follow-up analysis in #${record.analysisStream} > ${record.analysisTopic}`,
            { accountId: account.accountId },
          );
          await runXCaseAnalysis({
            record,
            sourceText: cleanText,
            senderName,
            senderId,
            note: xcaseCommand.note,
            kind: "followup",
          });
          return;
        }
      }
    }

    // Ack reaction: immediately show the bot is processing this message
    const ackReaction = resolveAckReaction(cfg, route.agentId);
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
    const shouldAck = Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: kind === "dm",
        isGroup: kind !== "dm",
        isMentionableGroup: kind !== "dm",
        requireMention: Boolean(shouldRequireMention),
        canDetectMention: true,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
    const ackEmojiName = ackReaction ? emojiToZulipName(ackReaction) : "eyes";
    const ackReactionPromise = shouldAck
      ? addZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).then(
          () => true,
          (err) => {
            logVerbose(`zulip ack react failed for message ${msg.id}: ${String(err)}`);
            return false;
          },
        )
      : null;

    // Download any Zulip uploads (images, files) and get media paths
    const { attachmentInfo, strippedContent, mediaPaths, mediaTypes } = await processZulipUploads(
      client,
      rawText,
      mediaMaxBytes,
      async ({ buffer, contentType, fileName }) => {
        return core.channel.media.saveMediaBuffer(
          buffer,
          contentType,
          "inbound",
          mediaMaxBytes,
          fileName,
        );
      },
    );
    const { textWithAttachments, bodyForAgent } = buildZulipAgentBody({
      cleanText,
      strippedContent,
      attachmentInfo,
      botMentionRegex,
      messageId: msg.id,
    });

    // Dedicated xcase topics behave like real threads: any message is treated as a follow-up turn.
    if (kind !== "dm" && sName && isDedicatedXCaseTopic && xcaseConfig?.enabled) {
      const caseId = xcaseByTopic.get(topicKey(sName, topic));
      const record = caseId ? xcases.get(caseId) : undefined;
      if (record && record.status !== "noaction") {
        const sourceText =
          xcaseConfig.includeMessageContext === false
            ? cleanText
            : `${textWithAttachments}\n[zulip message id: ${msg.id}]`;
        await runXCaseAnalysis({
          record,
          sourceText,
          senderName,
          senderId,
          kind: "followup",
        });

        if (removeAckAfterReply && ackReactionPromise) {
          void ackReactionPromise.then((didAck) => {
            if (!didAck) {
              return;
            }
            removeZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).catch(
              (err) => {
                logVerbose(`zulip remove ack react failed: ${String(err)}`);
              },
            );
          });
        }
        return;
      }
    }

    const inCommandPost =
      kind !== "dm" &&
      Boolean(
        xcaseConfig &&
        isInCommandPost({
          xcase: xcaseConfig,
          stream: sName,
          topic,
        }),
      );
    const autoTriageEnabled =
      kind !== "dm" &&
      Boolean(
        xcaseConfig &&
        shouldAutoTriage({
          xcase: xcaseConfig,
          inCommandPost,
          wasMentioned: effectiveWasMentioned,
        }),
      );
    const xLinks =
      autoTriageEnabled && xcaseConfig
        ? extractXLinks(textWithAttachments, xcaseConfig.maxLinksPerMessage ?? 3)
        : [];
    if (autoTriageEnabled && xcaseConfig && xLinks.length > 0) {
      const intakeStream = xcaseConfig.commandPostStream?.trim();
      const intakeTopic = xcaseConfig.commandPostTopic?.trim() || "command-post";
      if (!intakeStream) {
        logVerbose("zulip xcase: commandPostStream missing, skipping auto-triage");
      } else {
        const topicMode = resolveXCaseTopicMode(xcaseConfig);
        const routeKeyRaw = resolveRouteKeyFromText(textWithAttachments, xcaseConfig);
        const fallbackKey = normalizeRouteKey(xcaseConfig.defaultRoute ?? "default") || "default";
        const routeKeyCandidate = routeKeyRaw ? normalizeRouteKey(routeKeyRaw) : fallbackKey;
        const resolvedRoute = resolveRouteConfigByNormalizedKey(xcaseConfig, routeKeyCandidate);
        const routeKey = resolvedRoute?.key ?? routeKeyCandidate;
        const routeCfg = resolvedRoute?.cfg;

        const analysisStreamDefault = routeCfg?.analysisStream?.trim() || intakeStream;
        const analysisTopicSharedDefault =
          routeCfg?.analysisTopic?.trim() || (routeKey ? `x/${routeKey}` : "x/inbox");
        const expertAgentDefault =
          routeCfg?.expertAgentId?.trim() ||
          (xcaseConfig.expertAgentId?.trim() ? xcaseConfig.expertAgentId.trim() : undefined);
        const analysisPostAsAccountIdDefault = routeCfg?.postAsAccountId?.trim() || undefined;

        for (const url of xLinks) {
          const caseId = buildXCaseId(url);
          let record = xcases.get(caseId);

          if (!record) {
            const dedicatedTopic = topicMode === "always";
            const analysisTopic = dedicatedTopic
              ? buildAnalysisTopic(caseId, url)
              : analysisTopicSharedDefault;
            const expertAgentId =
              expertAgentDefault ?? chooseExpertAgentId({ config: xcaseConfig, caseId });

            record = {
              id: caseId,
              url,
              status: "open",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              originMessageId: String(msg.id),
              originStream: sName,
              originTopic: topic,
              originSenderId: senderId,
              originSenderEmail: senderEmail,
              intakeStream,
              intakeTopic,
              analysisStream: analysisStreamDefault,
              analysisTopic,
              dedicatedTopic,
              routePeerId: `${xcaseConfig.routePeerPrefix?.trim() || "xcase"}:${caseId}`,
              expertAgentId,
              routeKey,
              analysisPostAsAccountId: analysisPostAsAccountIdDefault,
            };

            xcases.set(caseId, record);
            if (record.dedicatedTopic) {
              xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), caseId);
            }
            pruneXCases();
            persistXCases();
            await upsertXCaseCard(record);
          } else {
            // Refresh record metadata (non-destructive)
            record.updatedAt = Date.now();
            record.intakeStream = record.intakeStream || intakeStream;
            record.intakeTopic = record.intakeTopic || intakeTopic;
            if (!record.routeKey) {
              record.routeKey = routeKey ?? xcaseConfig.defaultRoute ?? "default";
            }
            if (!record.analysisPostAsAccountId && analysisPostAsAccountIdDefault) {
              record.analysisPostAsAccountId = analysisPostAsAccountIdDefault;
            }
            persistXCases();
            await upsertXCaseCard(record);
          }

          if (xcaseConfig.autoAnalyzeOnCapture !== false) {
            const sourceText =
              xcaseConfig.includeMessageContext === false
                ? `URL: ${url}`
                : `${textWithAttachments}\n[zulip message id: ${msg.id}]`;
            await runXCaseAnalysis({
              record,
              sourceText,
              senderName,
              senderId,
              kind: "initial",
            });
          }
        }
      }

      if (removeAckAfterReply && ackReactionPromise) {
        void ackReactionPromise.then((didAck) => {
          if (!didAck) {
            return;
          }
          removeZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).catch(
            (err) => {
              logVerbose(`zulip remove ack react failed: ${String(err)}`);
            },
          );
        });
      }
      return;
    }

    if (
      kind !== "dm" &&
      sName &&
      topicBindingsManager &&
      topicConversationId &&
      !existingTopicBinding
    ) {
      const resolvedTopicBinding = await resolveZulipTopicSessionBinding({
        accountId: account.accountId,
        stream: sName,
        topic,
        routeSessionKey: route.sessionKey,
        agentId: route.agentId,
        touchAt: msg.timestamp ? msg.timestamp * 1000 : undefined,
      });
      sessionKey = resolvedTopicBinding.sessionKey;
    }

    core.channel.activity.record({
      channel: "zulip",
      accountId: account.accountId,
      direction: "inbound",
    });

    const roomLabel = kind === "dm" ? senderName : `#${sName} > ${topic}`;
    const fromLabel = kind === "dm" ? senderName : `${roomLabel} (${senderName})`;

    const preview = cleanText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "dm"
        ? `Zulip DM from ${senderName}`
        : `Zulip message in #${sName} > ${topic} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `zulip:message:${msg.id}`,
    });

    const to = buildReplyTo(msg);
    const textWithId = bodyForAgent;
    const topicInitialHistoryLimit = account.config.topic?.initialHistoryLimit ?? 20;
    const topicSessionPreviousTimestamp =
      kind !== "dm" && sName
        ? core.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey,
          })
        : undefined;
    const { threadHistoryBody, threadLabel, isFirstTopicTurn } = await resolveZulipTopicContext({
      client,
      kind,
      streamName: sName,
      topic,
      currentMessageId: msg.id,
      botUserId,
      initialHistoryLimit: topicInitialHistoryLimit,
      sessionPreviousTimestamp: topicSessionPreviousTimestamp,
      formatInboundEnvelope: core.channel.reply.formatInboundEnvelope,
      logVerbose,
    });
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Zulip",
      from: fromLabel,
      timestamp: msg.timestamp ? msg.timestamp * 1000 : undefined,
      body: textWithId,
      chatType: cType,
      sender: { name: senderName, id: String(senderId) },
    });

    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatInboundEnvelope({
            channel: "Zulip",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
            chatType: cType,
            senderLabel: entry.sender,
          }),
      });
    }

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyForAgent,
      RawBody: cleanText,
      CommandBody: cleanText,
      From: kind === "dm" ? `zulip:${senderId}` : `zulip:stream:${sName}:topic:${topic}`,
      To: to,
      SessionKey: sessionKey,
      AccountId: route.accountId,
      ChatType: cType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "dm" ? `${sName} > ${topic}` : undefined,
      GroupChannel: kind !== "dm" ? `#${sName}` : undefined,
      SenderName: senderName,
      SenderId: String(senderId),
      MediaPath: mediaPaths[0],
      MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      MediaType: mediaTypes[0],
      MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      MediaUrl: mediaPaths[0],
      MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
      Provider: "zulip" as const,
      Surface: "zulip" as const,
      MessageSid: String(msg.id),
      WasMentioned: kind !== "dm" ? effectiveWasMentioned : undefined,
      ThreadHistoryBody: threadHistoryBody,
      IsFirstThreadTurn: isFirstTopicTurn ? true : undefined,
      ThreadLabel: threadLabel,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "zulip" as const,
      OriginatingTo: to,
    });
    if (kind === "dm") {
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: { channel: "zulip", to, accountId: route.accountId },
      });
    }

    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", account.accountId, {
      fallbackLimit: account.textChunkLimit ?? 10000,
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });
    const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

    const typingCallbacks = createTypingCallbacks({
      start: () => sendTypingIndicator(msg),
      onStartError: (err) => {
        logTypingFailure({
          log: (m) => logger.debug?.(m),
          channel: "zulip",
          target: to,
          error: err,
        });
      },
    });

    // --- Draft streaming setup ---
    const zulipDraftStreamMode = account.config.draftStreaming ?? "off";
    const canStreamDraft = zulipDraftStreamMode !== "off";
    const draftTarget: ZulipDraftTarget | undefined = canStreamDraft
      ? msg.type === "stream"
        ? { kind: "stream", stream: sName, topic }
        : { kind: "dm", userIds: [msg.sender_id] }
      : undefined;
    const draftStream =
      canStreamDraft && draftTarget
        ? createZulipDraftStream({
            client,
            target: draftTarget,
            maxChars: textLimit,
            throttleMs: account.config.draftStreamingThrottleMs ?? 1200,
            minInitialChars: 30,
            log: logVerbose,
            warn: logVerbose,
          })
        : undefined;
    let lastPartialText = "";
    let draftText = "";
    let finalizedViaPreviewMessage = false;

    const updateDraftFromPartial = (text?: string) => {
      if (!draftStream || !text) {
        return;
      }
      if (text === lastPartialText) {
        return;
      }
      lastPartialText = text;
      if (zulipDraftStreamMode === "partial") {
        draftStream.update(text);
        return;
      }
      // "block" mode: accumulate
      draftText = text;
      draftStream.update(draftText);
    };

    const flushDraft = async () => {
      if (!draftStream) {
        return;
      }
      if (draftText) {
        draftStream.update(draftText);
      }
      await draftStream.flush();
    };

    // When draft streaming is active, suppress block streaming to avoid double-streaming.
    const disableBlockStreamingForDraft = draftStream ? true : undefined;

    const formattingMode = resolveReplyFormattingMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        responsePrefix: prefixContext.responsePrefix,
        responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload: ReplyPayload, info) => {
          const isFinal = info.kind === "final";
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const rawText = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
          const text = formatReplyForChannel(rawText, formattingMode);
          const interactiveSpec = (() => {
            const raw = payload.channelData?.zulip;
            if (!raw) {
              return null;
            }
            try {
              return readZulipComponentSpec(raw);
            } catch (err) {
              logVerbose(
                `zulip: invalid reply widget payload, falling back to text: ${String(err)}`,
              );
              return null;
            }
          })();

          if (draftStream && isFinal) {
            await flushDraft();
            const hasMedia = mediaUrls.length > 0;
            const previewMessageId = draftStream.messageId();

            // Try to finalize via preview edit (text-only, fits limit, not an error)
            if (
              !finalizedViaPreviewMessage &&
              !hasMedia &&
              typeof previewMessageId === "number" &&
              text.length <= textLimit &&
              !payload.isError
            ) {
              await draftStream.stop();
              try {
                await updateZulipMessage(client, {
                  messageId: previewMessageId,
                  content: text,
                });
                finalizedViaPreviewMessage = true;
                runtime.log?.(`delivered reply to ${to} (finalized draft preview)`);
                return;
              } catch (err) {
                logVerbose(
                  `zulip: preview final edit failed; falling back to standard send (${String(err)})`,
                );
              }
            }

            // Stop the draft stream (preserving the partial text) and fall through
            // to standard delivery.  Don't clear — "*(message cleared)*" is worse
            // than a stale preview followed by the final reply.
            if (!finalizedViaPreviewMessage) {
              await draftStream.stop();
            }
          }

          if (interactiveSpec) {
            const firstMediaUrl = mediaUrls[0];
            await sendZulipComponentMessage(to, text, interactiveSpec, {
              cfg,
              accountId: account.accountId,
              sessionKey,
              agentId: route.agentId,
              mediaUrl: firstMediaUrl,
            });
            for (const mediaUrl of mediaUrls.slice(1)) {
              await sendMessageZulip(to, "", { cfg, accountId: account.accountId, mediaUrl });
            }
            runtime.log?.(`delivered reply to ${to}`);
            return;
          }

          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) {
                continue;
              }
              await sendMessageZulip(to, chunk, { accountId: account.accountId });
            }
          } else {
            let first = true;
            for (const mediaUrl of mediaUrls) {
              const caption = first ? text : "";
              first = false;
              await sendMessageZulip(to, caption, { accountId: account.accountId, mediaUrl });
            }
          }
          runtime.log?.(`delivered reply to ${to}`);
        },
        onError: (err, info) => {
          runtime.error?.(`zulip ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
      });

    try {
      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            disableBlockStreamingForDraft ??
            (typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined),
          onModelSelected: prefixContext.onModelSelected,
          onPartialReply: draftStream
            ? (payload) => updateDraftFromPartial(payload.text)
            : undefined,
          onAssistantMessageStart: draftStream
            ? () => {
                lastPartialText = "";
                draftText = "";
              }
            : undefined,
        },
      });
    } finally {
      try {
        await draftStream?.stop();
        // Don't clear the draft on error — partial text is better than
        // "*(message cleared)*" with no follow-up reply.
      } catch (err) {
        logVerbose(`zulip: draft cleanup failed: ${String(err)}`);
      }
    }
    markDispatchIdle();

    // Log message to Convex activity feed (fire-and-forget)
    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (convexHttpUrl) {
      fetch(`${convexHttpUrl}/api/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "zulip_message",
          agentId: route.agentId,
          summary: cleanText.slice(0, 200),
          details: {
            stream: sName || undefined,
            topic: kind !== "dm" ? topic : undefined,
            sender: senderName,
            senderId: String(senderId),
            isDm: kind === "dm",
            messageId: String(msg.id),
          },
          source: "zulip",
          timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
        }),
      }).catch((err) => {
        logVerbose(`convex activity log failed: ${String(err)}`);
      });
    }

    // Remove ack reaction after reply is sent
    if (removeAckAfterReply && ackReactionPromise) {
      void ackReactionPromise.then((didAck) => {
        if (!didAck) {
          return;
        }
        removeZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).catch((err) => {
          logVerbose(`zulip remove ack react failed: ${String(err)}`);
        });
      });
    }

    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };

  // Track last processed message timestamp for replay on reconnect.
  // Persisted to disk so restarts can replay the full gap instead of losing history.
  const TIMESTAMP_FILE = path.join(ZULIP_UPLOAD_CACHE_DIR, `last-ts-${account.accountId}.json`);
  const MAX_REPLAY_MESSAGES = 100;
  const MAX_REPLAY_AGE_SECONDS = 1800; // 30 minutes

  const loadLastTimestamp = (): number => {
    try {
      if (fs.existsSync(TIMESTAMP_FILE)) {
        const data = JSON.parse(fs.readFileSync(TIMESTAMP_FILE, "utf-8"));
        if (typeof data.timestamp === "number" && data.timestamp > 0) {
          return data.timestamp;
        }
      }
    } catch {
      // Ignore read errors — replay window fallback will handle this safely.
    }
    return 0;
  };

  const saveLastTimestamp = (ts: number) => {
    try {
      fs.writeFileSync(TIMESTAMP_FILE, JSON.stringify({ timestamp: ts }));
    } catch {
      // Non-fatal — worst case we replay some extra messages
    }
  };

  let lastProcessedTimestamp = loadLastTimestamp();

  // Replay missed messages on reconnect
  const replayMissedMessages = async (): Promise<void> => {
    try {
      const cutoffTimestamp = Math.max(
        lastProcessedTimestamp,
        Math.floor(Date.now() / 1000) - MAX_REPLAY_AGE_SECONDS,
      );

      // Fetch recent messages from all public streams
      const messages = await fetchZulipMessages(client, {
        anchor: "newest",
        numBefore: MAX_REPLAY_MESSAGES,
        numAfter: 0,
        // Empty narrow = all messages the bot can see
      });

      // Filter to messages newer than cutoff, excluding bot's own messages
      const missed = messages.filter(
        (m) => m.timestamp > cutoffTimestamp && m.sender_id !== botUserId,
      );

      if (missed.length === 0) {
        logVerbose?.(`zulip: no missed messages to replay (cutoff=${cutoffTimestamp})`);
        return;
      }

      // Sort oldest first for proper ordering
      missed.sort((a, b) => a.timestamp - b.timestamp);

      runtime.log?.(`zulip: replaying ${missed.length} missed messages`);

      for (const msg of missed) {
        // Update timestamp immediately, then fire-and-forget the handler
        lastProcessedTimestamp = Math.max(lastProcessedTimestamp, msg.timestamp);
        saveLastTimestamp(lastProcessedTimestamp);
        void handleMessage(msg).catch((err) => {
          runtime.error?.(`zulip: replay handler failed: ${String(err)}`);
        });
      }
    } catch (err) {
      // Don't fail the whole reconnect if replay fails
      runtime.error?.(`zulip: message replay failed (non-fatal): ${String(err)}`);
    }
  };

  // Main event loop with reconnection
  const pollLoop = async (): Promise<void> => {
    while (!opts.abortSignal?.aborted) {
      let queueId: string;
      let lastEventId: number;

      try {
        const reg = await registerZulipQueue(client, ["message", "submessage"]);
        queueId = reg.queue_id;
        lastEventId = reg.last_event_id;
        opts.statusSink?.({ connected: true, lastConnectedAt: Date.now(), lastError: null });
        runtime.log?.(`zulip event queue registered: ${queueId}`);

        // Replay any missed messages from the disconnection window
        await replayMissedMessages();
      } catch (err) {
        opts.statusSink?.({ lastError: String(err) });
        runtime.error?.(`zulip queue registration failed: ${String(err)}`);
        await sleep(5000, opts.abortSignal);
        continue;
      }

      // Poll events from this queue
      while (!opts.abortSignal?.aborted) {
        try {
          const res = await getZulipEvents(client, queueId, lastEventId, opts.abortSignal);
          if (!res.events || res.events.length === 0) {
            continue;
          }

          for (const event of res.events) {
            lastEventId = Math.max(lastEventId, event.id);
            if (event.type === "message" && event.message) {
              // Update timestamp immediately so the poll loop isn't blocked
              if (event.message.timestamp) {
                lastProcessedTimestamp = Math.max(lastProcessedTimestamp, event.message.timestamp);
                saveLastTimestamp(lastProcessedTimestamp);
              }
              // Fire-and-forget: don't block the poll loop on message handling.
              // The lane system handles concurrency; blocking here causes the
              // entire event loop to freeze if one handler stalls (e.g. compaction).
              void handleMessage(event.message).catch((err) => {
                runtime.error?.(`zulip handler failed: ${String(err)}`);
              });
            } else if (event.type === "submessage") {
              // ocform widget callback — fire-and-forget like message events
              void handleSubmessageEvent(event as unknown as ZulipSubmessageEvent).catch((err) => {
                runtime.error?.(`zulip submessage handler failed: ${String(err)}`);
              });
            }
          }
        } catch (err) {
          const errStr = String(err);
          const errLower = errStr.toLowerCase();
          // Bad event queue ID means we need to re-register
          if (
            errLower.includes("bad_event_queue_id") ||
            errLower.includes("bad event queue") ||
            errLower.includes("queue_id")
          ) {
            runtime.log?.("zulip event queue expired, re-registering...");
            break;
          }
          if (opts.abortSignal?.aborted) {
            return;
          }
          opts.statusSink?.({
            connected: false,
            lastDisconnect: { at: Date.now(), error: errStr },
            lastError: errStr,
          });
          runtime.error?.(`zulip poll error: ${errStr}`);
          await sleep(3000, opts.abortSignal);
          break; // re-register
        }
      }

      if (!opts.abortSignal?.aborted) {
        opts.statusSink?.({ connected: false, lastDisconnect: { at: Date.now() } });
        await sleep(2000, opts.abortSignal);
      }
    }
  };

  await execApprovalsHandler?.start();
  try {
    await pollLoop();
  } finally {
    topicBindingsManager?.stop();
    await execApprovalsHandler?.stop();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
