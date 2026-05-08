import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

describe("msteams conversation store (sqlite-backed)", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("filters and prunes expired entries while preserving legacy entries without lastSeenAt", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };

    const store = createMSTeamsConversationStoreState({ env, ttlMs: 1_000 });

    const ref: StoredConversationReference = {
      conversation: { id: "19:active@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1", aadObjectId: "aad1" },
    };

    await store.upsert("19:active@thread.tacv2", ref);

    upsertPluginStateMigrationEntry({
      pluginId: "msteams",
      namespace: "conversations",
      key: "19:old@thread.tacv2",
      value: {
        ...ref,
        conversation: { id: "19:old@thread.tacv2" },
        lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
      },
      createdAt: Date.now() - 60_000,
      env,
    });
    upsertPluginStateMigrationEntry({
      pluginId: "msteams",
      namespace: "conversations",
      key: "19:legacy@thread.tacv2",
      value: {
        ...ref,
        conversation: { id: "19:legacy@thread.tacv2" },
      },
      createdAt: Date.now() - 60_000,
      env,
    });

    const list = await store.list();
    const ids = list.map((entry) => entry.conversationId).toSorted();
    expect(ids).toEqual(["19:active@thread.tacv2", "19:legacy@thread.tacv2"]);

    expect(await store.get("19:old@thread.tacv2")).toBeNull();
    const legacyConversation = await store.get("19:legacy@thread.tacv2");
    if (!legacyConversation) {
      throw new Error("expected migrated legacy Teams conversation");
    }
    if (!legacyConversation.conversation) {
      throw new Error("expected migrated legacy Teams conversation payload");
    }
    expect(legacyConversation.conversation.id).toBe("19:legacy@thread.tacv2");

    await store.upsert("19:new@thread.tacv2", {
      ...ref,
      conversation: { id: "19:new@thread.tacv2" },
    });

    expect((await store.list()).map((entry) => entry.conversationId).toSorted()).toEqual([
      "19:active@thread.tacv2",
      "19:legacy@thread.tacv2",
      "19:new@thread.tacv2",
    ]);
    expect(fs.existsSync(path.join(stateDir, "msteams-conversations.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
  });
});
