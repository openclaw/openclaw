import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { createMSTeamsConversationStoreMemory } from "./conversation-store-memory.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

describe("msteams conversation store (fs)", () => {
  beforeEach(() => {
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("filters and prunes expired entries (but keeps legacy ones)", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };

    const store = createMSTeamsConversationStoreFs({ env, ttlMs: 1_000 });

    const ref: StoredConversationReference = {
      conversation: { id: "19:active@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1", aadObjectId: "aad1" },
    };

    await store.upsert("19:active@thread.tacv2", ref);

    const filePath = path.join(stateDir, "msteams-conversations.json");
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const json = JSON.parse(raw) as {
      version: number;
      conversations: Record<string, StoredConversationReference & { lastSeenAt?: string }>;
    };

    json.conversations["19:old@thread.tacv2"] = {
      ...ref,
      conversation: { id: "19:old@thread.tacv2" },
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    };

    // Legacy entry without lastSeenAt should be preserved.
    json.conversations["19:legacy@thread.tacv2"] = {
      ...ref,
      conversation: { id: "19:legacy@thread.tacv2" },
    };

    await fs.promises.writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`);

    const list = await store.list();
    const ids = list.map((e) => e.conversationId).toSorted();
    expect(ids).toEqual(["19:active@thread.tacv2", "19:legacy@thread.tacv2"]);

    expect(await store.get("19:old@thread.tacv2")).toBeNull();
    expect(await store.get("19:legacy@thread.tacv2")).not.toBeNull();

    await store.upsert("19:new@thread.tacv2", {
      ...ref,
      conversation: { id: "19:new@thread.tacv2" },
    });

    const rawAfter = await fs.promises.readFile(filePath, "utf-8");
    const jsonAfter = JSON.parse(rawAfter) as typeof json;
    expect(Object.keys(jsonAfter.conversations).toSorted()).toEqual([
      "19:active@thread.tacv2",
      "19:legacy@thread.tacv2",
      "19:new@thread.tacv2",
    ]);
  });

  it("stores and retrieves timezone from conversation reference", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const store = createMSTeamsConversationStoreFs({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      ttlMs: 60_000,
    });

    const ref: StoredConversationReference = {
      conversation: { id: "19:tz-test@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1", aadObjectId: "aad1" },
      timezone: "America/Los_Angeles",
    };

    await store.upsert("19:tz-test@thread.tacv2", ref);

    const retrieved = await store.get("19:tz-test@thread.tacv2");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.timezone).toBe("America/Los_Angeles");
  });

  it("preserves existing timezone when upsert omits timezone", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const store = createMSTeamsConversationStoreFs({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      ttlMs: 60_000,
    });

    await store.upsert("19:tz-keep@thread.tacv2", {
      conversation: { id: "19:tz-keep@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
      timezone: "Europe/London",
    });

    // Second upsert without timezone field
    await store.upsert("19:tz-keep@thread.tacv2", {
      conversation: { id: "19:tz-keep@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    const retrieved = await store.get("19:tz-keep@thread.tacv2");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.timezone).toBe("Europe/London");
  });

  it("prefers the freshest personal conversation when a user has multiple references", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const store = createMSTeamsConversationStoreFs({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      ttlMs: 60_000,
    });

    await store.upsert("a:old-personal", {
      conversation: { id: "a:old-personal", conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "old-user", aadObjectId: "shared-aad" },
    });

    await store.upsert("19:group-chat", {
      conversation: { id: "19:group-chat", conversationType: "groupChat" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "group-user", aadObjectId: "shared-aad" },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    await store.upsert("a:new-personal", {
      conversation: { id: "a:new-personal", conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "new-user", aadObjectId: "shared-aad" },
    });

    await expect(store.findByUserId("shared-aad")).resolves.toEqual({
      conversationId: "a:new-personal",
      reference: expect.objectContaining({
        conversation: expect.objectContaining({
          id: "a:new-personal",
          conversationType: "personal",
        }),
        user: expect.objectContaining({ id: "new-user", aadObjectId: "shared-aad" }),
      }),
    });
  });
});

describe("msteams conversation store (memory)", () => {
  it("normalizes conversation ids the same way as the fs store", async () => {
    const store = createMSTeamsConversationStoreMemory();

    await store.upsert("conv-norm;messageid=123", {
      conversation: { id: "conv-norm" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    await expect(store.get("conv-norm")).resolves.toEqual(
      expect.objectContaining({
        conversation: { id: "conv-norm" },
      }),
    );
    await expect(store.remove("conv-norm")).resolves.toBe(true);
    await expect(store.get("conv-norm;messageid=123")).resolves.toBeNull();
  });

  it("upserts, lists, removes, and resolves users by both AAD and Bot Framework ids", async () => {
    const store = createMSTeamsConversationStoreMemory([
      {
        conversationId: "conv-a",
        reference: {
          conversation: { id: "conv-a" },
          user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
        },
      },
    ]);

    await store.upsert("conv-b", {
      conversation: { id: "conv-b" },
      user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
    });

    await expect(store.get("conv-a")).resolves.toEqual({
      conversation: { id: "conv-a" },
      user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
    });

    await expect(store.list()).resolves.toEqual([
      {
        conversationId: "conv-a",
        reference: {
          conversation: { id: "conv-a" },
          user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
        },
      },
      {
        conversationId: "conv-b",
        reference: {
          conversation: { id: "conv-b" },
          user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
        },
      },
    ]);

    await expect(store.findByUserId("  aad-b  ")).resolves.toEqual({
      conversationId: "conv-b",
      reference: {
        conversation: { id: "conv-b" },
        user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
      },
    });
    await expect(store.findByUserId("user-a")).resolves.toEqual({
      conversationId: "conv-a",
      reference: {
        conversation: { id: "conv-a" },
        user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
      },
    });
    await expect(store.findByUserId("   ")).resolves.toBeNull();

    await expect(store.remove("conv-a")).resolves.toBe(true);
    await expect(store.get("conv-a")).resolves.toBeNull();
    await expect(store.remove("missing")).resolves.toBe(false);
  });

  it("preserves existing timezone when upsert omits timezone, matching the fs store", async () => {
    const store = createMSTeamsConversationStoreMemory();

    await store.upsert("conv-tz", {
      conversation: { id: "conv-tz" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
      timezone: "Europe/London",
    });

    await store.upsert("conv-tz", {
      conversation: { id: "conv-tz" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    await expect(store.get("conv-tz")).resolves.toMatchObject({
      timezone: "Europe/London",
    });
  });
});
