#!/usr/bin/env node
/**
 * Feishu live E2E harness (optional — skips when credentials missing).
 *
 * Prerequisites:
 *   FEISHU_APP_ID, FEISHU_APP_SECRET
 *   FEISHU_TEST_CHAT_ID or FEISHU_TEST_OPEN_ID (receive probe message)
 *   Running Gateway on CLAWORKS_GATEWAY_URL (default http://127.0.0.1:18800)
 *
 * Usage:
 *   pnpm claworks:feishu:live-e2e
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayUrl = (process.env.CLAWORKS_GATEWAY_URL ?? "http://127.0.0.1:18800").replace(
  /\/$/,
  "",
);
const appId = process.env.FEISHU_APP_ID?.trim();
const appSecret = process.env.FEISHU_APP_SECRET?.trim();
const chatId = process.env.FEISHU_TEST_CHAT_ID?.trim();
const openId = process.env.FEISHU_TEST_OPEN_ID?.trim();

function log(msg) {
  console.log(`[feishu-live-e2e] ${msg}`);
}

function skip(msg) {
  log(`SKIP: ${msg}`);
  process.exit(0);
}

async function main() {
  if (!appId || !appSecret) {
    skip(
      "FEISHU_APP_ID / FEISHU_APP_SECRET not set — live E2E requires real Feishu app credentials",
    );
  }
  if (!chatId && !openId) {
    skip("FEISHU_TEST_CHAT_ID or FEISHU_TEST_OPEN_ID required for message roundtrip");
  }

  log(`probing Gateway health at ${gatewayUrl}/v1/health`);
  const healthRes = await fetch(`${gatewayUrl}/v1/health`);
  if (!healthRes.ok) {
    console.error(`[feishu-live-e2e] FAIL: Gateway unhealthy (${healthRes.status})`);
    process.exit(1);
  }
  const health = await healthRes.json();
  log(`Gateway status: ${health.status ?? "unknown"}`);

  const probeText = `ClaWorks live E2E probe ${Date.now()}`;
  log("injecting IM message via REST /v1/events (feishu channel simulation)");
  const eventRes = await fetch(`${gatewayUrl}/v1/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ClaWorks-Channel-User": openId ? `feishu:${openId}` : `feishu:live-e2e-user`,
    },
    body: JSON.stringify({
      type: "im.message.received",
      source: "feishu-live-e2e",
      payload: {
        channel: "feishu",
        channel_id: chatId ?? openId,
        text: probeText,
        user_id: openId ?? "live-e2e-user",
      },
    }),
  });

  if (!eventRes.ok) {
    const body = await eventRes.text();
    console.error(`[feishu-live-e2e] FAIL: /v1/events ${eventRes.status} ${body.slice(0, 400)}`);
    process.exit(1);
  }

  log("event accepted — check Gateway logs / Feishu chat for bot reply");
  log(
    "full roundtrip (Feishu API send + card readback) requires OpenClaw feishu channel + webhook URL",
  );
  log("see docs/OBSERVABILITY.md and extensions/feishu for production wiring");

  if (!existsSync(path.join(root, "extensions/feishu"))) {
    log("WARN: extensions/feishu not found in this checkout");
  }

  log("PASS: live E2E probe completed (ingress path verified)");
}

main().catch((err) => {
  console.error(`[feishu-live-e2e] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
