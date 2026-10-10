// Telegram tests cover poll registry plugin behavior.
import {
  createPluginStateKeyedStoreForTests,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findTelegramPollRegistryEntry,
  findTelegramPollRegistryEntrySync,
  recordTelegramPollRegistryEntry,
  retireTelegramPollRegistryEntry,
  type TelegramPollRegistryEntry,
} from "./poll-registry.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";

const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 10_000;

describe("telegram poll registry", () => {
  beforeEach(async () => {
    const store = createPluginStateKeyedStoreForTests<TelegramPollRegistryEntry>("telegram", {
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await store.clear();
    setTelegramPluginStateRuntimeForTests();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("reclaims a closed poll after the durable replay grace", async () => {
    await recordTelegramPollRegistryEntry({
      pollId: "poll-closed",
      chat: { id: -124, type: "supergroup", title: "Reviewers" },
      messageId: 44,
      threadSpec: { scope: "forum", id: 88 },
      question: "Ready?",
      options: ["Yes", "No"],
    });

    await retireTelegramPollRegistryEntry({ pollId: "poll-closed" });
    const store = createPluginStateKeyedStoreForTests<TelegramPollRegistryEntry>("telegram", {
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const entries = await store.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry || entry.expiresAt === undefined) {
      throw new Error("expected the retired poll's durable expiry");
    }
    expect(entry.expiresAt - entry.createdAt).toBe(48 * 60 * 60 * 1000);
    await expect(findTelegramPollRegistryEntry({ pollId: "poll-closed" })).resolves.toMatchObject({
      threadSpec: { scope: "forum", id: 88 },
    });
    expect(findTelegramPollRegistryEntrySync({ pollId: "poll-closed" })).toMatchObject({
      threadSpec: { scope: "forum", id: 88 },
    });

    // The database worker owns expiry; changing the parent clock cannot expire its rows.
    const { db } = openOpenClawStateDatabase();
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabaseForTests, "plugin_state_entries">>(db)
        .updateTable("plugin_state_entries")
        .set({ expires_at: 1 })
        .where("plugin_id", "=", "telegram")
        .where("namespace", "=", TELEGRAM_POLL_REGISTRY_NAMESPACE)
        .where("entry_key", "=", entry.key),
    );
    await expect(findTelegramPollRegistryEntry({ pollId: "poll-closed" })).resolves.toBeNull();
  });

  it.each([
    {
      name: "invalid chat id",
      chat: { id: "not-a-chat", type: "private", first_name: "Ada" },
      threadSpec: { scope: "dm" },
    },
    {
      name: "old numeric-only shape",
      chat: { id: 123, type: "private", first_name: "Ada" },
      threadSpec: undefined,
      messageThreadId: 77,
    },
    {
      name: "direct messages scope",
      chat: { id: -123, type: "supergroup", title: "Channel replies" },
      threadSpec: { scope: "direct-messages", id: 77 },
    },
    {
      name: "direct messages chat",
      chat: {
        id: -123,
        type: "supergroup",
        title: "Channel replies",
        is_direct_messages: true,
      },
      threadSpec: { scope: "forum", id: 77 },
    },
    {
      name: "forum without id",
      chat: { id: -123, type: "supergroup", title: "Forum" },
      threadSpec: { scope: "forum" },
    },
    {
      name: "none with id",
      chat: { id: -123, type: "group", title: "Reviewers" },
      threadSpec: { scope: "none", id: 77 },
    },
    {
      name: "dm scope on a group",
      chat: { id: -123, type: "group", title: "Reviewers" },
      threadSpec: { scope: "dm", id: 77 },
    },
    {
      name: "forum scope on a private chat",
      chat: { id: 123, type: "private", first_name: "Ada" },
      threadSpec: { scope: "forum", id: 77 },
    },
  ])("rejects malformed stored origin data: $name", async (invalid) => {
    const store = createPluginStateKeyedStoreForTests("telegram", {
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await store.register("default:poll-invalid-chat", {
      pollId: "poll-invalid-chat",
      chat: invalid.chat,
      messageId: 44,
      ...(invalid.threadSpec === undefined ? {} : { threadSpec: invalid.threadSpec }),
      ...(invalid.messageThreadId === undefined
        ? {}
        : { messageThreadId: invalid.messageThreadId }),
      question: "Ready?",
      options: ["Yes", "No"],
    });

    await expect(
      findTelegramPollRegistryEntry({ pollId: "poll-invalid-chat" }),
    ).resolves.toBeNull();
  });
});
