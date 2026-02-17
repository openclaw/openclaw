import { createHash, createDecipheriv } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createDedupeCache } from "openclaw/plugin-sdk";
// ---------------------------------------------------------------------------
// Message deduplication
// ---------------------------------------------------------------------------
import { handlePrivateChatMessage, handleGroupChatMessage } from "./bot.js";
import type { ResolvedInfoflowAccount } from "./channel.js";
import { getInfoflowParseLog } from "./logging.js";

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEDUP_MAX_SIZE = 1000;

const messageCache = createDedupeCache({
  ttlMs: DEDUP_TTL_MS,
  maxSize: DEDUP_MAX_SIZE,
});

/**
 * Extracts a dedup key from the decrypted message data.
 *
 * Priority:
 *   1. message.header.messageid || message.header.msgid || MsgId
 *   2. fallback: "{fromuserid}_{groupid}_{ctime}"
 */
function extractDedupeKey(msgData: Record<string, unknown>): string | null {
  const message = msgData.message as Record<string, unknown> | undefined;
  const header = (message?.header ?? {}) as Record<string, unknown>;

  // Priority 1: explicit message ID
  const msgId = header.messageid ?? header.msgid ?? msgData.MsgId;
  if (msgId != null) {
    return String(msgId);
  }

  // Priority 2: composite key
  const fromuserid = header.fromuserid ?? msgData.FromUserId ?? msgData.fromuserid;
  const groupid = msgData.groupid ?? header.groupid;
  const ctime = header.ctime ?? Date.now();
  if (fromuserid != null) {
    return `${fromuserid}_${groupid ?? "dm"}_${ctime}`;
  }

  return null;
}

/**
 * Returns true if the message is a duplicate (already seen within TTL).
 * Uses shared dedupe cache implementation.
 */
function isDuplicateMessage(msgData: Record<string, unknown>): boolean {
  const key = extractDedupeKey(msgData);
  if (!key) return false; // Cannot extract key, allow through

  return messageCache.check(key);
}

/**
 * Records a sent message ID in the dedup cache.
 * Called after successfully sending a message to prevent
 * the bot from processing its own outbound messages as inbound.
 */
export function recordSentMessageId(messageId: string | number): void {
  if (messageId == null) return;
  messageCache.check(String(messageId)); // Will record if not duplicate
}

// ---------------------------------------------------------------------------
// AES-ECB Decryption Utilities
// ---------------------------------------------------------------------------

/**
 * Decodes a Base64 URLSafe encoded string to a Buffer.
 * Handles the URL-safe alphabet (- → +, _ → /) and auto-pads with '='.
 */
function base64UrlSafeDecode(s: string): Buffer {
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + "=".repeat(padLen), "base64");
}

/**
 * Decrypts an AES-ECB encrypted message.
 * @param encryptedMsg - Base64 URLSafe encoded ciphertext
 * @param encodingAESKey - Base64 URLSafe encoded AES key (supports 16/24/32 byte keys)
 * @returns Decrypted UTF-8 string
 */
function decryptMessage(encryptedMsg: string, encodingAESKey: string): string {
  const aesKey = base64UrlSafeDecode(encodingAESKey);
  const cipherText = base64UrlSafeDecode(encryptedMsg);

  // Select AES algorithm based on key length
  let algorithm: string;
  switch (aesKey.length) {
    case 16:
      algorithm = "aes-128-ecb";
      break;
    case 24:
      algorithm = "aes-192-ecb";
      break;
    case 32:
      algorithm = "aes-256-ecb";
      break;
    default:
      throw new Error(`Invalid AES key length: ${aesKey.length} bytes (expected 16, 24, or 32)`);
  }

  // ECB mode does not use an IV (pass null)
  const decipher = createDecipheriv(algorithm, aesKey, null);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Parses an XML message string into a key-value object.
 * Handles simple XML structures like <xml><Tag>value</Tag></xml>.
 */
function parseXmlMessage(xmlString: string): Record<string, string> | null {
  try {
    const result: Record<string, string> = {};
    // Match <TagName>content</TagName> patterns
    const tagRegex = /<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
    let match;
    while ((match = tagRegex.exec(xmlString)) !== null) {
      const tagName = match[1];
      // CDATA content or plain text content
      const content = match[2] ?? match[3] ?? "";
      result[tagName] = content.trim();
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InfoflowCoreRuntime = {
  logging: { shouldLogVerbose(): boolean };
};

export type WebhookTarget = {
  account: ResolvedInfoflowAccount;
  config: OpenClawConfig;
  core: InfoflowCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type ParseResult = { handled: true; statusCode: number; body: string } | { handled: false };

// ---------------------------------------------------------------------------
// Body readers
// ---------------------------------------------------------------------------

const MAX_BODY_SIZE = 20 * 1024 * 1024; // 20 MB

/** Load raw body as a string from the request stream; enforces max size. */
export async function loadRawBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_SIZE,
): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let done = false;
  return await new Promise((resolve) => {
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({ ok: true, raw });
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses and dispatches an incoming Infoflow webhook request.
 *
 * 1. Parses Content-Type header once.
 * 2. form-urlencoded:
 *    - echostr present → signature verification → 200/403
 *    - messageJson present → private chat (dm) handling
 * 3. text/plain → group chat handling (raw body is encrypted ciphertext)
 * 4. Other Content-Type → 400
 *
 * Returns a ParseResult indicating whether the request was handled and the response to send.
 *
 * NOTE: Only echostr has signature verification; message webhooks use AES-ECB mode.
 * This is an Infoflow API constraint. This mode will not be modified until the service is upgraded.
 */
export async function parseAndDispatchInfoflowRequest(
  req: IncomingMessage,
  rawBody: string,
  targets: WebhookTarget[],
): Promise<ParseResult> {
  const verbose = targets[0]?.core?.logging?.shouldLogVerbose?.() ?? false;
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();

  if (verbose) {
    getInfoflowParseLog().debug?.(
      `[infoflow] parseAndDispatch: contentType=${contentType}, bodyLen=${rawBody.length}`,
    );
  }

  // --- form-urlencoded: echostr verification + private chat ---
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(rawBody);

    // echostr signature verification (try all accounts' tokens for multi-account support)
    const echostr = form.get("echostr") ?? "";
    if (echostr) {
      const signature = form.get("signature") ?? "";
      const timestamp = form.get("timestamp") ?? "";
      const rn = form.get("rn") ?? "";
      for (const target of targets) {
        const checkToken = target.account.config.checkToken ?? "";
        if (!checkToken) continue;
        const expectedSig = createHash("md5")
          .update(`${rn}${timestamp}${checkToken}`)
          .digest("hex");
        if (signature === expectedSig) {
          if (verbose) {
            getInfoflowParseLog().debug?.(`[infoflow] echostr verified successfully`);
          }
          return { handled: true, statusCode: 200, body: echostr };
        }
      }
      getInfoflowParseLog().error(`[infoflow] echostr signature mismatch`);
      return { handled: true, statusCode: 403, body: "Invalid signature" };
    }

    // private chat message (messageJson field in form)
    const messageJsonStr = form.get("messageJson") ?? "";
    if (messageJsonStr) {
      return handlePrivateMessage(messageJsonStr, targets, verbose);
    }

    getInfoflowParseLog().error(`[infoflow] form-urlencoded but missing echostr or messageJson`);
    return { handled: true, statusCode: 400, body: "missing echostr or messageJson" };
  }

  // --- text/plain: group chat ---
  if (contentType.startsWith("text/plain")) {
    return handleGroupMessage(rawBody, targets, verbose);
  }

  // --- unsupported Content-Type ---
  getInfoflowParseLog().error(`[infoflow] unsupported contentType: ${contentType}`);
  return { handled: true, statusCode: 400, body: "unsupported content type" };
}

// ---------------------------------------------------------------------------
// Shared decrypt-and-dispatch helper
// ---------------------------------------------------------------------------

type DecryptDispatchParams = {
  encryptedContent: string;
  targets: WebhookTarget[];
  chatType: "direct" | "group";
  verbose: boolean;
  fallbackParser?: (content: string) => Record<string, unknown> | null;
  /** Async handler to process the decrypted message. Errors are caught internally. */
  dispatchFn: (target: WebhookTarget, msgData: Record<string, unknown>) => Promise<void>;
};

/**
 * Shared helper to decrypt message content and dispatch to handler.
 * Iterates through accounts, attempts decryption, parses content, checks for duplicates.
 * Dispatches asynchronously (fire-and-forget) with centralized error logging.
 */
function tryDecryptAndDispatch(params: DecryptDispatchParams): ParseResult {
  const { encryptedContent, targets, chatType, verbose, fallbackParser, dispatchFn } = params;

  if (targets.length === 0) {
    getInfoflowParseLog().error(`[infoflow] ${chatType}: no target configured`);
    return { handled: true, statusCode: 500, body: "no target configured" };
  }

  if (!encryptedContent.trim()) {
    getInfoflowParseLog().error(`[infoflow] ${chatType}: empty encrypted content`);
    return { handled: true, statusCode: 400, body: "empty content" };
  }

  if (verbose) {
    getInfoflowParseLog().debug?.(
      `[infoflow] ${chatType}: trying ${targets.length} account(s) for decryption`,
    );
  }

  for (const target of targets) {
    const { encodingAESKey } = target.account.config;
    if (!encodingAESKey) continue;

    let decryptedContent: string;
    try {
      decryptedContent = decryptMessage(encryptedContent, encodingAESKey);
    } catch {
      continue; // Try next account
    }

    // Parse as JSON first, then try fallback parser (XML for private)
    let msgData: Record<string, unknown> | null = null;
    try {
      msgData = JSON.parse(decryptedContent) as Record<string, unknown>;
    } catch {
      if (fallbackParser) {
        msgData = fallbackParser(decryptedContent);
      }
    }

    if (msgData && Object.keys(msgData).length > 0) {
      if (isDuplicateMessage(msgData)) {
        if (verbose) {
          getInfoflowParseLog().debug?.(`[infoflow] ${chatType}: duplicate message, skipping`);
        }
        return { handled: true, statusCode: 200, body: "success" };
      }

      target.statusSink?.({ lastInboundAt: Date.now() });

      // Fire-and-forget with centralized error handling
      void dispatchFn(target, msgData).catch((err) => {
        getInfoflowParseLog().error(
          `[infoflow] ${chatType} handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      if (verbose) {
        getInfoflowParseLog().debug?.(`[infoflow] ${chatType}: message dispatched successfully`);
      }
      return { handled: true, statusCode: 200, body: "success" };
    }
  }

  getInfoflowParseLog().error(`[infoflow] ${chatType}: decryption failed for all accounts`);
  return { handled: true, statusCode: 500, body: "decryption failed for all accounts" };
}

// ---------------------------------------------------------------------------
// Private chat handler
// ---------------------------------------------------------------------------

/**
 * Handles a private (dm) chat message.
 * Decrypts the Encrypt field with encodingAESKey (AES-ECB),
 * parses the decrypted content, then dispatches to bot.ts.
 */
function handlePrivateMessage(
  messageJsonStr: string,
  targets: WebhookTarget[],
  verbose: boolean,
): ParseResult {
  let messageJson: Record<string, unknown>;
  try {
    messageJson = JSON.parse(messageJsonStr) as Record<string, unknown>;
  } catch {
    getInfoflowParseLog().error(`[infoflow] private: invalid messageJson`);
    return { handled: true, statusCode: 400, body: "invalid messageJson" };
  }

  const encrypt = typeof messageJson.Encrypt === "string" ? messageJson.Encrypt : "";
  if (!encrypt) {
    getInfoflowParseLog().error(`[infoflow] private: missing Encrypt field`);
    return { handled: true, statusCode: 400, body: "missing Encrypt field in messageJson" };
  }

  return tryDecryptAndDispatch({
    encryptedContent: encrypt,
    targets,
    chatType: "direct",
    verbose,
    fallbackParser: parseXmlMessage,
    dispatchFn: (target, msgData) =>
      handlePrivateChatMessage({
        cfg: target.config,
        msgData,
        accountId: target.account.accountId,
        statusSink: target.statusSink,
      }),
  });
}

// ---------------------------------------------------------------------------
// Group chat handler
// ---------------------------------------------------------------------------

/**
 * Handles a group chat message.
 * The rawBody itself is an AES-encrypted ciphertext (Base64URLSafe encoded).
 * Decrypts and dispatches to bot.ts.
 */
function handleGroupMessage(
  rawBody: string,
  targets: WebhookTarget[],
  verbose: boolean,
): ParseResult {
  return tryDecryptAndDispatch({
    encryptedContent: rawBody,
    targets,
    chatType: "group",
    verbose,
    dispatchFn: (target, msgData) =>
      handleGroupChatMessage({
        cfg: target.config,
        msgData,
        accountId: target.account.accountId,
        statusSink: target.statusSink,
      }),
  });
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal — not part of the public API)
// ---------------------------------------------------------------------------

/** @internal */
export const _extractDedupeKey = extractDedupeKey;

/** @internal */
export const _isDuplicateMessage = isDuplicateMessage;

/** @internal */
export const _base64UrlSafeDecode = base64UrlSafeDecode;

/** @internal */
export const _decryptMessage = decryptMessage;

/** @internal */
export const _parseXmlMessage = parseXmlMessage;

/** @internal — Clears the message dedup cache. Only use in tests. */
export function _resetMessageCache(): void {
  messageCache.clear();
}
