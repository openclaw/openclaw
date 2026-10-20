// Nextcloud Talk tests cover channel.lifecycle plugin behavior.
import {
  createStartAccountContext,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

const hoisted = vi.hoisted(() => ({
  createNextcloudTalkWebhookSpool: vi.fn(),
}));

vi.mock("./webhook-spool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook-spool.js")>()),
  createNextcloudTalkWebhookSpool: hoisted.createNextcloudTalkWebhookSpool,
}));

const { nextcloudTalkPlugin } = await import("./channel.js");

type NextcloudTalkStartAccount = NonNullable<
  NonNullable<typeof nextcloudTalkPlugin.gateway>["startAccount"]
>;

function requireStartAccount(): NextcloudTalkStartAccount {
  const startAccount = nextcloudTalkPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("Expected Nextcloud Talk gateway startAccount");
  }
  return startAccount;
}

function buildAccount(): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://nextcloud.example.com",
    secret: "secret", // pragma: allowlist secret
    secretSource: "config", // pragma: allowlist secret
    config: {
      baseUrl: "https://nextcloud.example.com",
      botSecret: "secret", // pragma: allowlist secret
      webhookPath: "/nextcloud-talk-webhook",
    },
  };
}

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

function startNextcloudAccount(abortSignal?: AbortSignal) {
  return requireStartAccount()(
    createStartAccountContext({
      account: buildAccount(),
      cfg: { channels: { "nextcloud-talk": buildAccount().config } },
      abortSignal,
    }),
  );
}

describe("nextcloud-talk startAccount lifecycle", () => {
  beforeEach(() => {
    setNextcloudTalkRuntime(createPluginRuntimeMock());
    setActivePluginRegistry(createTestRegistry());
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: (ctx) =>
        requireStartAccount()({
          ...ctx,
          cfg: { channels: { "nextcloud-talk": buildAccount().config } },
        }),
      account: buildAccount(),
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

    await startNextcloudAccount(abort.signal);

    expect(hoisted.createNextcloudTalkWebhookSpool).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not start the gateway monitor for an unavailable account credential", async () => {
    const account: ResolvedNextcloudTalkAccount = {
      ...buildAccount(),
      secret: "",
      tokenStatus: "configured_unavailable",
    };
    await expect(requireStartAccount()(createStartAccountContext({ account }))).rejects.toThrow(
      /secret|unavailable/i,
    );
    expect(hoisted.createNextcloudTalkWebhookSpool).not.toHaveBeenCalled();
  });
});
