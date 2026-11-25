import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { useTelegramKeyedState } from "./keyed-state.test-support.js";
import {
  findTelegramPollRegistryEntry,
  recordTelegramPollRegistryEntry,
  retireTelegramPollRegistryEntry,
  type TelegramPollRegistryEntry,
} from "./poll-registry.js";

const storeOptions = {
  namespace: "telegram.poll-registry",
  maxEntries: 10_000,
  overflowPolicy: "reject-new",
} as const;
const privateChat = { id: 123, type: "private", first_name: "Ada" };
const group = { id: -123, type: "group", title: "Reviewers" };
const supergroup = { id: -123, type: "supergroup", title: "Forum" };
const poll = { messageId: 44, question: "Ready?", options: ["Yes", "No"] };

describe("telegram poll registry", () => {
  const fixture = useTelegramKeyedState<TelegramPollRegistryEntry>(storeOptions, 2);

  it("reclaims a closed poll after the durable replay grace", async () => {
    await recordTelegramPollRegistryEntry({
      ...poll,
      pollId: "poll-closed",
      chat: { id: -124, type: "supergroup", title: "Reviewers" },
      threadSpec: { scope: "forum", id: 88 },
    });

    await retireTelegramPollRegistryEntry({ pollId: "poll-closed" });
    const entries = await fixture.store.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry || entry.expiresAt === undefined) {
      throw new Error("expected the retired poll's durable expiry");
    }
    expect(entry.expiresAt - entry.createdAt).toBe(48 * 60 * 60 * 1000);
    await expect(findTelegramPollRegistryEntry({ pollId: "poll-closed" })).resolves.toMatchObject({
      threadSpec: { scope: "forum", id: 88 },
    });

    // Publish expiry through the native owner so cached reads see the same deadline.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1);
    try {
      createPluginStateSyncKeyedStoreForTests<TelegramPollRegistryEntry>(
        "telegram",
        storeOptions,
      ).register(entry.key, entry.value, { ttlMs: 1 });
    } finally {
      clock.mockRestore();
    }
    await expect(findTelegramPollRegistryEntry({ pollId: "poll-closed" })).resolves.toBeNull();
  });

  it.each([
    ["invalid chat id", { ...privateChat, id: "not-a-chat" }, { scope: "dm" }, undefined],
    ["old numeric-only shape", privateChat, undefined, 77],
    ["direct messages scope", supergroup, { scope: "direct-messages", id: 77 }, undefined],
    [
      "direct messages chat",
      { ...supergroup, is_direct_messages: true },
      { scope: "forum", id: 77 },
      undefined,
    ],
    ["forum without id", supergroup, { scope: "forum" }, undefined],
    ["none with id", group, { scope: "none", id: 77 }, undefined],
    ["dm scope on a group", group, { scope: "dm", id: 77 }, undefined],
    ["forum scope on a private chat", privateChat, { scope: "forum", id: 77 }, undefined],
  ] as const)(
    "rejects malformed stored origin data: %s",
    async (_name, chat, threadSpec, messageThreadId) => {
      const store = createPluginStateKeyedStoreForTests("telegram", storeOptions);
      await store.register("default:poll-invalid-chat", {
        ...poll,
        pollId: "poll-invalid-chat",
        chat,
        ...(threadSpec === undefined ? {} : { threadSpec }),
        ...(messageThreadId === undefined ? {} : { messageThreadId }),
      });

      await expect(
        findTelegramPollRegistryEntry({ pollId: "poll-invalid-chat" }),
      ).resolves.toBeNull();
    },
  );
});
