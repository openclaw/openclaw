import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  replayLifecycleWebhook,
  withStoppedMonitor,
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

  afterAll(resetLifecycleTestState);

  it.each([
    ["new request", "acct-zalo-pairing", false, false],
    ["existing request", "work", true, false],
    ["failed reply", "acct-zalo-pairing", false, true],
  ] as const)(
    "scopes %s to its account and deduplicates replay",
    async (name, accountId, existing, failed) => {
      upsertPairingRequestMock.mockResolvedValueOnce({ code: "PAIRCODE", created: !existing });
      if (failed) {
        sendMessageMock.mockRejectedValueOnce(new Error("pairing send failed"));
      }
      const monitor = await startWebhookLifecycleMonitor({
        ...createLifecycleMonitorSetup({ accountId, dmPolicy: "pairing", allowFrom: [] }),
        cacheKey: existing ? "zalo-pairing-existing-request" : "zalo-pairing-lifecycle",
      });
      await withStoppedMonitor(monitor, async () => {
        const chatId = existing ? "dm-pairing-existing" : "dm-pairing-1";
        await replayLifecycleWebhook(
          monitor,
          createTextUpdate({
            messageId: `zalo-pairing-${name}-${Date.now()}`,
            userId: "user-unauthorized",
            userName: "Unauthorized User",
            chatId,
          }),
          failed,
          failed ? monitor.waitForIdle : settleAsyncWork,
        );
        expect(readAllowFromStoreMock).toHaveBeenCalledExactlyOnceWith({
          channel: "zalo",
          accountId,
        });
        expect(upsertPairingRequestMock).toHaveBeenCalledExactlyOnceWith({
          channel: "zalo",
          accountId,
          id: "user-unauthorized",
          meta: { name: "Unauthorized User" },
        });
        if (existing) {
          expect(sendMessageMock).not.toHaveBeenCalled();
        } else {
          expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith(
            "zalo-token",
            expect.objectContaining({ chat_id: chatId, text: expect.stringContaining("PAIRCODE") }),
            undefined,
          );
        }
        if (failed) {
          expect(monitor.runtime.error).not.toHaveBeenCalled();
        }
      });
    },
  );
});
