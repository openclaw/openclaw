/**
 * Synology Chat HTTP client.
 * Sends messages TO Synology Chat via the incoming webhook URL.
 */

import * as http from "node:http";
import * as https from "node:https";

const MIN_SEND_INTERVAL_MS = 500;
let lastSendTime = 0;

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 300;

/**
 * Shared send infrastructure: rate-limit, retry with exponential backoff, POST.
 *
 * @param url - Webhook URL to POST to
 * @param payloadObj - JSON payload object (will be stringified and form-encoded)
 * @param allowInsecureSsl - Skip TLS verification (for self-signed NAS certs)
 * @returns true if sent successfully
 */
async function sendWithRetry(
  url: string,
  payloadObj: Record<string, unknown>,
  allowInsecureSsl: boolean,
): Promise<boolean> {
  const payload = JSON.stringify(payloadObj);
  const body = `payload=${encodeURIComponent(payload)}`;

  // Internal rate limit: min 500ms between sends
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < MIN_SEND_INTERVAL_MS) {
    await sleep(MIN_SEND_INTERVAL_MS - elapsed);
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const ok = await doPost(url, body, allowInsecureSsl);
      lastSendTime = Date.now();
      if (ok) return true;
    } catch {
      // will retry
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
    }
  }

  return false;
}

/**
 * Build the user_ids array for a DM payload.
 * Returns undefined if userId is absent or non-numeric.
 */
function resolveUserIds(userId?: string | number): number[] | undefined {
  if (!userId) return undefined;
  const numericId = typeof userId === "number" ? userId : parseInt(userId, 10);
  return isNaN(numericId) ? undefined : [numericId];
}

/**
 * Send a text message to a user via the bot's incoming webhook (DM).
 *
 * @param incomingUrl - Synology Chat bot incoming webhook URL
 * @param text - Message text to send
 * @param userId - Recipient user ID (numeric)
 * @param allowInsecureSsl - Skip TLS verification
 * @returns true if sent successfully
 */
export async function sendMessage(
  incomingUrl: string,
  text: string,
  userId?: string | number,
  allowInsecureSsl = false,
): Promise<boolean> {
  const payloadObj: Record<string, unknown> = { text };
  const userIds = resolveUserIds(userId);
  if (userIds) payloadObj.user_ids = userIds;
  return sendWithRetry(incomingUrl, payloadObj, allowInsecureSsl);
}

/**
 * Send a text message to a Synology Chat channel via a dedicated incoming webhook.
 *
 * Unlike sendMessage (which uses the bot's chatbot API with user_ids for DMs),
 * this uses a channel-specific incoming webhook (method=incoming). The webhook
 * token determines which channel receives the message; user_ids is not sent.
 *
 * @param channelWebhookUrl - Channel-specific incoming webhook URL
 * @param text - Message text to send
 * @param allowInsecureSsl - Skip TLS verification
 * @returns true if sent successfully
 */
export async function sendToChannel(
  channelWebhookUrl: string,
  text: string,
  allowInsecureSsl = false,
): Promise<boolean> {
  return sendWithRetry(channelWebhookUrl, { text }, allowInsecureSsl);
}

/**
 * Send a file URL to Synology Chat (DM).
 *
 * @param incomingUrl - Synology Chat bot incoming webhook URL
 * @param fileUrl - Publicly accessible file URL
 * @param userId - Recipient user ID (numeric)
 * @param allowInsecureSsl - Skip TLS verification
 * @returns true if sent successfully
 */
export async function sendFileUrl(
  incomingUrl: string,
  fileUrl: string,
  userId?: string | number,
  allowInsecureSsl = false,
): Promise<boolean> {
  const payloadObj: Record<string, unknown> = { file_url: fileUrl };
  const userIds = resolveUserIds(userId);
  if (userIds) payloadObj.user_ids = userIds;
  return sendWithRetry(incomingUrl, payloadObj, allowInsecureSsl);
}

function doPost(url: string, body: string, allowInsecureSsl: boolean): Promise<boolean> {
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
