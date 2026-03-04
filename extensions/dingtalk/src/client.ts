/**
 * DingTalk outbound: send message via SessionWebhook (reply in conversation).
 * @see https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/
 */

import * as http from "node:http";
import * as https from "node:https";

/**
 * Send text to DingTalk via sessionWebhook URL.
 * Body: { msgtype: "text", text: { content: "..." } }
 */
export async function sendViaSessionWebhook(
  sessionWebhook: string,
  text: string,
  fetch?: typeof globalThis.fetch,
): Promise<boolean> {
  if (!sessionWebhook || !text) return false;
  const body = JSON.stringify({
    msgtype: "text",
    text: { content: text.slice(0, 20_000) },
  });
  if (fetch) {
    const res = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return res.ok;
  }
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(sessionWebhook);
    } catch {
      resolve(false);
      return;
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      sessionWebhook,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
        },
        timeout: 15_000,
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
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(body, "utf8");
    req.end();
  });
}
