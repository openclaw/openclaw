// Telegram tests cover poll registry plugin behavior.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTelegramPollRegistryEntry, recordTelegramPollRegistryEntry } from "./poll-registry.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 100;

type TelegramPollRegistryEntry = {
  pollId: string;
  chatId: string;
  messageThreadId?: number;
  question: string;
  options: string[];
  createdAt: number;
};

function installTelegramStateRuntime(
  openKeyedStore: TelegramRuntime["state"]["openKeyedStore"],
): void {
  setTelegramRuntime({
    state: { openKeyedStore },
    channel: {},
  } as TelegramRuntime);
}

describe("telegram poll registry", () => {
  let store: PluginStateKeyedStore<TelegramPollRegistryEntry>;

  beforeEach(async () => {
    store = createPluginStateKeyedStoreForTests<TelegramPollRegistryEntry>("telegram", {
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
    });
    await store.clear();
    installTelegramStateRuntime(((options) =>
      createPluginStateKeyedStoreForTests(
        "telegram",
        options,
      )) as TelegramRuntime["state"]["openKeyedStore"]);
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
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

  it("rejects a malformed stored chat id", async () => {
    installTelegramStateRuntime((() => ({
      lookup: async () => ({
        pollId: "poll-invalid-chat",
        chatId: "not-a-chat",
        question: "Ready?",
        options: ["Yes", "No"],
        createdAt: Date.now(),
      }),
    })) as unknown as TelegramRuntime["state"]["openKeyedStore"]);

    await expect(
      findTelegramPollRegistryEntry({ pollId: "poll-invalid-chat" }),
    ).resolves.toBeNull();
  });

  it("propagates store lookup failures so durable ingress can retry", async () => {
    const readError = new Error("registry db unavailable");
    const failingStore = {
      lookup: async () => {
        throw readError;
      },
    } as unknown as PluginStateKeyedStore<TelegramPollRegistryEntry>;
    installTelegramStateRuntime((() => failingStore) as TelegramRuntime["state"]["openKeyedStore"]);

    await expect(findTelegramPollRegistryEntry({ pollId: "poll-read-error" })).rejects.toBe(
      readError,
    );
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
