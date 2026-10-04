import { DEFAULT_INGRESS_ADOPTION_STALL_MS } from "openclaw/plugin-sdk/channel-outbound";
import { expect, it, vi, type Mock } from "vitest";
import { writeTelegramSpooledUpdate } from "../telegram-ingress-spool.test-support.js";
import type { startTelegramWebhook as StartWebhook } from "../webhook.js";
import { telegramMessageUpdate, waitForWebhookState } from "./webhook-fixtures.js";
import { yieldWebhookTask } from "./webhook-http.js";

export function registerTelegramWebhookRetryTest({
  handleUpdateSpy,
  startTelegramWebhook,
  requireWebhookQueueScope,
  token: TELEGRAM_TOKEN,
  secret: TELEGRAM_SECRET,
  path: TELEGRAM_WEBHOOK_PATH,
}: {
  handleUpdateSpy: Mock<(...args: unknown[]) => unknown>;
  startTelegramWebhook: typeof StartWebhook;
  requireWebhookQueueScope: () => { stateDir: string; accountId: string };
  token: string;
  secret: string;
  path: string;
}) {
  it("retries a timed-out webhook update before later same-lane updates", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      let finishFirstUpdate: (() => void) | undefined;
      let finishRetry: (() => void) | undefined;
      const seenUpdateIds: number[] = [];
      const firstUpdate = telegramMessageUpdate(40, "slow");
      const secondUpdate = telegramMessageUpdate(41, "blocked");
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update: firstUpdate,
      });
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update: secondUpdate,
      });
      handleUpdateSpy.mockImplementation(async (update: unknown) => {
        const updateId = (update as { update_id: number }).update_id;
        seenUpdateIds.push(updateId);
        if (updateId === 40) {
          await new Promise<void>((resolve) => {
            if (seenUpdateIds.filter((id) => id === 40).length === 1) {
              finishFirstUpdate = resolve;
            } else {
              finishRetry = resolve;
            }
          });
        }
      });

      const started = await startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        ...requireWebhookQueueScope(),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });
      try {
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40]));
        await vi.advanceTimersByTimeAsync(DEFAULT_INGRESS_ADOPTION_STALL_MS + 10_000);
        await yieldWebhookTask();
        expect(seenUpdateIds).toEqual([40]);

        finishFirstUpdate?.();
        await yieldWebhookTask();
        await vi.advanceTimersByTimeAsync(1_000);
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40, 40]));
        finishRetry?.();
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40, 40, 41]));
      } finally {
        finishFirstUpdate?.();
        finishRetry?.();
        await started.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
}
