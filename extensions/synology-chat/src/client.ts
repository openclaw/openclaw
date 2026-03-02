/**
 * Synology Chat HTTP client.
 * Sends messages TO Synology Chat via the incoming webhook URL.
 */

import * as http from "node:http";
import * as https from "node:https";

const MIN_SEND_INTERVAL_MS = 500;
let lastSendTime = 0;

/**
 * Send a text message to Synology Chat via the incoming webhook.
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
  // The @mention is optional but user_ids is mandatory
  const payloadObj: Record<string, any> = { text };
  if (userId) {
    // userId can be numeric ID or username - if numeric, add to user_ids
    const numericId = typeof userId === "number" ? userId : parseInt(userId, 10);
    if (!isNaN(numericId)) {
      payloadObj.user_ids = [numericId];
    }
  }
  const payload = JSON.stringify(payloadObj);
  const body = `payload=${encodeURIComponent(payload)}`;

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
      const ok = await doPost(incomingUrl, body, allowInsecureSsl);
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
