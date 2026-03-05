/**
 * Synology Chat HTTP client.
 * Sends messages TO Synology Chat via the incoming webhook URL.
 */

import * as http from "node:http";
import * as https from "node:https";

const MIN_SEND_INTERVAL_MS = 500;
let lastSendTime = 0;

// --- Chat user_id resolution ---
// Synology Chat uses two different user_id spaces:
//   - Outgoing webhook user_id: per-integration sequential ID (e.g. 1)
//   - Chat API user_id: global internal ID (e.g. 4)
// The chatbot API (method=chatbot) requires the Chat API user_id in the
// user_ids array. We resolve via the user_list API and cache the result.

interface ChatUser {
  user_id: number;
  username: string;
  nickname: string;
}

type ChatUserCacheEntry = {
  users: ChatUser[];
  cachedAt: number;
};

// Cache user lists per bot endpoint to avoid cross-account bleed.
const chatUserCache = new Map<string, ChatUserCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Send an encoded body to Synology Chat with rate limiting and retry.
 */
async function sendWithRetry(
  url: string,
  body: string,
  allowInsecureSsl: boolean,
): Promise<boolean> {
  // Internal rate limit: min 500ms between sends
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < MIN_SEND_INTERVAL_MS) {
    await sleep(MIN_SEND_INTERVAL_MS - elapsed);
  }

  // Retry with exponential backoff (3 attempts, 300ms base)
  const maxRetries = 3;
  const baseDelay = 300;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const ok = await doPost(url, body, allowInsecureSsl);
      lastSendTime = Date.now();
      if (ok) return true;
    } catch {
      // will retry
    }

    if (attempt < maxRetries - 1) {
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }

  return false;
}

/**
 * Send a text message to Synology Chat via the incoming webhook (DM).
 *
 * @param incomingUrl - Synology Chat incoming webhook URL
 * @param text - Message text to send
 * @param userId - Optional user ID to mention with @
 * @returns true if sent successfully
 */
export async function sendMessage(
  incomingUrl: string,
  text: string,
  userId?: string | number,
  allowInsecureSsl = true,
): Promise<boolean> {
  // Synology Chat API requires user_ids (numeric) to specify the recipient
  const payloadObj: Record<string, any> = { text };
  if (userId) {
    const numericId = typeof userId === "number" ? userId : parseInt(userId, 10);
    if (!isNaN(numericId)) {
      payloadObj.user_ids = [numericId];
    }
  }
  const payload = JSON.stringify(payloadObj);
  const body = `payload=${encodeURIComponent(payload)}`;
  return sendWithRetry(incomingUrl, body, allowInsecureSsl);
}

/**
 * Send a text message to a Synology Chat channel via its incoming webhook.
 * Channel incoming webhooks don't support user_ids — the message appears as the bot.
 *
 * @param channelIncomingUrl - Channel-specific incoming webhook URL
 * @param text - Message text to send
 * @returns true if sent successfully
 */
export async function sendToChannel(
  channelIncomingUrl: string,
  text: string,
  allowInsecureSsl = false,
): Promise<boolean> {
  const payload = JSON.stringify({ text });
  const body = `payload=${encodeURIComponent(payload)}`;
  return sendWithRetry(channelIncomingUrl, body, allowInsecureSsl);
}

/**
 * Send a file URL to Synology Chat.
 */
export async function sendFileUrl(
  incomingUrl: string,
  fileUrl: string,
  userId?: string | number,
  allowInsecureSsl = true,
): Promise<boolean> {
  const payloadObj: Record<string, any> = { file_url: fileUrl };
  if (userId) {
    const numericId = typeof userId === "number" ? userId : parseInt(userId, 10);
    if (!isNaN(numericId)) {
      payloadObj.user_ids = [numericId];
    }
  }
  const payload = JSON.stringify(payloadObj);
  const body = `payload=${encodeURIComponent(payload)}`;

  try {
    const ok = await doPost(incomingUrl, body, allowInsecureSsl);
    lastSendTime = Date.now();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the list of Chat users visible to this bot via the user_list API.
 * Results are cached for CACHE_TTL_MS to avoid excessive API calls.
 *
 * The user_list endpoint uses the same base URL as the chatbot API but
 * with method=user_list instead of method=chatbot.
 */
export async function fetchChatUsers(
  incomingUrl: string,
  allowInsecureSsl = true,
  log?: { warn: (...args: unknown[]) => void },
): Promise<ChatUser[]> {
  const now = Date.now();
  const listUrl = incomingUrl.replace(/method=\w+/, "method=user_list");
  const cached = chatUserCache.get(listUrl);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.users;
  }

  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(listUrl);
    } catch {
      log?.warn("fetchChatUsers: invalid user_list URL, using cached data");
      resolve(cached?.users ?? []);
      return;
    }
    const transport = parsedUrl.protocol === "https:" ? https : http;

    transport
      .get(listUrl, { rejectUnauthorized: !allowInsecureSsl } as any, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString();
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (result.success && result.data?.users) {
              const users = result.data.users.map((u: any) => ({
                user_id: u.user_id,
                username: u.username || "",
                nickname: u.nickname || "",
              }));
              chatUserCache.set(listUrl, {
                users,
                cachedAt: now,
              });
              resolve(users);
            } else {
              log?.warn(
                `fetchChatUsers: API returned success=${result.success}, using cached data`,
              );
              resolve(cached?.users ?? []);
            }
          } catch {
            log?.warn("fetchChatUsers: failed to parse user_list response");
            resolve(cached?.users ?? []);
          }
        });
      })
      .on("error", (err) => {
        log?.warn(`fetchChatUsers: HTTP error — ${err instanceof Error ? err.message : err}`);
        resolve(cached?.users ?? []);
      });
  });
}

/**
 * Resolve a webhook username to the correct Chat API user_id.
 *
 * Synology Chat outgoing webhooks send a user_id that may NOT match the
 * Chat-internal user_id needed by the chatbot API (method=chatbot).
 * The webhook's "username" field corresponds to the Chat user's "nickname".
 *
 * @param incomingUrl - Bot incoming webhook URL (used to derive user_list URL)
 * @param webhookUsername - The username from the outgoing webhook payload
 * @param allowInsecureSsl - Skip TLS verification
 * @returns The correct Chat user_id, or undefined if not found
 */
export async function resolveChatUserId(
  incomingUrl: string,
  webhookUsername: string,
  allowInsecureSsl = true,
  log?: { warn: (...args: unknown[]) => void },
): Promise<number | undefined> {
  const users = await fetchChatUsers(incomingUrl, allowInsecureSsl, log);
  const lower = webhookUsername.toLowerCase();

  // Match by nickname first (webhook "username" field = Chat "nickname")
  const byNickname = users.find((u) => u.nickname.toLowerCase() === lower);
  if (byNickname) return byNickname.user_id;

  // Then by username
  const byUsername = users.find((u) => u.username.toLowerCase() === lower);
  if (byUsername) return byUsername.user_id;

  return undefined;
}

function doPost(url: string, body: string, allowInsecureSsl = true): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const transport = parsedUrl.protocol === "https:" ? https : http;

    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
        // Synology NAS may use self-signed certs on local network.
        // Set allowInsecureSsl: true in channel config to skip verification.
        rejectUnauthorized: !allowInsecureSsl,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve(res.statusCode === 200);
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
