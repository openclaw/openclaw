import {
  createStartAccountContext,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount } from "./inbound-media.test-fixtures.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

const hoisted = vi.hoisted(() => ({
  createNextcloudTalkWebhookSpool: vi.fn(),
  registerNextcloudTalkWebhook: vi.fn(),
}));

vi.mock("./webhook-spool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook-spool.js")>()),
  createNextcloudTalkWebhookSpool: hoisted.createNextcloudTalkWebhookSpool,
}));

vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  registerNextcloudTalkWebhook: hoisted.registerNextcloudTalkWebhook,
}));

const { nextcloudTalkPlugin } = await import("./channel.js");

const startAccount = expectDefined(nextcloudTalkPlugin.gateway?.startAccount, "startAccount");
const account = createAccount({
  baseUrl: "https://nextcloud.example.com",
  config: {
    baseUrl: "https://nextcloud.example.com",
    botSecret: "secret", // pragma: allowlist secret
    webhookPath: "/nextcloud-talk-webhook",
  },
});

function mockStartedMonitor() {
  const stop = vi.fn();
  hoisted.createNextcloudTalkWebhookSpool.mockReturnValue({
    stop,
    ready: vi.fn(async () => {}),
    receive: vi.fn(),
    waitForIdle: vi.fn(),
  });
  return stop;
}

const cfg = { channels: { "nextcloud-talk": account.config } };

describe("nextcloud-talk startAccount lifecycle", () => {
  beforeEach(() => {
    setNextcloudTalkRuntime(createPluginRuntimeMock());
    setActivePluginRegistry(createTestRegistry());
  });
  afterEach(() => vi.clearAllMocks());

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: (ctx) => startAccount({ ...ctx, cfg }),
      account,
    });
    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.createNextcloudTalkWebhookSpool),
      isSettled,
      abort,
      task,
      stop,
    });
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = mockStartedMonitor();
    const abort = new AbortController();
    abort.abort();

    await startAccount(createStartAccountContext({ account, cfg, abortSignal: abort.signal }));

    expect(hoisted.createNextcloudTalkWebhookSpool).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not start the gateway monitor for an unavailable account credential", async () => {
    const unavailable = {
      ...account,
      secret: "",
      tokenStatus: "configured_unavailable" as const,
    };
    await expect(startAccount(createStartAccountContext({ account: unavailable }))).rejects.toThrow(
      /secret|unavailable/i,
    );
    expect(hoisted.createNextcloudTalkWebhookSpool).not.toHaveBeenCalled();
  });

  it("prints webhook failures and route notes on the console, not only in the file log", async () => {
    // Container operators read stdout; the nextcloud-talk file log is often out of reach.
    mockStartedMonitor();
    hoisted.registerNextcloudTalkWebhook.mockReturnValue(vi.fn(async () => {}));
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: (ctx) => startAccount({ ...ctx, cfg }),
      account,
    });

    // The webhook route registers after spool.ready(); wait for it so the target
    // (with onError) is available before we drive the lifecycle to completion.
    await waitForStartedMocks(
      hoisted.createNextcloudTalkWebhookSpool,
      hoisted.registerNextcloudTalkWebhook,
    )();

    const target = expectDefined(
      hoisted.registerNextcloudTalkWebhook.mock.calls[0]?.[0],
      "registered target",
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setLoggerOverride({ level: "silent", consoleLevel: "error", consoleStyle: "compact" });
      target.onError?.(new Error("durable admission failed"));
      expect(consoleError.mock.calls.flat().join("\n")).toMatch(
        /webhook error.*durable admission failed/su,
      );
    } finally {
      setLoggerOverride(null);
      consoleError.mockRestore();
    }

    // Passive lifecycle stays pending until abort; join it so later tests start clean.
    abort.abort();
    await task;
    expect(isSettled()).toBe(true);
  });
});
