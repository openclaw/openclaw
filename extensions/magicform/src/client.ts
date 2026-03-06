/**
 * MagicForm HTTP callback client.
 * Sends agent responses back to MagicForm's POST /claw-agent/callback endpoint.
 */

import * as http from "node:http";
import * as https from "node:https";
import type { MagicFormCallbackPayload } from "./types.js";

/**
 * Send an agent response back to MagicForm via the callback endpoint.
 *
 * @param backendUrl - MagicForm backend base URL (e.g., "https://api.magicform.ai")
 * @param callbackPath - Callback path (e.g., "/claw-agent/callback")
 * @param payload - The callback payload
 * @param apiToken - Bearer token for authentication
 * @returns true if sent successfully
 */
export async function sendCallback(
  backendUrl: string,
  callbackPath: string,
  payload: MagicFormCallbackPayload,
  apiToken: string,
): Promise<boolean> {
  const url = `${backendUrl.replace(/\/$/, "")}${callbackPath}`;
  const body = JSON.stringify(payload);

  const maxRetries = 3;
  const baseDelay = 300;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const ok = await doPost(url, body, apiToken);
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

function doPost(url: string, body: string, apiToken: string): Promise<boolean> {
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
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${apiToken}`,
        },
        timeout: 30_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
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
