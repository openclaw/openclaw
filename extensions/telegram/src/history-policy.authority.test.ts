import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readTelegramHistory } from "./history-policy.js";
import type { TelegramCachedMessageNode } from "./message-cache-codec.js";
import { createTelegramMessageCache, type TelegramMessageCache } from "./message-cache.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearTelegramRuntimeForTest();
  resetTelegramMessageCacheForTest();
  vi.restoreAllMocks();
});

const message: TelegramCachedMessageNode = {
  messageId: "81",
  body: "Synthetic retained history",
  historyEligible: true,
  sourceMessage: {
    message_id: 81,
    date: 1_736_380_800,
    chat: { id: -10081, type: "supergroup", title: "Synthetic group" },
    from: { id: 10, is_bot: false, first_name: "Participant" },
    text: "Synthetic retained history",
  },
};

describe("Telegram history read authority", () => {
  it.each(
    (["current", "revoked", "config replaced"] as const).flatMap((authority) =>
      ([false, true] as const).map((empty) => ({ authority, empty })),
    ),
  )("settles $authority authority with empty=$empty", async ({ authority, empty }) => {
    clearTelegramRuntimeForTest();
    const cfg: OpenClawConfig = { channels: { telegram: { groupPolicy: "open" } } };
    setRuntimeConfigSnapshot(cfg);
    const cache = createTelegramMessageCache();
    const entered = createDeferred<void>();
    const page = createDeferred<Awaited<ReturnType<TelegramMessageCache["readHistory"]>>>();
    vi.spyOn(cache, "readHistory").mockImplementation(() => {
      entered.resolve();
      return page.promise;
    });
    let current = true;
    const reading = readTelegramHistory({
      cfg,
      cache,
      accountId: "default",
      chatId: -10081,
      limit: 10,
      assertCurrent: () => {
        if (!current) {
          throw new Error("History read authority revoked");
        }
      },
    });
    const result = reading.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    if (authority === "revoked") {
      current = false;
    } else if (authority === "config replaced") {
      setRuntimeConfigSnapshot({ channels: { telegram: { groupPolicy: "disabled" } } });
    }
    const messages = empty ? [] : [message];
    page.resolve({ messages, hasMore: false });
    if (authority === "current") {
      await expect(result).resolves.toEqual({ value: { messages, hasMore: false } });
    } else {
      await expect(result).resolves.toEqual({
        error: expect.objectContaining({
          message:
            authority === "revoked"
              ? "History read authority revoked"
              : "Telegram history policy changed during the read; retry with current permissions.",
        }),
      });
    }
  });
});
