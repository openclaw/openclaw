import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  registerWebhookTarget,
  rejectNonPostWebhookRequest,
  requestBodyErrorToText,
  resolveSingleWebhookTarget,
  resolveWebhookTargets,
} from "openclaw/plugin-sdk";
import {
  normalizeWebhookMessage,
  normalizeWebhookReaction,
  type NormalizedWebhookMessage,
} from "./monitor-normalize.js";
import { logVerbose, processMessage, processReaction } from "./monitor-processing.js";
import {
  _resetBlueBubblesShortIdState,
  resolveBlueBubblesMessageId,
} from "./monitor-reply-cache.js";
import {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookPath,
  resolveWebhookPathFromConfig,
  type BlueBubblesCoreRuntime,
  type BlueBubblesMonitorOptions,
  type WebhookTarget,
} from "./monitor-shared.js";
import { fetchBlueBubblesServerInfo } from "./probe.js";
import { getBlueBubblesRuntime } from "./runtime.js";

/**
 * Entry type for debouncing inbound messages.
 * Captures the normalized message and its target for later combined processing.
 */
type BlueBubblesDebounceEntry = {
  message: NormalizedWebhookMessage;
  target: WebhookTarget;
};

/**
 * Default debounce window for inbound message coalescing (ms).
 * This helps combine URL text + link preview balloon messages that BlueBubbles
 * sends as separate webhook events when no explicit inbound debounce config exists.
 */
const DEFAULT_INBOUND_DEBOUNCE_MS = 500;

/**
 * Combines multiple debounced messages into a single message for processing.
 * Used when multiple webhook events arrive within the debounce window.
 */
function combineDebounceEntries(entries: BlueBubblesDebounceEntry[]): NormalizedWebhookMessage {
  if (entries.length === 0) {
    throw new Error("Cannot combine empty entries");
  }
  if (entries.length === 1) {
    return entries[0].message;
  }

  // Use the first message as the base (typically the text message)
  const first = entries[0].message;

  // Combine text from all entries, filtering out duplicates and empty strings
  const seenTexts = new Set<string>();
  const textParts: string[] = [];

  for (const entry of entries) {
    const text = entry.message.text.trim();
    if (!text) {
      continue;
    }
    // Skip duplicate text (URL might be in both text message and balloon)
    const normalizedText = text.toLowerCase();
    if (seenTexts.has(normalizedText)) {
      continue;
    }
    seenTexts.add(normalizedText);
    textParts.push(text);
  }

  // Merge attachments from all entries
  const allAttachments = entries.flatMap((e) => e.message.attachments ?? []);

  // Use the latest timestamp
  const timestamps = entries
    .map((e) => e.message.timestamp)
    .filter((t): t is number => typeof t === "number");
  const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : first.timestamp;

  // Collect all message IDs for reference
  const messageIds = entries
    .map((e) => e.message.messageId)
    .filter((id): id is string => Boolean(id));

  // Prefer reply context from any entry that has it
  const entryWithReply = entries.find((e) => e.message.replyToId);

  return {
    ...first,
    text: textParts.join(" "),
    attachments: allAttachments.length > 0 ? allAttachments : first.attachments,
    timestamp: latestTimestamp,
    // Use first message's ID as primary (for reply reference), but we've coalesced others
    messageId: messageIds[0] ?? first.messageId,
    // Preserve reply context if present
    replyToId: entryWithReply?.message.replyToId ?? first.replyToId,
    replyToBody: entryWithReply?.message.replyToBody ?? first.replyToBody,
    replyToSender: entryWithReply?.message.replyToSender ?? first.replyToSender,
    // Clear balloonBundleId since we've combined (the combined message is no longer just a balloon)
    balloonBundleId: undefined,
  };
}

const webhookTargets = new Map<string, WebhookTarget[]>();

type BlueBubblesDebouncer = {
  enqueue: (item: BlueBubblesDebounceEntry) => Promise<void>;
  flushKey: (key: string) => Promise<void>;
};

/**
 * Maps webhook targets to their inbound debouncers.
 * Each target gets its own debouncer keyed by a unique identifier.
 */
const targetDebouncers = new Map<WebhookTarget, BlueBubblesDebouncer>();

function resolveBlueBubblesDebounceMs(
  config: OpenClawConfig,
  core: BlueBubblesCoreRuntime,
): number {
  const inbound = config.messages?.inbound;
  const hasExplicitDebounce =
    typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.bluebubbles === "number";
  if (!hasExplicitDebounce) {
    return DEFAULT_INBOUND_DEBOUNCE_MS;
  }
  return core.channel.debounce.resolveInboundDebounceMs({ cfg: config, channel: "bluebubbles" });
}

/**
 * Creates or retrieves a debouncer for a webhook target.
 */
function getOrCreateDebouncer(target: WebhookTarget) {
  const existing = targetDebouncers.get(target);
  if (existing) {
    return existing;
  }

  const { account, config, runtime, core } = target;

  const debouncer = core.channel.debounce.createInboundDebouncer<BlueBubblesDebounceEntry>({
    debounceMs: resolveBlueBubblesDebounceMs(config, core),
    buildKey: (entry) => {
      const msg = entry.message;
      // Prefer stable, shared identifiers to coalesce rapid-fire webhook events for the
      // same message (e.g., text-only then text+attachment).
      //
      // For balloons (URL previews, stickers, etc), BlueBubbles often uses a different
      // messageId than the originating text. When present, key by associatedMessageGuid
      // to keep text + balloon coalescing working.
      const balloonBundleId = msg.balloonBundleId?.trim();
      const associatedMessageGuid = msg.associatedMessageGuid?.trim();
      if (balloonBundleId && associatedMessageGuid) {
        return `bluebubbles:${account.accountId}:balloon:${associatedMessageGuid}`;
      }

      const messageId = msg.messageId?.trim();
      if (messageId) {
        return `bluebubbles:${account.accountId}:msg:${messageId}`;
      }

      const chatKey =
        msg.chatGuid?.trim() ??
        msg.chatIdentifier?.trim() ??
        (msg.chatId ? String(msg.chatId) : "dm");
      return `bluebubbles:${account.accountId}:${chatKey}:${msg.senderId}`;
    },
    shouldDebounce: (entry) => {
      const msg = entry.message;
      // Skip debouncing for from-me messages (they're just cached, not processed)
      if (msg.fromMe) {
        return false;
      }
      // Skip debouncing for control commands - process immediately
      if (core.channel.text.hasControlCommand(msg.text, config)) {
        return false;
      }
      // Debounce all other messages to coalesce rapid-fire webhook events
      // (e.g., text+image arriving as separate webhooks for the same messageId)
      return true;
    },
    onFlush: async (entries) => {
      if (entries.length === 0) {
        return;
      }

      // Use target from first entry (all entries have same target due to key structure)
      const flushTarget = entries[0].target;

      if (entries.length === 1) {
        // Single message - process normally
        await processMessage(entries[0].message, flushTarget);
        return;
      }

      // Multiple messages - combine and process
      const combined = combineDebounceEntries(entries);

      if (core.logging.shouldLogVerbose()) {
        const count = entries.length;
        const preview = combined.text.slice(0, 50);
        runtime.log?.(
          `[bluebubbles] coalesced ${count} messages: "${preview}${combined.text.length > 50 ? "..." : ""}"`,
        );
      }

      await processMessage(combined, flushTarget);
    },
    onError: (err) => {
      runtime.error?.(`[${account.accountId}] [bluebubbles] debounce flush failed: ${String(err)}`);
    },
  });

  targetDebouncers.set(target, debouncer);
  return debouncer;
}

/**
 * Removes a debouncer for a target (called during unregistration).
 */
function removeDebouncer(target: WebhookTarget): void {
  targetDebouncers.delete(target);
}

export function registerBlueBubblesWebhookTarget(target: WebhookTarget): () => void {
  const registered = registerWebhookTarget(webhookTargets, target);
  return () => {
    registered.unregister();
    // Clean up debouncer when target is unregistered
    removeDebouncer(registered.target);
  };
}

type ReadBlueBubblesWebhookBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; statusCode: number; error: string };

function parseBlueBubblesWebhookPayload(
  rawBody: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return { ok: false, error: "empty payload" };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload") ?? params.get("data") ?? params.get("message");
    if (!payload) {
      return { ok: false, error: "invalid json" };
    }
    try {
      return { ok: true, value: JSON.parse(payload) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function readBlueBubblesWebhookBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadBlueBubblesWebhookBodyResult> {
  try {
    const rawBody = await readRequestBodyWithLimit(req, {
      maxBytes,
      timeoutMs: 30_000,
    });
    const parsed = parseBlueBubblesWebhookPayload(rawBody);
    if (!parsed.ok) {
      return { ok: false, statusCode: 400, error: parsed.error };
    }
    return parsed;
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return {
        ok: false,
        statusCode: error.statusCode,
        error: requestBodyErrorToText(error.code),
      };
    }
    return {
      ok: false,
      statusCode: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function maskSecret(value: string): string {
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function normalizeAuthToken(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice("bearer ".length).trim();
  }
  return value;
}

function safeEqualSecret(aRaw: string, bRaw: string): boolean {
  const a = normalizeAuthToken(aRaw);
  const b = normalizeAuthToken(bRaw);
  if (!a || !b) {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

type ParsedWebhookEventType =
  | "new-message"
  | "updated-message"
  | "message-reaction"
  | "message-send-error"
  | "participant-added"
  | "participant-removed"
  | "participant-left"
  | "unknown";

function normalizeEventTypeToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-");
}

function resolveWebhookEventType(payload: Record<string, unknown>): {
  raw: string;
  normalized: ParsedWebhookEventType;
} {
  const dataRecord = asRecord(payload.data);
  const candidates = [
    payload.type,
    payload.event,
    payload.eventType,
    dataRecord?.type,
    dataRecord?.event,
  ];
  const raw =
    candidates
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .find((entry) => entry.length > 0) ?? "";

  const token = normalizeEventTypeToken(raw);
  const aliases = new Map<string, ParsedWebhookEventType>([
    ["new-message", "new-message"],
    ["new-messages", "new-message"],
    ["message-new", "new-message"],
    ["message-created", "new-message"],
    ["message-create", "new-message"],
    ["updated-message", "updated-message"],
    ["message-updated", "updated-message"],
    ["message-update", "updated-message"],
    ["message-updates", "updated-message"],
    ["reaction", "message-reaction"],
    ["message-reaction", "message-reaction"],
    ["message-reactions", "message-reaction"],
    ["tapback", "message-reaction"],
    ["tapback-update", "message-reaction"],
    ["message-send-error", "message-send-error"],
    ["message-send-errors", "message-send-error"],
    ["send-error", "message-send-error"],
    ["send-errors", "message-send-error"],
    ["participant-added", "participant-added"],
    ["participant-add", "participant-added"],
    ["participant-removed", "participant-removed"],
    ["participant-remove", "participant-removed"],
    ["participant-left", "participant-left"],
    ["participant-leave", "participant-left"],
  ]);

  const normalized = aliases.get(token) ?? "unknown";
  return { raw, normalized };
}

function summarizeWebhookEventPayload(payload: Record<string, unknown>): string {
  const data = asRecord(payload.data) ?? payload;
  const message = asRecord((asRecord(data)?.message as unknown) ?? data);
  const chatGuid =
    (typeof message?.chatGuid === "string" ? message.chatGuid : undefined) ??
    (typeof message?.chat_guid === "string" ? message.chat_guid : undefined);
  const messageGuid =
    (typeof message?.guid === "string" ? message.guid : undefined) ??
    (typeof message?.messageId === "string" ? message.messageId : undefined);
  const sender =
    (typeof message?.sender === "string" ? message.sender : undefined) ??
    (typeof message?.from === "string" ? message.from : undefined);
  const bits = [
    chatGuid ? `chatGuid=${chatGuid}` : "",
    messageGuid ? `messageGuid=${messageGuid}` : "",
    sender ? `sender=${sender}` : "",
  ].filter(Boolean);
  return bits.join(" ");
}

function resolveMessagesDbPath(config: OpenClawConfig): string {
  const configured = (config.channels as Record<string, unknown> | undefined)?.imessage as
    | Record<string, unknown>
    | undefined;
  const dbPathRaw = typeof configured?.dbPath === "string" ? configured.dbPath.trim() : "";
  const fallback = join(homedir(), "Library", "Messages", "chat.db");
  if (!dbPathRaw) {
    return fallback;
  }
  return dbPathRaw;
}

function looksLikeBlueBubblesGuid(value: string): boolean {
  return /^[A-Za-z0-9-]{8,128}$/.test(value);
}

function fetchEditedMessageTextFromDb(params: {
  config: OpenClawConfig;
  guid: string;
}): string | undefined {
  const guid = params.guid.trim();
  if (!guid || !looksLikeBlueBubblesGuid(guid)) {
    return undefined;
  }

  const dbPath = resolveMessagesDbPath(params.config);
  if (!existsSync(dbPath)) {
    return undefined;
  }

  const sql = `SELECT text FROM message WHERE guid='${guid}' LIMIT 1;`;
  const proc = spawnSync("sqlite3", ["-noheader", "-csv", dbPath, sql], {
    encoding: "utf8",
    timeout: 1200,
  });
  if (proc.status !== 0) {
    return undefined;
  }
  const text = (proc.stdout ?? "").trim();
  return text || undefined;
}

function shouldIgnoreUpdatedNonConversationalEvent(
  eventType: ParsedWebhookEventType,
  message: NormalizedWebhookMessage,
): boolean {
  if (eventType !== "updated-message") {
    return false;
  }
  const text = message.text.trim();
  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  if (hasAttachments) {
    return false;
  }

  // Some BlueBubbles update events (e.g., Kept / playback updates) can surface as
  // non-conversational payloads with GUID-like text. They should never trigger replies.
  if (text && looksLikeBlueBubblesGuid(text)) {
    return true;
  }

  // Empty updated-message rows without edits/reactions are non-conversational updates.
  if (
    !text &&
    !message.dateEdited &&
    !message.associatedMessageGuid &&
    typeof message.associatedMessageType !== "number"
  ) {
    return true;
  }

  return false;
}

function shouldResolveUpdatedEditText(
  eventType: ParsedWebhookEventType,
  message: NormalizedWebhookMessage,
): boolean {
  if (eventType !== "updated-message") {
    return false;
  }
  if (!message.messageId?.trim()) {
    return false;
  }
  if (message.text.trim()) {
    return false;
  }
  if ((message.itemType ?? -1) !== 0) {
    return false;
  }
  return typeof message.dateEdited === "number" && message.dateEdited > 0;
}

function hasExplicitChatContext(message: NormalizedWebhookMessage): boolean {
  const hasChatGuid = Boolean(message.chatGuid?.trim());
  const hasChatIdentifier = Boolean(message.chatIdentifier?.trim());
  const hasChatId = typeof message.chatId === "number" && Number.isFinite(message.chatId);
  return Boolean(
    hasChatGuid ||
    hasChatIdentifier ||
    hasChatId ||
    message.hasConversationLabel ||
    message.hasExplicitGroupChatFlag ||
    message.hasMessageIdFull,
  );
}

function shouldDropMentionOnlyDirectPayload(message: NormalizedWebhookMessage): boolean {
  if (message.isGroup) {
    return false;
  }
  if (message.explicitWasMentioned !== true) {
    return false;
  }
  return !hasExplicitChatContext(message);
}

export async function handleBlueBubblesWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const resolved = resolveWebhookTargets(req, webhookTargets);
  if (!resolved) {
    return false;
  }
  const { path, targets } = resolved;
  const url = new URL(req.url ?? "/", "http://localhost");

  if (rejectNonPostWebhookRequest(req, res)) {
    return true;
  }

  const body = await readBlueBubblesWebhookBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.statusCode;
    res.end(body.error ?? "invalid payload");
    console.warn(`[bluebubbles] webhook rejected: ${body.error ?? "invalid payload"}`);
    return true;
  }

  const payload = asRecord(body.value) ?? {};
  const firstTarget = targets[0];
  if (firstTarget) {
    logVerbose(
      firstTarget.core,
      firstTarget.runtime,
      `webhook received path=${path} keys=${Object.keys(payload).join(",") || "none"}`,
    );
  }
  const parsedEvent = resolveWebhookEventType(payload);
  const eventType = parsedEvent.normalized;
  const eventSummary = summarizeWebhookEventPayload(payload);

  // Deterministic ignore path for known non-message event families.
  if (
    eventType === "message-send-error" ||
    eventType === "participant-added" ||
    eventType === "participant-removed" ||
    eventType === "participant-left"
  ) {
    res.statusCode = 200;
    res.end("ok");
    if (firstTarget) {
      const suffix = eventSummary ? ` ${eventSummary}` : "";
      logVerbose(
        firstTarget.core,
        firstTarget.runtime,
        `webhook accepted event=${eventType}${suffix}`,
      );
    }
    return true;
  }

  const reaction = normalizeWebhookReaction(payload);
  const message = reaction ? null : normalizeWebhookMessage(payload);

  // For updated-message/reaction events, missing parsable reaction should not be noisy.
  if (eventType === "message-reaction" && !reaction) {
    res.statusCode = 200;
    res.end("ok");
    if (firstTarget) {
      logVerbose(
        firstTarget.core,
        firstTarget.runtime,
        `webhook ignored message-reaction without parsable tapback${eventSummary ? ` ${eventSummary}` : ""}`,
      );
    }
    return true;
  }

  // Unknown payload families are acknowledged but ignored to avoid "could not parse" noise.
  if (!message && !reaction) {
    res.statusCode = 200;
    res.end("ok");
    if (firstTarget) {
      const rawType = parsedEvent.raw || "none";
      logVerbose(
        firstTarget.core,
        firstTarget.runtime,
        `webhook ignored unparsed type=${eventType} rawType=${rawType} keys=${Object.keys(payload).join(",") || "none"}${eventSummary ? ` ${eventSummary}` : ""}`,
      );
    }
    return true;
  }

  const guidParam = url.searchParams.get("guid") ?? url.searchParams.get("password");
  const headerToken =
    req.headers["x-guid"] ??
    req.headers["x-password"] ??
    req.headers["x-bluebubbles-guid"] ??
    req.headers["authorization"];
  const guid = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? guidParam ?? "";
  const matchedTarget = resolveSingleWebhookTarget(targets, (target) => {
    const token = target.account.config.password?.trim() ?? "";
    return safeEqualSecret(guid, token);
  });

  if (matchedTarget.kind === "none") {
    res.statusCode = 401;
    res.end("unauthorized");
    console.warn(
      `[bluebubbles] webhook rejected: unauthorized guid=${maskSecret(url.searchParams.get("guid") ?? url.searchParams.get("password") ?? "")}`,
    );
    return true;
  }

  if (matchedTarget.kind === "ambiguous") {
    res.statusCode = 401;
    res.end("ambiguous webhook target");
    console.warn(`[bluebubbles] webhook rejected: ambiguous target match path=${path}`);
    return true;
  }

  const target = matchedTarget.target;
  target.statusSink?.({ lastInboundAt: Date.now() });
  if (reaction) {
    processReaction(reaction, target).catch((err) => {
      target.runtime.error?.(
        `[${target.account.accountId}] BlueBubbles reaction failed: ${String(err)}`,
      );
    });
  } else if (message) {
    let hydratedMessage = message;

    if (shouldIgnoreUpdatedNonConversationalEvent(eventType, hydratedMessage)) {
      if (firstTarget) {
        logVerbose(
          firstTarget.core,
          firstTarget.runtime,
          `webhook ignored updated-message non-conversational payload guid=${hydratedMessage.messageId ?? ""} text=${hydratedMessage.text.trim().slice(0, 80)}`,
        );
      }
      res.statusCode = 200;
      res.end("ok");
      return true;
    }

    if (shouldResolveUpdatedEditText(eventType, hydratedMessage)) {
      const editedText = fetchEditedMessageTextFromDb({
        config: target.config,
        guid: hydratedMessage.messageId ?? "",
      });
      if (editedText) {
        hydratedMessage = { ...hydratedMessage, text: editedText };
        logVerbose(
          target.core,
          target.runtime,
          `webhook hydrated updated-message text guid=${hydratedMessage.messageId} itemType=${hydratedMessage.itemType ?? ""}`,
        );
      }
    }

    if (shouldDropMentionOnlyDirectPayload(hydratedMessage)) {
      logVerbose(
        target.core,
        target.runtime,
        `webhook dropped ambiguous mention-only direct payload sender=${hydratedMessage.senderId} msg=${hydratedMessage.messageId ?? ""}`,
      );
      res.statusCode = 200;
      res.end("ok");
      return true;
    }

    // Route messages through debouncer to coalesce rapid-fire events
    // (e.g., text message + URL balloon arriving as separate webhooks)
    const debouncer = getOrCreateDebouncer(target);
    debouncer.enqueue({ message: hydratedMessage, target }).catch((err) => {
      target.runtime.error?.(
        `[${target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`,
      );
    });
  }

  res.statusCode = 200;
  res.end("ok");
  if (reaction) {
    if (firstTarget) {
      logVerbose(
        firstTarget.core,
        firstTarget.runtime,
        `webhook accepted reaction sender=${reaction.senderId} msg=${reaction.messageId} action=${reaction.action}`,
      );
    }
  } else if (message) {
    if (firstTarget) {
      logVerbose(
        firstTarget.core,
        firstTarget.runtime,
        `webhook accepted sender=${message.senderId} group=${message.isGroup} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`,
      );
    }
  }
  return true;
}

export async function monitorBlueBubblesProvider(
  options: BlueBubblesMonitorOptions,
): Promise<void> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getBlueBubblesRuntime();
  const path = options.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH;

  // Fetch and cache server info (for macOS version detection in action gating)
  const serverInfo = await fetchBlueBubblesServerInfo({
    baseUrl: account.baseUrl,
    password: account.config.password,
    accountId: account.accountId,
    timeoutMs: 5000,
  }).catch(() => null);
  if (serverInfo?.os_version) {
    runtime.log?.(`[${account.accountId}] BlueBubbles server macOS ${serverInfo.os_version}`);
  }
  if (typeof serverInfo?.private_api === "boolean") {
    runtime.log?.(
      `[${account.accountId}] BlueBubbles Private API ${serverInfo.private_api ? "enabled" : "disabled"}`,
    );
  }

  const unregister = registerBlueBubblesWebhookTarget({
    account,
    config,
    runtime,
    core,
    path,
    statusSink,
  });

  return await new Promise((resolve) => {
    const stop = () => {
      unregister();
      resolve();
    };

    if (abortSignal?.aborted) {
      stop();
      return;
    }

    abortSignal?.addEventListener("abort", stop, { once: true });
    runtime.log?.(
      `[${account.accountId}] BlueBubbles webhook listening on ${normalizeWebhookPath(path)}`,
    );
  });
}

export { _resetBlueBubblesShortIdState, resolveBlueBubblesMessageId, resolveWebhookPathFromConfig };
