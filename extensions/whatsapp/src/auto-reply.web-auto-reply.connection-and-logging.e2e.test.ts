import "./test-helpers.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitForLogTick } from "node:timers/promises";
import { formatEnvelopeTimestamp } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractErrorCode, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { getChildLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, expect, it, vi } from "vitest";
import { getActiveWebListener } from "./active-listener.js";
import { WhatsAppAuthUnstableError, resolveWebCredsPath } from "./auth-store.js";
import { resolveOAuthDir } from "./auth-store.runtime.js";
import {
  createWebInboundDeliverySpies,
  createMockWebListener,
  createScriptedWebListenerFactory,
  createWebListenerFactoryCapture,
  getLastWebAutoReplySessionSocket,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";
import {
  createWhatsAppReplyTransportContext,
  deliverWebReply,
} from "./auto-reply/deliver-reply.js";
import { whatsappLog } from "./auto-reply/loggers.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";
import { waitForWaConnection } from "./session.js";

type DrainSelectionEntry = {
  channel: string;
  accountId?: string | null;
  lastError?: string;
};
type DrainPendingDeliveriesCall = {
  drainKey: string;
  logLabel: string;
  selectEntry: (entry: DrainSelectionEntry) => { match: boolean; bypassBackoff: boolean };
};
type Monitor = typeof import("./auto-reply/monitor.js").monitorWebChannel;
type ListenerOptions = Parameters<NonNullable<Parameters<Monitor>[1]>>[0];
type MonitorOptions = Omit<
  Parameters<typeof startWebAutoReplyMonitor>[0],
  "monitorWebChannelFn" | "listenerFactory" | "sleep"
>;
const polling = { timeout: 250, interval: 2 };

const deliveryQueueMocks = vi.hoisted(() => ({
  drainPendingDeliveries: vi.fn(async (_opts: unknown) => undefined),
}));

vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", () => ({
  drainPendingDeliveries: deliveryQueueMocks.drainPendingDeliveries,
}));

installWebAutoReplyTestHomeHooks();

function requireOnMessage(value: unknown): ListenerOptions["onMessage"] {
  assert(typeof value === "function", "expected web listener onMessage callback");
  return value as ListenerOptions["onMessage"];
}

function expectErrorContaining(errorFn: unknown, text: string): void {
  expect(mockStringMessages(errorFn).join("\n")).toContain(text);
}

function mockStringMessages(mocked: unknown): string[] {
  return ((mocked as { mock?: { calls?: unknown[][] } }).mock?.calls ?? []).map((call) =>
    typeof call[0] === "string" ? call[0] : call[0] instanceof Error ? call[0].message : "",
  );
}

async function waitForScriptedListeners(
  scripted: ReturnType<typeof createScriptedWebListenerFactory>,
  count: number,
  atLeast = false,
) {
  await vi.waitFor(() => {
    const actual = scripted.getListenerCount();
    expect(atLeast ? Math.min(actual, count) : actual).toBe(count);
  }, polling);
}

// The async file transport's flush promise is not exposed through the plugin SDK.
async function waitForLogText(
  filePath: string,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    for (;;) {
      signal.throwIfAborted();
      const content = await withinTest(
        fs.readFile(filePath, "utf8").catch((error: unknown) => {
          if (extractErrorCode(error) === "ENOENT") {
            return "";
          }
          throw error;
        }),
        signal,
      );
      if (content.includes(text)) {
        return content;
      }
      await waitForLogTick(10, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Timed out waiting for ${text} in ${filePath}`, { cause: error });
    }
    throw error;
  }
}

installWebAutoReplyUnitTestHooks();

let monitorWebChannel: Monitor;
beforeAll(async () => {
  ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
});

function startMonitor(options: Partial<MonitorOptions> & { listenerFactory?: unknown } = {}) {
  const scripted = createScriptedWebListenerFactory();
  const sleep = vi.fn(async () => {});
  const statuses: Array<Partial<WebChannelStatus>> = [];
  const listenerFactory = options.listenerFactory ?? scripted.listenerFactory;
  const started = startWebAutoReplyMonitor({
    monitorWebChannelFn: monitorWebChannel as never,
    listenerFactory,
    sleep,
    statusSink: (next) => statuses.push({ ...next }),
    ...options,
  });
  return { ...started, scripted, listenerFactory, sleep, statuses };
}

async function stopMonitor(monitor: ReturnType<typeof startMonitor>, withoutError = false) {
  monitor.controller.abort();
  monitor.scripted.resolveClose(monitor.scripted.getListenerCount() - 1, {
    status: 499,
    isLoggedOut: false,
    ...(withoutError ? {} : { error: "aborted" }),
  });
  await Promise.resolve();
  await monitor.run;
}

function droppedMessage(id: string) {
  return createTestWebInboundMessage({
    event: { id },
    payload: { body: "ignored" },
    admission: {
      conversation: { kind: "direct", id: "+1" },
      ingress: {
        admission: "drop",
        decision: "block",
        decisiveGateId: "sender",
        reasonCode: "no_policy_match",
      },
    },
  });
}

async function openOnce(
  tuning?: Parameters<Monitor>[6],
  resolver: Parameters<Monitor>[3] = async () => undefined,
): Promise<ListenerOptions | undefined> {
  const capture = createWebListenerFactoryCapture();
  await monitorWebChannel(
    false,
    capture.listenerFactory as never,
    false,
    resolver,
    undefined,
    undefined,
    tuning,
  );
  return capture.getLastOptions();
}

function expectStatus(statuses: Partial<WebChannelStatus>[], expected: Partial<WebChannelStatus>) {
  expect(statuses).toContainEqual(expect.objectContaining(expected));
}

function blockedStatus(healthState: WebChannelStatus["healthState"]) {
  return { running: false, connected: false, healthState, lifecycle: "blocked" };
}

it.each([
  ["open", false, "all groups; no group allowlist configured", undefined],
  ["disabled", true, "groups disabled by groupPolicy", undefined],
  ["allowlist", false, "group inbound blocked by empty groupPolicy allowlist", undefined],
  ["allowlist", true, "all groups; sender allowlist configured", undefined],
  ["allowlist", true, "all groups; wildcard configured", { "123@g.us": {}, "*": {} }],
  ["allowlist", true, "2 configured groups", { "123@g.us": {}, "456@g.us": {} }],
] as const)(
  "logs listener scope for %s policy: %s, %s",
  async (groupPolicy, hasGroupAllowFrom, scope, groups) => {
    setLoadConfigMock({
      channels: {
        whatsapp: {
          groupPolicy,
          allowFrom: [],
          groupAllowFrom: hasGroupAllowFrom ? ["+111"] : [],
          groups,
        },
      },
    });
    const info = vi.spyOn(whatsappLog, "info").mockImplementation(() => {});
    try {
      await openOnce();
      expect(info).toHaveBeenCalledWith(`Listening for WhatsApp inbound messages (DM + ${scope}).`);
    } finally {
      info.mockRestore();
    }
  },
);

it("handles helper envelope timestamps with trimmed timezones (regression)", () => {
  const d = new Date("2025-01-01T00:00:00.000Z");
  expect(formatEnvelopeTimestamp(d, " America/Los_Angeles ")).toBe("Tue 2024-12-31 16:00:00 PST");
});

it("does not publish running status when config loading fails", async () => {
  setLoadConfigMock(() => {
    throw new Error("config snapshot failed");
  });

  const { run, listenerFactory, statuses } = startMonitor({
    listenerFactory: vi.fn(async () => createMockWebListener()),
  });

  await expect(run).rejects.toThrow("config snapshot failed");

  expect(listenerFactory).not.toHaveBeenCalled();
  expect(statuses.some((status) => status.running === true)).toBe(false);
});

it.each([
  [10, 3, false, "Retry 1"],
  [5, 2, true, "max attempts reached"],
] as const)(
  "handles reconnect progress with %i ms delay and %i max attempts",
  async (initialMs, maxAttempts, finish, error) => {
    const { runtime, controller, run, scripted } = startMonitor({
      reconnect: { initialMs, maxMs: initialMs, maxAttempts, factor: 1.1 },
    });
    await waitForScriptedListeners(scripted, 1);
    scripted.resolveClose(0);
    await waitForScriptedListeners(scripted, 2);
    if (!finish) {
      controller.abort();
    }
    scripted.resolveClose(1);
    if (!finish) {
      await Promise.resolve();
    }
    await run;
    expectErrorContaining(runtime.error, error);
  },
);

it.each([
  [30 * 60_000, 20 * 60_000],
  [5 * 60_000, 5 * 60_000],
  [1, 60_000],
])("bounds offline catch-up for a %i ms message timeout", async (messageTimeoutMs, expected) => {
  const options = await openOnce({ messageTimeoutMs });
  expect(options?.appendReplyMaxAgeMs).toBe(expected);
});

it.each([
  [
    "Boom 428",
    () => toErrorObject({ output: { statusCode: 428 } }, "Non-Error thrown"),
    10,
    ["status 428", "Retry 1/2", "2/2 attempts"],
  ],
  [
    "unstable auth",
    () => new WhatsAppAuthUnstableError(),
    5,
    ["Retry 1/2", "Stopping web monitoring"],
  ],
] as const)(
  "retries opening-phase %s through the reconnect policy",
  async (_name, makeError, initialMs, messages) => {
    const listenerFactory = vi.fn(async () => {
      throw makeError();
    });

    const { runtime, run, sleep } = startMonitor({
      listenerFactory,
      reconnect: { initialMs, maxMs: initialMs, maxAttempts: 2, factor: 1.1 },
    });

    await run;

    expect(listenerFactory).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    for (const message of messages) {
      expectErrorContaining(runtime.error, message);
    }
  },
);

it("retries opening-phase connection wait timeouts through the reconnect policy", async () => {
  vi.mocked(waitForWaConnection).mockRejectedValueOnce({ output: { statusCode: 408 } });
  const { runtime, controller, run, listenerFactory, sleep } = startMonitor({
    listenerFactory: vi.fn(async () => createMockWebListener()),
    reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 2, factor: 1.1 },
  });

  await vi.waitFor(() => expect(listenerFactory).toHaveBeenCalledTimes(1), polling);
  controller.abort();
  await run;

  expect(waitForWaConnection).toHaveBeenCalledTimes(2);
  expect(listenerFactory).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalled();
  expectErrorContaining(runtime.error, "status 408");
  expectErrorContaining(runtime.error, "Retry 1/2");
});

it("marks an opening-phase remote logout as a terminal disconnect", async () => {
  vi.mocked(waitForWaConnection).mockRejectedValueOnce({ output: { statusCode: 401 } });
  const { runtime, run, listenerFactory, sleep, statuses } = startMonitor({
    listenerFactory: vi.fn(async () => createMockWebListener()),
  });

  await expect(run).resolves.toBeUndefined();

  expect(waitForWaConnection).toHaveBeenCalledOnce();
  expect(listenerFactory).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
  expect(statuses.at(-1)).toMatchObject({
    ...blockedStatus("logged-out"),
    terminalDisconnect: true,
  });
  expectErrorContaining(runtime.error, "openclaw channels login --channel whatsapp");
});

it("drains pending deliveries while connected and stops after close", async () => {
  vi.useFakeTimers();
  try {
    const monitor = startMonitor({ accountId: "work" });
    const { scripted } = monitor;

    await waitForScriptedListeners(scripted, 1);
    expect(deliveryQueueMocks.drainPendingDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        drainKey: "whatsapp:work",
        logLabel: "WhatsApp reconnect drain",
      }),
    );

    deliveryQueueMocks.drainPendingDeliveries.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(deliveryQueueMocks.drainPendingDeliveries).toHaveBeenCalledTimes(1);
    });

    const periodicCall = deliveryQueueMocks.drainPendingDeliveries.mock.calls.at(-1)?.[0] as
      | DrainPendingDeliveriesCall
      | undefined;
    assert(periodicCall, "Expected WhatsApp periodic drain call");
    expect(periodicCall).toMatchObject({
      drainKey: "whatsapp:work",
      logLabel: "WhatsApp periodic drain",
    });
    const select = (channel: string, accountId: string) =>
      periodicCall.selectEntry({ channel, accountId });
    expect(select("whatsapp", "work")).toEqual({ match: true, bypassBackoff: false });
    expect(select("whatsapp", "default")).toEqual({ match: false, bypassBackoff: false });
    expect(select("telegram", "work")).toEqual({ match: false, bypassBackoff: false });

    await stopMonitor(monitor);

    deliveryQueueMocks.drainPendingDeliveries.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliveryQueueMocks.drainPendingDeliveries).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  [440, false, "conflict", "Unknown Stream Errored (conflict)"],
  [401, true, "logged-out", "Stream Errored (logged out)"],
] as const)(
  "stops active listener and preserves auth after terminal status %i",
  async (status, isLoggedOut, healthState, error) => {
    const accountId = `terminal-${status}`;
    const authDir = path.join(resolveOAuthDir(), "whatsapp", accountId);
    const credsPath = resolveWebCredsPath(authDir);
    const credsJson = JSON.stringify({ me: { id: "123@s.whatsapp.net" } });
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(credsPath, credsJson);
    setLoadConfigMock({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          accounts: { [accountId]: { authDir } },
        },
      },
      messages: { messagePrefix: undefined, responsePrefix: undefined },
    });

    const { run, scripted, sleep, statuses } = startMonitor({
      accountId,
      reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
    });

    await vi.waitFor(() => {
      expect(scripted.getListenerCount()).toBe(1);
      assert(getActiveWebListener(accountId), "expected active WhatsApp web listener");
    }, polling);

    scripted.resolveClose(0, { status, isLoggedOut, error });
    await run;

    expect(scripted.getListenerCount()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(getActiveWebListener(accountId)).toBeNull();
    await expect(fs.readFile(credsPath, "utf8")).resolves.toBe(credsJson);
    expectStatus(statuses, { connected: false, healthState });
    expect(statuses.at(-1)).toMatchObject(blockedStatus(healthState));
  },
);

type WatchdogOptions = Partial<MonitorOptions> & {
  seedInbound?: boolean;
  cleanupWithoutError?: boolean;
};
async function withWatchdog(
  options: WatchdogOptions,
  exercise: (context: ReturnType<typeof startMonitor>) => Promise<void>,
) {
  vi.useFakeTimers();
  const { seedInbound, cleanupWithoutError, ...tuning } = options;
  const monitor = startMonitor({
    heartbeatSeconds: 60,
    messageTimeoutMs: 30,
    watchdogCheckMs: 5,
    ...tuning,
  });
  const { scripted } = monitor;
  try {
    await waitForScriptedListeners(scripted, 1);
    if (seedInbound) {
      await vi.waitFor(() => expect(scripted.getOnMessage()).toBeTypeOf("function"), polling);
      await requireOnMessage(scripted.getOnMessage())(droppedMessage("m1"));
    }
    await exercise(monitor);
  } finally {
    try {
      await stopMonitor(monitor, cleanupWithoutError);
    } finally {
      vi.useRealTimers();
    }
  }
  return monitor;
}

it("forces reconnect when watchdog closes without onClose", async () => {
  const { runtime, statuses } = await withWatchdog(
    { seedInbound: true, cleanupWithoutError: true },
    async ({ scripted }) => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      await waitForScriptedListeners(scripted, 2, true);
    },
  );
  expectErrorContaining(runtime.log, "WhatsApp Web watchdog is recovering a stale connection");
  expect(mockStringMessages(runtime.error).join("\n")).not.toContain("status 499");
  expectStatus(statuses, {
    healthState: "reconnecting",
    lifecycle: "recovering",
    reconnectAttempts: 1,
    lastDisconnect: expect.objectContaining({ status: 499 }),
  });
  expectStatus(statuses, {
    connected: true,
    healthState: "healthy",
    lifecycle: "ready",
    reconnectAttempts: 0,
    lastDisconnect: null,
  });
  expect(
    statuses.some(
      ({ lastDisconnect }) =>
        lastDisconnect && typeof lastDisconnect === "object" && "expected" in lastDisconnect,
    ),
  ).toBe(false);
});

it("keeps quiet linked-device sessions open when transport frames keep arriving", async () => {
  await withWatchdog({ cleanupWithoutError: true }, async ({ scripted }) => {
    const socket = getLastWebAutoReplySessionSocket();
    await vi.advanceTimersByTimeAsync(20);
    socket.ws.emit("frame");
    await vi.advanceTimersByTimeAsync(20);
    socket.ws.emit("frame");
    await vi.advanceTimersByTimeAsync(20);
    expect(scripted.getListenerCount()).toBe(1);
  });
});

it("reconnects on transport stall before the long app-silence window", async () => {
  await withWatchdog(
    { heartbeatSeconds: 1, transportTimeoutMs: 30, messageTimeoutMs: 3_000 },
    async ({ scripted }) => {
      await vi.advanceTimersByTimeAsync(36);
      await Promise.resolve();
      await waitForScriptedListeners(scripted, 2, true);
    },
  );
});

it("recovers a post-408 listener when transport frames continue but app delivery stays silent", async () => {
  await withWatchdog({ seedInbound: true }, async ({ scripted }) => {
    scripted.resolveClose(0, {
      status: 408,
      isLoggedOut: false,
      error: "status=408 Request Time-out",
    });
    await waitForScriptedListeners(scripted, 2);
    const reconnectedSocket = getLastWebAutoReplySessionSocket();
    for (let elapsedMs = 0; elapsedMs < 45; elapsedMs += 5) {
      reconnectedSocket.ws.emit("frame");
      await vi.advanceTimersByTimeAsync(5);
    }
    await waitForScriptedListeners(scripted, 3, true);
  });
});

it("gives a reconnected listener a fresh watchdog window", async () => {
  await withWatchdog({ seedInbound: true }, async ({ scripted }) => {
    scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "first-close" });
    await waitForScriptedListeners(scripted, 2);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    expect(scripted.getListenerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await waitForScriptedListeners(scripted, 3, true);
  });
});

it("passes live debounce config to the listener", async () => {
  setLoadConfigMock({
    messages: { inbound: { debounceMs: 250 } },
    channels: { whatsapp: { accounts: { work: { authDir: "/tmp/work" } } } },
  } as OpenClawConfig);
  const options = await openOnce({ accountId: "work" }, async () => ({ text: "ok" }));

  resetLoadConfigMock();
  expect(options).toMatchObject({
    debounceMs: undefined,
    cfg: { messages: { inbound: { debounceMs: 250 } } },
    loadConfig: expect.any(Function),
  });
});

it("raises the process listener budget before opening the web listener", async () => {
  const originalMax = process.getMaxListeners();
  process.setMaxListeners?.(1);
  try {
    await openOnce();
    expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);
  } finally {
    process.setMaxListeners?.(originalMax);
  }
});

it("logs outbound delivery metadata without reply content", async ({ signal }) => {
  const logPath = `/tmp/openclaw-log-test-${crypto.randomUUID()}.log`;
  setLoggerOverride({ level: "trace", file: logPath });
  const spies = createWebInboundDeliverySpies();
  const msg = createTestWebInboundMessage({
    platform: { reply: spies.reply, sendMedia: spies.sendMedia },
  });

  const text = "private WhatsApp reply with confidential account details";
  await deliverWebReply({
    replyResult: { text },
    transport: createWhatsAppReplyTransportContext(msg),
    maxMediaBytes: 5 * 1024 * 1024,
    textLimit: 64_000,
    replyLogger: getChildLogger({ module: "web-auto-reply", runId: "file-log-test" }),
    connectionId: "conn-file-log",
  });

  const content = await waitForLogText(logPath, "auto-reply sent (text)", signal);
  expect(content).toMatch(/web-auto-reply/);
  expect(content).toContain(`"textLength":${text.length}`);
  expect(content).not.toContain(text);
});
