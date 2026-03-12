import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { getWempDataRoot } from "../src/storage.js";

const DATA_DIR = getWempDataRoot();

interface FileSnapshot {
  existed: boolean;
  content: string;
}

function snapshotFile(file: string): FileSnapshot {
  if (!existsSync(file)) return { existed: false, content: "" };
  return { existed: true, content: readFileSync(file, "utf8") };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.existed) {
    writeFileSync(file, snapshot.content, "utf8");
    return;
  }
  rmSync(file, { force: true });
}

test("pairing reuses existing code and allows after approval", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const pendingFile = path.join(DATA_DIR, "pairing-pending.json");
  const approvedFile = path.join(DATA_DIR, "pairing-approved.json");
  const notifyFile = path.join(DATA_DIR, "pairing-notify.json");
  const pendingSnapshot = snapshotFile(pendingFile);
  const approvedSnapshot = snapshotFile(approvedFile);
  const notifySnapshot = snapshotFile(notifyFile);

  t.after(() => {
    restoreFile(pendingFile, pendingSnapshot);
    restoreFile(approvedFile, approvedSnapshot);
    restoreFile(notifyFile, notifySnapshot);
  });

  writeFileSync(pendingFile, "{}", "utf8");
  writeFileSync(approvedFile, "{}", "utf8");
  writeFileSync(notifyFile, "[]", "utf8");

  const seed = `${Date.now()}-${Math.random()}`;
  const pairingUrl = new URL("../src/pairing.ts", import.meta.url);
  pairingUrl.searchParams.set("seed", seed);
  const pairing = await import(pairingUrl.href);
  pairing.consumePairingNotifications(1000);

  const accountId = `acc-${seed}`;
  const openId = `open-${seed}`;

  const first = pairing.requestPairing(accountId, openId);
  const second = pairing.requestPairing(accountId, openId);
  assert.equal(second.code, first.code);
  assert.equal(second.subject, first.subject);
  assert.equal(pairing.isPairingAllowed([], accountId, openId), false);

  const approved = pairing.approvePairingCode(first.code);
  assert.equal(approved.ok, true);
  assert.equal(approved.subject, first.subject);
  assert.equal(pairing.isPairingAllowed([], accountId, openId), true);

  const notifications = pairing.consumePairingNotifications(10);
  assert.ok(
    notifications.some(
      (item: { type?: string; subject?: string }) =>
        item.type === "approved" && item.subject === first.subject,
    ),
  );

  const revoked = pairing.revokePairing(accountId, openId);
  assert.equal(revoked.revoked, true);
  const revokeNotifications = pairing.consumePairingNotifications(10);
  assert.ok(
    revokeNotifications.some(
      (item: { type?: string; subject?: string }) =>
        item.type === "revoked" && item.subject === first.subject,
    ),
  );
});

test("flushPairingNotificationsToExternal delivers requested/approved/revoked notifications", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const pendingFile = path.join(DATA_DIR, "pairing-pending.json");
  const approvedFile = path.join(DATA_DIR, "pairing-approved.json");
  const notifyFile = path.join(DATA_DIR, "pairing-notify.json");
  const pendingSnapshot = snapshotFile(pendingFile);
  const approvedSnapshot = snapshotFile(approvedFile);
  const notifySnapshot = snapshotFile(notifyFile);
  const previousEndpoint = process.env.WEMP_PAIRING_NOTIFY_ENDPOINT;
  const previousRetries = process.env.WEMP_PAIRING_NOTIFY_RETRIES;
  const previousTimeout = process.env.WEMP_PAIRING_NOTIFY_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;

  t.after(() => {
    restoreFile(pendingFile, pendingSnapshot);
    restoreFile(approvedFile, approvedSnapshot);
    restoreFile(notifyFile, notifySnapshot);
    if (previousEndpoint === undefined) delete process.env.WEMP_PAIRING_NOTIFY_ENDPOINT;
    else process.env.WEMP_PAIRING_NOTIFY_ENDPOINT = previousEndpoint;
    if (previousRetries === undefined) delete process.env.WEMP_PAIRING_NOTIFY_RETRIES;
    else process.env.WEMP_PAIRING_NOTIFY_RETRIES = previousRetries;
    if (previousTimeout === undefined) delete process.env.WEMP_PAIRING_NOTIFY_TIMEOUT_MS;
    else process.env.WEMP_PAIRING_NOTIFY_TIMEOUT_MS = previousTimeout;
    globalThis.fetch = originalFetch;
  });

  writeFileSync(pendingFile, "{}", "utf8");
  writeFileSync(approvedFile, "{}", "utf8");
  writeFileSync(notifyFile, "[]", "utf8");

  const events: Array<{ type?: string; subject?: string }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as any) : {};
    events.push({
      type: payload?.data?.type,
      subject: payload?.data?.subject,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  process.env.WEMP_PAIRING_NOTIFY_ENDPOINT = "https://pairing.example.com/notify";
  process.env.WEMP_PAIRING_NOTIFY_RETRIES = "0";
  process.env.WEMP_PAIRING_NOTIFY_TIMEOUT_MS = "1000";

  const seed = `${Date.now()}-${Math.random()}`;
  const pairingUrl = new URL("../src/pairing.ts", import.meta.url);
  pairingUrl.searchParams.set("seed", seed);
  const pairing = await import(pairingUrl.href);
  pairing.consumePairingNotifications(1000);

  const accountId = `acc-flush-${seed}`;
  const openId = `open-flush-${seed}`;
  const requested = pairing.requestPairing(accountId, openId);
  const approved = pairing.approvePairingCode(requested.code);
  assert.equal(approved.ok, true);
  pairing.revokePairing(accountId, openId);

  const flushResult = await pairing.flushPairingNotificationsToExternal(10);
  assert.equal(flushResult.failed, 0);
  assert.equal(flushResult.remaining, 0);
  assert.equal(flushResult.delivered, 3);

  const types = events.map((item) => item.type);
  assert.deepEqual(types, ["requested", "approved", "revoked"]);
  assert.ok(events.every((item) => item.subject === requested.subject));
});

test("isPairingAllowed respects dm policy semantics", async () => {
  const seed = `${Date.now()}-${Math.random()}`;
  const pairingUrl = new URL("../src/pairing.ts", import.meta.url);
  pairingUrl.searchParams.set("seed", seed);
  const pairing = await import(pairingUrl.href);

  const accountId = `acc-policy-${seed}`;
  const openId = `open-policy-${seed}`;

  assert.equal(pairing.isPairingAllowed("open", [], accountId, openId), true);
  assert.equal(pairing.isPairingAllowed("disabled", [openId], accountId, openId), false);
  assert.equal(pairing.isPairingAllowed("allowlist", [], accountId, openId), false);
  assert.equal(pairing.isPairingAllowed("allowlist", [openId], accountId, openId), true);
  assert.equal(pairing.isPairingAllowed("pairing", [], accountId, openId), false);

  const request = pairing.requestPairing(accountId, openId);
  const approved = pairing.approvePairingCode(request.code);
  assert.equal(approved.ok, true);
  assert.equal(pairing.isPairingAllowed("pairing", [], accountId, openId), true);
});
