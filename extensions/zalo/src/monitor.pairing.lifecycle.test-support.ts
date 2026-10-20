import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

describe("Zalo pairing lifecycle", () => {
  const readAllowFromStoreMock = vi.fn(async () => [] as string[]);
  const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRCODE", created: true }));

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-pairing-lifecycle");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore({
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
    });
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  function startPairingMonitor(
    accountId = "acct-zalo-pairing",
    cacheKey = "zalo-pairing-lifecycle",
  ) {
    return startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({ accountId, dmPolicy: "pairing", allowFrom: [] }),
      cacheKey,
    });
  }

  async function replayPairing(
    monitor: Awaited<ReturnType<typeof startPairingMonitor>>,
    messagePrefix: string,
    chatId = "dm-pairing-1",
    waitForIdle = false,
  ) {
    await withServer(
      (req, res) => {
        void monitor.route.handler(req, res);
      },
      async (baseUrl) => {
        const { first, replay } = await postWebhookReplay({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload: createTextUpdate({
            messageId: `${messagePrefix}-${Date.now()}`,
            userId: "user-unauthorized",
            userName: "Unauthorized User",
            chatId,
          }),
          beforeReplay: waitForIdle ? monitor.waitForIdle : undefined,
        });
        expect([first.status, replay.status]).toEqual([200, 200]);
        await (waitForIdle ? monitor.waitForIdle() : settleAsyncWork());
      },
    );
  }

  function expectPairingScope(accountId: string) {
    expect(readAllowFromStoreMock).toHaveBeenCalledTimes(1);
    expect(readAllowFromStoreMock).toHaveBeenCalledWith({ channel: "zalo", accountId });
    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "zalo",
      accountId,
      id: "user-unauthorized",
      meta: { name: "Unauthorized User" },
    });
  }

  it("emits one pairing reply across duplicate webhook replay and scopes reads and writes to accountId", async () => {
    const monitor = await startPairingMonitor();
    try {
      await replayPairing(monitor, "zalo-pairing");
      expectPairingScope("acct-zalo-pairing");
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0]).toEqual([
        "zalo-token",
        expect.objectContaining({
          chat_id: "dm-pairing-1",
          text: expect.stringContaining("PAIRCODE"),
        }),
        undefined,
      ]);
    } finally {
      await monitor.stop();
    }
  });

  it("keeps existing pairing-request reads and writes scoped to the provider account", async () => {
    upsertPairingRequestMock.mockResolvedValueOnce({ code: "PAIRCODE", created: false });
    const monitor = await startPairingMonitor("work", "zalo-pairing-existing-request");

    try {
      await replayPairing(monitor, "zalo-pairing-existing", "dm-pairing-existing");
      expectPairingScope("work");
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });

  it("does not emit a second pairing reply when replay arrives after the first send fails", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("pairing send failed"));

    const monitor = await startPairingMonitor();

    try {
      await replayPairing(monitor, "zalo-pairing-retry", "dm-pairing-1", true);

      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(monitor.runtime.error).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });
});
