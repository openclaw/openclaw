// Telegram tests cover poll registry plugin behavior.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
  TELEGRAM_POLL_REGISTRY_NAMESPACE,
  type TelegramPollRegistryEntry,
  findTelegramPollRegistryEntry,
  recordTelegramPollRegistryEntry,
  setTelegramPollRegistryStoreForTest,
} from "./poll-registry.js";

describe("telegram poll registry", () => {
  let store: PluginStateKeyedStore<TelegramPollRegistryEntry>;

  beforeEach(async () => {
    store = createPluginStateKeyedStoreForTests<TelegramPollRegistryEntry>("telegram", {
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
    });
    await store.clear();
    setTelegramPollRegistryStoreForTest(store);
  });

  afterEach(() => {
    setTelegramPollRegistryStoreForTest(undefined);
    resetPluginStateStoreForTests();
  });

  it("stores and retrieves poll registry entries", async () => {
    await recordTelegramPollRegistryEntry({
      pollId: "poll-1",
      chatId: "-100123",
      messageThreadId: 77,
      question: "Ready?",
      options: ["Yes", "No"],
    });

    await expect(findTelegramPollRegistryEntry({ pollId: "poll-1" })).resolves.toEqual(
      expect.objectContaining({
        pollId: "poll-1",
        chatId: "-100123",
        messageThreadId: 77,
        question: "Ready?",
        options: ["Yes", "No"],
      }),
    );
  });

  it("returns null for an unknown poll id", async () => {
    await expect(findTelegramPollRegistryEntry({ pollId: "missing" })).resolves.toBeNull();
  });

  it("caps the registry at the configured maximum entries", async () => {
    for (let index = 0; index < TELEGRAM_POLL_REGISTRY_MAX_ENTRIES + 1; index += 1) {
      await recordTelegramPollRegistryEntry({
        pollId: `poll-${index}`,
        chatId: "123",
        question: `Question ${index}`,
        options: ["A", "B"],
      });
    }

    const entries = await store.entries();
    expect(entries.length).toBeLessThanOrEqual(TELEGRAM_POLL_REGISTRY_MAX_ENTRIES);
    // Newest entry is retained; the oldest entry is evicted by the bounded keyed store.
    await expect(
      findTelegramPollRegistryEntry({ pollId: `poll-${TELEGRAM_POLL_REGISTRY_MAX_ENTRIES}` }),
    ).resolves.not.toBeNull();
    await expect(findTelegramPollRegistryEntry({ pollId: "poll-0" })).resolves.toBeNull();
  });
});
