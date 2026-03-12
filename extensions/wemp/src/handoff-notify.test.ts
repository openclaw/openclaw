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

test("flushHandoffNotificationsToExternal delivers queued events", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const notifyFile = path.join(DATA_DIR, "handoff-notify.json");
  const notifySnapshot = snapshotFile(notifyFile);
  const previousEndpoint = process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT;
  const previousRetries = process.env.WEMP_HANDOFF_NOTIFY_RETRIES;
  const previousTimeout = process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;

  t.after(() => {
    restoreFile(notifyFile, notifySnapshot);
    if (previousEndpoint === undefined) delete process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT;
    else process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT = previousEndpoint;
    if (previousRetries === undefined) delete process.env.WEMP_HANDOFF_NOTIFY_RETRIES;
    else process.env.WEMP_HANDOFF_NOTIFY_RETRIES = previousRetries;
    if (previousTimeout === undefined) delete process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS;
    else process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS = previousTimeout;
    globalThis.fetch = originalFetch;
  });

  writeFileSync(notifyFile, "[]", "utf8");

  const events: Array<{ event?: string; type?: string; reason?: string; openId?: string }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as any) : {};
    events.push({
      event: payload?.event,
      type: payload?.data?.type,
      reason: payload?.data?.reason,
      openId: payload?.data?.openId,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT = "https://handoff.example.com/notify";
  process.env.WEMP_HANDOFF_NOTIFY_RETRIES = "0";
  process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS = "1000";

  const seed = `${Date.now()}-${Math.random()}`;
  const handoffNotifyUrl = new URL("../src/features/handoff-notify.ts", import.meta.url);
  handoffNotifyUrl.searchParams.set("seed", seed);
  const handoffNotify = await import(handoffNotifyUrl.href);
  handoffNotify.consumeHandoffNotifications(1000);

  handoffNotify.emitHandoffNotification({
    id: `activated-${seed}`,
    type: "activated",
    accountId: `acc-${seed}`,
    openId: `open-${seed}`,
    at: Date.now(),
    reason: "click",
    deliveries: {
      ticket: {
        endpoint: "https://tickets.example.com/handoff",
        token: "ticket-token",
      },
    },
  });
  handoffNotify.emitHandoffNotification({
    id: `resumed-${seed}`,
    type: "resumed",
    accountId: `acc-${seed}`,
    openId: `open-${seed}`,
    at: Date.now(),
    reason: "command",
  });

  const flushResult = await handoffNotify.flushHandoffNotificationsToExternal(10);
  assert.equal(flushResult.failed, 0);
  assert.equal(flushResult.remaining, 0);
  assert.equal(flushResult.delivered, 2);
  assert.deepEqual(
    events.map((item) => item.event),
    ["handoff_notification", "handoff_ticket", "handoff_notification"],
  );
  assert.deepEqual(
    events.map((item) => item.type),
    ["activated", "activated", "resumed"],
  );
  assert.deepEqual(
    events.map((item) => item.reason),
    ["click", "click", "command"],
  );
});

test("flushHandoffNotificationsToExternal supports env ticket fallback without notify endpoint", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const notifyFile = path.join(DATA_DIR, "handoff-notify.json");
  const notifySnapshot = snapshotFile(notifyFile);
  const previousEndpoint = process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT;
  const previousTicketEndpoint = process.env.WEMP_HANDOFF_TICKET_ENDPOINT;
  const previousTicketEvents = process.env.WEMP_HANDOFF_TICKET_EVENTS;
  const previousRetries = process.env.WEMP_HANDOFF_NOTIFY_RETRIES;
  const previousTimeout = process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;

  t.after(() => {
    restoreFile(notifyFile, notifySnapshot);
    if (previousEndpoint === undefined) delete process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT;
    else process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT = previousEndpoint;
    if (previousTicketEndpoint === undefined) delete process.env.WEMP_HANDOFF_TICKET_ENDPOINT;
    else process.env.WEMP_HANDOFF_TICKET_ENDPOINT = previousTicketEndpoint;
    if (previousTicketEvents === undefined) delete process.env.WEMP_HANDOFF_TICKET_EVENTS;
    else process.env.WEMP_HANDOFF_TICKET_EVENTS = previousTicketEvents;
    if (previousRetries === undefined) delete process.env.WEMP_HANDOFF_NOTIFY_RETRIES;
    else process.env.WEMP_HANDOFF_NOTIFY_RETRIES = previousRetries;
    if (previousTimeout === undefined) delete process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS;
    else process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS = previousTimeout;
    globalThis.fetch = originalFetch;
  });

  writeFileSync(notifyFile, "[]", "utf8");

  const events: Array<{ event?: string; type?: string }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as any) : {};
    events.push({
      event: payload?.event,
      type: payload?.data?.type,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  delete process.env.WEMP_HANDOFF_NOTIFY_ENDPOINT;
  process.env.WEMP_HANDOFF_TICKET_ENDPOINT = "https://tickets.example.com/env";
  process.env.WEMP_HANDOFF_TICKET_EVENTS = "resumed";
  process.env.WEMP_HANDOFF_NOTIFY_RETRIES = "0";
  process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS = "1000";

  const seed = `${Date.now()}-${Math.random()}`;
  const handoffNotifyUrl = new URL("../src/features/handoff-notify.ts", import.meta.url);
  handoffNotifyUrl.searchParams.set("seed", `${seed}-env`);
  const handoffNotify = await import(handoffNotifyUrl.href);
  handoffNotify.consumeHandoffNotifications(1000);

  handoffNotify.emitHandoffNotification({
    id: `resumed-env-${seed}`,
    type: "resumed",
    accountId: `acc-${seed}`,
    openId: `open-${seed}`,
    at: Date.now(),
    reason: "command",
  });

  const flushResult = await handoffNotify.flushHandoffNotificationsToExternal(10);
  assert.equal(flushResult.failed, 0);
  assert.equal(flushResult.remaining, 0);
  assert.equal(flushResult.delivered, 1);
  assert.deepEqual(events, [{ event: "handoff_ticket", type: "resumed" }]);
});
