import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type { StoredConversationReference as Reference } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";
import { useMSTeamsStateTempDirs } from "./test-support/state.js";

const tempDirs = useMSTeamsStateTempDirs();

function reference(id: string, overrides: Reference = {}): Reference {
  return {
    conversation: { id },
    channelId: "msteams",
    serviceUrl: "https://service.example.com",
    ...overrides,
  };
}

const thread = (name: string) => `19:${name}@thread.tacv2`;

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

  function createSeeder(defaults: Reference = reference("")) {
    const sqlite = createPluginStateKeyedStoreForTests<Reference>("msteams", {
      namespace: "conversations",
      maxEntries: 2000,
      env,
    });
    return (id: string, fields: Reference = {}) =>
      sqlite.register(crypto.createHash("sha256").update(id).digest("hex"), {
        ...defaults,
        conversation: { ...defaults.conversation, id },
        ...fields,
      });
  }

  it("filters expired SQLite entries while preserving entries without lastSeenAt", async () => {
    const user = { id: "u1", aadObjectId: "aad1" };
    const seed = createSeeder(reference("", { user }));
    await seed(thread("active"));
    await seed(thread("old"), { lastSeenAt: new Date(Date.now() - 366 * 86400000).toISOString() });
    await seed(thread("legacy"));

    const store = createMSTeamsConversationStoreState();
    const ids = (await store.list()).map((entry) => entry.conversationId).toSorted();
    expect(ids).toEqual([thread("active"), thread("legacy")]);

    expect(await store.get(thread("old"))).toBeNull();
    expect((await store.get(thread("legacy")))?.conversation?.id).toBe(thread("legacy"));

    await store.upsert(thread("new"), reference(thread("new"), { user }));
    const idsAfter = (await store.list()).map((entry) => entry.conversationId).toSorted();
    expect(idsAfter).toEqual([thread("active"), thread("legacy"), thread("new")]);
    await fs.promises.access(path.join(stateDir, "state", "openclaw.sqlite"));
  });

  it("isolates account lookups and removal while preserving the default namespace", async () => {
    const ref: Reference = {
      conversation: { id: "19:shared", conversationType: "personal" },
      serviceUrl: "https://service.example.com/default",
      user: { id: "shared-user", aadObjectId: "shared-aad" },
    };
    await createSeeder(ref)("19:shared");
    const defaultStore = createMSTeamsConversationStoreState({ accountId: "default" });
    const namedStore = createMSTeamsConversationStoreState({ accountId: "19" });
    expect(await defaultStore.get("19:shared")).toEqual(ref);
    expect(await namedStore.get("19:shared")).toBeNull();
    await namedStore.upsert("19:shared", {
      ...ref,
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

    const ref = reference("conv-race", {
      conversation: { id: "conv-race", conversationType: "personal" },
      user: { id: "u1" },
    });
    await store.upsert("conv-race", ref);

    await Promise.all([
      store.upsert("conv-race", { ...ref, timezone: "Europe/London" }),
      store.upsert("conv-race", { ...ref, tenantId: "tenant-1" }),
    ]);

    await expect(store.get("conv-race")).resolves.toMatchObject({
      timezone: "Europe/London",
      tenantId: "tenant-1",
    });
  });

  it("prunes the timestamp-less conversation first at the row cap", async () => {
    const seed = createSeeder();
    await seed("conv-legacy");
    for (let index = 0; index < 999; index += 1) {
      const id = `conv-seen-${String(index).padStart(4, "0")}`;
      await seed(id, { lastSeenAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString() });
    }

    const store = createMSTeamsConversationStoreState();
    await store.upsert("conv-new", reference("conv-new"));
    const ids = (await store.list()).map((entry) => entry.conversationId);

    expect(ids).toHaveLength(1000);
    expect(ids).toContain("conv-new");
    expect(ids).not.toContain("conv-legacy");
  });
});
