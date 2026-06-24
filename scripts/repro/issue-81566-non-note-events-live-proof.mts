// Nextcloud Talk webhook handler incorrectly returns 400 for non-message events (file shares,
// calls, system notifications). After fix: returns 200 for valid non-Note Activity Streams
// payloads, still returns 400 for malformed JSON or broken Note-shaped payloads.
//
// Usage:
//   pnpm tsx scripts/repro/issue-81566-non-note-events-live-proof.mts

import type { AddressInfo } from "node:net";
import {
  createNextcloudTalkWebhookServer,
} from "../../extensions/nextcloud-talk/src/monitor.js";
import {
  createSignedCreateMessageRequest,
  createSignedNonNoteMessageRequest,
} from "../../extensions/nextcloud-talk/src/monitor.test-fixtures.js";
import { generateNextcloudTalkSignature } from "../../extensions/nextcloud-talk/src/signature.js";

function formatResult(label: string, status: number, body: string): void {
  const icon = status === 200 ? "✅" : status === 400 ? "❌" : "⚠️";
  console.log(`  ${icon} ${label}: HTTP ${status}${body ? ` — ${body}` : ""}`);
}

async function main(): Promise<void> {
  // ── Start webhook server ──────────────────────────────────────────
  const onMessage = () => {};
  const path = "/nextcloud-talk-webhook";
  const { server, start } = createNextcloudTalkWebhookServer({
    port: 0,
    host: "127.0.0.1",
    path,
    secret: "nextcloud-secret",
    onMessage,
  });
  await start();
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}${path}`;
  console.log("🔊 Webhook server listening on", baseUrl);

  // ── Test 1: Valid chat message (Create/Note) → 200 + dispatch ────
  console.log("\n── Test 1: Valid chat message (Create/Note) ──");
  {
    const { body, headers } = createSignedCreateMessageRequest();
    const res = await fetch(baseUrl, { method: "POST", headers, body });
    const text = await res.text();
    formatResult("Create/Note (chat message)", res.status, text);
  }

  // ── Test 2: File share (Create/Document) → 200 + no dispatch ─────
  console.log("\n── Test 2: File share event (Create/Document) ──");
  {
    const { body, headers } = createSignedNonNoteMessageRequest();
    const res = await fetch(baseUrl, { method: "POST", headers, body });
    const text = await res.text();
    formatResult("Create/Document (file share)", res.status, text);
  }

  // ── Test 3: Malformed Note payload (empty target.id) → 400 ──────
  console.log("\n── Test 3: Malformed Note-shaped payload ──");
  {
    const payload = {
      type: "Create",
      actor: { type: "Person", id: "alice", name: "Alice" },
      object: {
        type: "Note",
        id: "msg-1",
        name: "hello",
        content: "hello",
        mediaType: "text/plain",
      },
      target: { type: "Collection", id: "", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret",
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
      body,
    });
    const text = await res.text();
    formatResult("Malformed Note (empty target.id)", res.status, text);
  }

  // ── Test 4: Invalid JSON → 400 ────────────────────────────────────
  console.log("\n── Test 4: Invalid JSON ──");
  {
    const body = "not-json{{{";
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret",
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
      body,
    });
    const text = await res.text();
    formatResult("Invalid JSON", res.status, text);
  }

  // ── Shutdown ──────────────────────────────────────────────────────
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  console.log("\n🔊 Server stopped.");
}

await main();
