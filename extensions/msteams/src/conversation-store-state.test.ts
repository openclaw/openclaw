import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

function conversationStateKey(conversationId: string): string {
  return crypto.createHash("sha256").update(conversationId).digest("hex");
}

describe("msteams conversation store (plugin state)", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
    stateDir = tempDirs.make("openclaw-msteams-store-");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => vi.unstubAllEnvs());

  function openStoredConversations() {
    return createPluginStateKeyedStoreForTests<StoredConversationReference>("msteams", {
      namespace: "conversations",
      maxEntries: 2000,
      env,
    });
  }

  it("filters expired SQLite entries while preserving entries without lastSeenAt", async () => {
    const ref: StoredConversationReference = {
      conversation: { id: "19:active@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1", aadObjectId: "aad1" },
    };
    const sqliteStore = openStoredConversations();
    await sqliteStore.register(conversationStateKey("19:active@thread.tacv2"), ref);
    await sqliteStore.register(conversationStateKey("19:old@thread.tacv2"), {
      ...ref,
      conversation: { id: "19:old@thread.tacv2" },
      lastSeenAt: new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await sqliteStore.register(conversationStateKey("19:legacy@thread.tacv2"), {
      ...ref,
      conversation: { id: "19:legacy@thread.tacv2" },
    });

    const store = createMSTeamsConversationStoreState();
    const ids = (await store.list()).map((entry) => entry.conversationId).toSorted();
    expect(ids).toEqual(["19:active@thread.tacv2", "19:legacy@thread.tacv2"]);

    expect(await store.get("19:old@thread.tacv2")).toBeNull();
    const legacyConversation = await store.get("19:legacy@thread.tacv2");
    if (!legacyConversation?.conversation) {
      throw new Error("expected migrated legacy Teams conversation payload");
    }
    expect(legacyConversation.conversation.id).toBe("19:legacy@thread.tacv2");

    await store.upsert("19:new@thread.tacv2", {
      ...ref,
      conversation: { id: "19:new@thread.tacv2" },
    });
    const idsAfter = (await store.list()).map((entry) => entry.conversationId).toSorted();
    expect(idsAfter).toEqual([
      "19:active@thread.tacv2",
      "19:legacy@thread.tacv2",
      "19:new@thread.tacv2",
    ]);
    await fs.promises.access(path.join(stateDir, "state", "openclaw.sqlite"));
  });

  it("ignores a stale legacy JSON file at runtime", async () => {
    const ref: StoredConversationReference = {
      conversation: { id: "conv-current" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com/current",
      user: { id: "current-user" },
    };
    const filePath = path.join(stateDir, "msteams-conversations.json");
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        conversations: {
          "conv-current": {
            ...ref,
            serviceUrl: "https://service.example.com/stale",
            user: { id: "stale-user" },
          },
        },
      })}\n`,
    );
    const sqliteStore = openStoredConversations();
    await sqliteStore.register(conversationStateKey("conv-current"), ref);

    const store = createMSTeamsConversationStoreState();
    await expect(store.get("conv-current")).resolves.toEqual(ref);
    await fs.promises.access(filePath);
  });

  it("hashes external conversation ids before using plugin-state keys", async () => {
    const longConversationId = `a:${"x".repeat(900)}`;
    const store = createMSTeamsConversationStoreState();

    await store.upsert(longConversationId, {
      conversation: { conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "long-user" },
    });
    await expect(store.get(longConversationId)).resolves.toMatchObject({
      conversation: { id: longConversationId },
      user: { id: "long-user" },
    });
  });

  it("isolates account lookups and removal while preserving the default namespace", async () => {
    const reference: StoredConversationReference = {
      conversation: { id: "19:shared", conversationType: "personal" },
      serviceUrl: "https://service.example.com/default",
      user: { id: "shared-user", aadObjectId: "shared-aad" },
    };
    await openStoredConversations().register(conversationStateKey("19:shared"), reference);
    const defaultStore = createMSTeamsConversationStoreState({ accountId: "default" });
    const namedStore = createMSTeamsConversationStoreState({ accountId: "19" });
    expect(await defaultStore.get("19:shared")).toEqual(reference);
    expect(await namedStore.get("19:shared")).toBeNull();
    await namedStore.upsert("19:shared", {
      ...reference,
      serviceUrl: "https://service.example.com/named",
    });
    expect(await namedStore.findPreferredDmByUserId("shared-aad")).toMatchObject({
      conversationId: "19:shared",
      reference: { serviceUrl: "https://service.example.com/named" },
    });
    expect(await defaultStore.findPreferredDmByUserId("shared-aad")).toMatchObject({
      reference: { serviceUrl: "https://service.example.com/default" },
    });
    await defaultStore.remove("19:shared");
    expect(await namedStore.list()).toHaveLength(1);
    expect(
      await createMSTeamsConversationStoreState({ accountId: "19" }).get("19:shared"),
    ).not.toBeNull();
    expect(await createMSTeamsConversationStoreState().list()).toEqual([]);
  });

  it("serializes concurrent upserts so sparse activities preserve independent fields", async () => {
    const store = createMSTeamsConversationStoreState();

    await store.upsert("conv-race", {
      conversation: { id: "conv-race", conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    await Promise.all([
      store.upsert("conv-race", {
        conversation: { id: "conv-race", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        timezone: "Europe/London",
      }),
      store.upsert("conv-race", {
        conversation: { id: "conv-race", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        tenantId: "tenant-1",
      }),
    ]);

    await expect(store.get("conv-race")).resolves.toMatchObject({
      timezone: "Europe/London",
      tenantId: "tenant-1",
    });
  });

  it.each([
    { legacy: false, evictedId: "conv-seen-0000" },
    { legacy: true, evictedId: "conv-legacy" },
  ])(
    "prunes the oldest conversation at the row cap (timestamp-less: $legacy)",
    async ({ legacy, evictedId }) => {
      const sqliteStore = openStoredConversations();
      const reference = {
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
      };
      if (legacy) {
        await sqliteStore.register(conversationStateKey("conv-legacy"), {
          ...reference,
          conversation: { id: "conv-legacy" },
        });
      }
      for (let index = 0; index < (legacy ? 999 : 1000); index += 1) {
        const id = `conv-seen-${String(index).padStart(4, "0")}`;
        await sqliteStore.register(conversationStateKey(id), {
          ...reference,
          conversation: { id },
          lastSeenAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
        });
      }

      const store = createMSTeamsConversationStoreState();
      await store.upsert("conv-new", { ...reference, conversation: { id: "conv-new" } });
      const ids = (await store.list()).map((entry) => entry.conversationId);

      expect(ids).toHaveLength(1000);
      expect(ids).toContain("conv-new");
      expect(ids).not.toContain(evictedId);
    },
  );
});
