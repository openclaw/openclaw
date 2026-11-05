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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount } from "./inbound-media.test-fixtures.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

const hoisted = vi.hoisted(() => ({
  createNextcloudTalkWebhookSpool: vi.fn(),
}));

vi.mock("./webhook-spool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook-spool.js")>()),
  createNextcloudTalkWebhookSpool: hoisted.createNextcloudTalkWebhookSpool,
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
});
