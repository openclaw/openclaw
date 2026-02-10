import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createHash, createDecipheriv } from "node:crypto";
import type { ResolvedInfoflowAccount } from "./channel.js";
import { handlePrivateChatMessage, handleGroupChatMessage } from "./bot.js";

// ---------------------------------------------------------------------------
// Message deduplication
// ---------------------------------------------------------------------------

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEDUP_MAX_SIZE = 1000;

const messageCache = new Map<string, number>(); // key → timestamp

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
 * If new, records it in cache. Prunes expired + oversized entries.
 */
function isDuplicateMessage(msgData: Record<string, unknown>): boolean {
  const key = extractDedupeKey(msgData);
  if (!key) return false; // 无法提取 key 则放行

  const now = Date.now();

  // Check existing
  const existing = messageCache.get(key);
  if (existing !== undefined && now - existing < DEDUP_TTL_MS) {
    return true;
  }

  // Record new
  messageCache.delete(key); // 确保插入到 Map 尾部
  messageCache.set(key, now);

  // Prune expired
  for (const [k, ts] of messageCache) {
    if (now - ts >= DEDUP_TTL_MS) {
      messageCache.delete(k);
    } else {
      break; // Map 按插入顺序，后面的更新
    }
  }

  // Prune oversized
  while (messageCache.size > DEDUP_MAX_SIZE) {
    const oldest = messageCache.keys().next().value;
    if (oldest) messageCache.delete(oldest);
    else break;
  }

  return false;
}

/**
 * Records a sent message ID in the dedup cache.
 * Called after successfully sending a message to prevent
 * the bot from processing its own outbound messages as inbound.
 */
export function recordSentMessageId(messageId: string | number): void {
  if (messageId == null) return;
  const key = String(messageId);
  const now = Date.now();

  messageCache.delete(key);
  messageCache.set(key, now);

  // Prune oversized
  while (messageCache.size > DEDUP_MAX_SIZE) {
    const oldest = messageCache.keys().next().value;
    if (oldest) messageCache.delete(oldest);
    else break;
  }
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

export type ParsedInfoflowMessage = {
  fromuser: string;
  mes: string;
  chatType: "dm" | "group";
};

export type ParseResult = { handled: true; statusCode: number; body: string } | { handled: false };

// ---------------------------------------------------------------------------
// Body readers
// ---------------------------------------------------------------------------

const MAX_BODY_SIZE = 20 * 1024 * 1024; // 20 MB

/** Reads raw body as a string from the request stream; enforces max size. */
export async function readRawBody(
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
 */
export async function parseAndDispatchInfoflowRequest(
  req: IncomingMessage,
  rawBody: string,
  targets: WebhookTarget[],
): Promise<ParseResult> {
  const verbose = targets[0]?.core?.logging?.shouldLogVerbose?.() ?? false;

  // --- 1. Parse all needed headers once ---
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();

  if (verbose) {
    console.log(
      `[infoflow] parseAndDispatch: contentType=${contentType}, bodyLen=${rawBody.length}`,
    );
  }

  // --- 2. form-urlencoded: echostr verification + private chat ---
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    if (verbose) {
      console.log(`[infoflow] handling form-urlencoded request`);
    }
    const form = new URLSearchParams(rawBody);

    // 2a. echostr signature verification (try all accounts' tokens for multi-account support)
    const echostr = form.get("echostr") ?? "";
    if (echostr) {
      if (verbose) {
        console.log(`[infoflow] echostr verification request`);
      }
      const signature = form.get("signature") ?? "";
      const timestamp = form.get("timestamp") ?? "";
      const rn = form.get("rn") ?? "";
      for (const target of targets) {
        const checkToken = target.account.config.check_token ?? "";
        if (!checkToken) continue;
        const expectedSig = createHash("md5")
          .update(`${rn}${timestamp}${checkToken}`)
          .digest("hex");
        if (signature === expectedSig) {
          if (verbose) {
            console.log(`[infoflow] echostr verified, returning echostr`);
          }
          return { handled: true, statusCode: 200, body: echostr };
        }
      }
      console.error(`[infoflow] echostr signature mismatch`);
      return { handled: true, statusCode: 403, body: "Invalid signature" };
    }

    // 2b. private chat message (messageJson field in form)
    const messageJsonStr = form.get("messageJson") ?? "";
    if (messageJsonStr) {
      if (verbose) {
        console.log(`[infoflow] private chat message detected, dispatching...`);
      }
      return handlePrivateMessage(messageJsonStr, targets, verbose);
    }

    console.error(`[infoflow] form-urlencoded but missing echostr or messageJson`);
    return { handled: true, statusCode: 400, body: "missing echostr or messageJson" };
  }

  // --- 3. text/plain: group chat ---
  if (contentType.startsWith("text/plain")) {
    if (verbose) {
      console.log(`[infoflow] group chat message detected, dispatching...`);
    }
    return handleGroupMessage(rawBody, targets, verbose);
  }

  // --- 4. unsupported Content-Type ---
  console.error(`[infoflow] unsupported contentType: ${contentType}`);
  return { handled: true, statusCode: 400, body: "unsupported content type" };
}

// ---------------------------------------------------------------------------
// Private chat handler
// ---------------------------------------------------------------------------

/**
 * Handles a private (dm) chat message.
 *
 * messageJsonStr is the value of the `messageJson` form field,
 * a JSON string in the shape `{ Encrypt: "..." }`.
 *
 * Decrypts the Encrypt field with encodingAESKey (AES-ECB),
 * parses the decrypted content, then dispatches to bot.ts.
 */
function handlePrivateMessage(
  messageJsonStr: string,
  targets: WebhookTarget[],
  verbose: boolean,
): ParseResult {
  if (targets.length === 0) {
    console.error(`[infoflow] private: no target configured`);
    return { handled: true, statusCode: 500, body: "no target configured" };
  }

  let messageJson: Record<string, unknown>;
  try {
    messageJson = JSON.parse(messageJsonStr) as Record<string, unknown>;
  } catch {
    console.error(`[infoflow] private: invalid messageJson`);
    return { handled: true, statusCode: 400, body: "invalid messageJson" };
  }

  const encrypt = typeof messageJson.Encrypt === "string" ? messageJson.Encrypt : "";
  if (!encrypt) {
    console.error(`[infoflow] private: missing Encrypt field`);
    return { handled: true, statusCode: 400, body: "missing Encrypt field in messageJson" };
  }

  if (verbose) {
    console.log(`[infoflow] private: trying ${targets.length} account(s) for decryption`);
  }

  // Try each account's key until decryption succeeds (multi-account support)
  for (const target of targets) {
    const { encodingAESKey } = target.account.config;
    if (!encodingAESKey) {
      if (verbose) {
        console.log(`[infoflow] private: account ${target.account.accountId} has no AES key, skip`);
      }
      continue;
    }

    let decryptedContent: string;
    try {
      decryptedContent = decryptMessage(encrypt, encodingAESKey);
      if (verbose) {
        console.log(
          `[infoflow] private: decryption success for account ${target.account.accountId}`,
        );
      }
    } catch (err) {
      if (verbose) {
        console.log(
          `[infoflow] private: decryption failed for account ${target.account.accountId}: ${String(err)}`,
        );
      }
      continue; // Try next account
    }

    // Parse decrypted content as JSON or XML
    let msgData: Record<string, unknown> | null = null;
    try {
      msgData = JSON.parse(decryptedContent) as Record<string, unknown>;
      if (verbose) {
        console.log(`[infoflow] private: parsed as JSON`);
      }
    } catch {
      msgData = parseXmlMessage(decryptedContent);
      if (verbose) {
        console.log(`[infoflow] private: parsed as XML, result=${msgData ? "ok" : "null"}`);
      }
    }

    if (msgData && Object.keys(msgData).length > 0) {
      if (isDuplicateMessage(msgData)) {
        if (verbose) {
          console.log(`[infoflow] private: duplicate message, skipping`);
        }
        return { handled: true, statusCode: 200, body: "success" };
      }

      if (verbose) {
        console.log(`[infoflow] private: dispatching to handlePrivateChatMessage`);
      }

      target.statusSink?.({ lastInboundAt: Date.now() });

      void handlePrivateChatMessage({
        cfg: target.config,
        msgData,
        accountId: target.account.accountId,
        statusSink: target.statusSink,
      });

      return { handled: true, statusCode: 200, body: "success" };
    }
  }

  console.error(`[infoflow] private: decryption failed for all accounts`);
  return { handled: true, statusCode: 500, body: "decryption failed for all accounts" };
}

// ---------------------------------------------------------------------------
// Group chat handler
// ---------------------------------------------------------------------------

/**
 * Handles a group chat message.
 *
 * The rawBody itself is an AES-encrypted ciphertext (Base64URLSafe encoded).
 * After decryption it yields a JSON object with group message fields.
 *
 * Decrypts rawBody with encodingAESKey (AES-ECB),
 * parses the result, then dispatches to bot.ts.
 */
function handleGroupMessage(
  rawBody: string,
  targets: WebhookTarget[],
  verbose: boolean,
): ParseResult {
  if (targets.length === 0) {
    console.error(`[infoflow] group: no target configured`);
    return { handled: true, statusCode: 500, body: "no target configured" };
  }
  if (!rawBody.trim()) {
    console.error(`[infoflow] group: empty body`);
    return { handled: true, statusCode: 400, body: "empty body" };
  }

  if (verbose) {
    console.log(`[infoflow] group: trying ${targets.length} account(s) for decryption`);
  }

  // Try each account's key until decryption succeeds (multi-account support)
  for (const target of targets) {
    const { encodingAESKey } = target.account.config;
    if (!encodingAESKey) {
      if (verbose) {
        console.log(`[infoflow] group: account ${target.account.accountId} has no AES key, skip`);
      }
      continue;
    }

    let decryptedContent: string;
    try {
      decryptedContent = decryptMessage(rawBody, encodingAESKey);
      if (verbose) {
        console.log(`[infoflow] group: decryption success for account ${target.account.accountId}`);
      }
    } catch (err) {
      if (verbose) {
        console.log(
          `[infoflow] group: decryption failed for account ${target.account.accountId}: ${String(err)}`,
        );
      }
      continue; // Try next account
    }

    let msgData: Record<string, unknown>;
    try {
      msgData = JSON.parse(decryptedContent) as Record<string, unknown>;
      if (verbose) {
        console.log(`[infoflow] group: parsed JSON successfully`);
      }
    } catch (err) {
      if (verbose) {
        console.log(`[infoflow] group: JSON parse failed: ${String(err)}`);
      }
      continue; // Try next account
    }

    if (msgData && Object.keys(msgData).length > 0) {
      if (isDuplicateMessage(msgData)) {
        if (verbose) {
          console.log(`[infoflow] group: duplicate message, skipping`);
        }
        return { handled: true, statusCode: 200, body: "success" };
      }

      if (verbose) {
        console.log(`[infoflow] group: dispatching to handleGroupChatMessage`);
      }

      target.statusSink?.({ lastInboundAt: Date.now() });

      void handleGroupChatMessage({
        cfg: target.config,
        msgData,
        accountId: target.account.accountId,
        statusSink: target.statusSink,
      });

      return { handled: true, statusCode: 200, body: "success" };
    }
  }

  console.error(`[infoflow] group: decryption failed for all accounts`);
  return { handled: true, statusCode: 500, body: "decryption failed for all accounts" };
}
