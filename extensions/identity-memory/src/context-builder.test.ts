import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildMemoryContext } from "./context-builder.js";
import { IdentityStore } from "./identity-store.js";
import { MemoryStore } from "./memory-store.js";

describe("buildMemoryContext", () => {
  let dataDir: string;
  let identityStore: IdentityStore;
  let memoryStore: MemoryStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "context-builder-test-"));
    identityStore = new IdentityStore(dataDir);
    memoryStore = new MemoryStore(dataDir);
    await identityStore.load();
    await memoryStore.load();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns undefined for unknown identity", async () => {
    const ctx = await buildMemoryContext({
      identityStore,
      memoryStore,
      identityId: "nonexistent",
      maxLength: 2000,
    });
    expect(ctx).toBeUndefined();
  });

  it("builds context with user profile", async () => {
    const identity = identityStore.createIdentity({
      name: "Alice",
      platform: "telegram",
      platformUserId: "tg-alice",
    });
    identityStore.linkPlatform(identity.id, "feishu", "fs-alice");
    memoryStore.updateProfile(identity.id, {
      preferences: ["dark mode"],
      expertise: ["TypeScript"],
    });
    memoryStore.recordInteraction(identity.id, ["deployment"]);

    const ctx = await buildMemoryContext({
      identityStore,
      memoryStore,
      identityId: identity.id,
      maxLength: 2000,
    });

    expect(ctx).toContain("Alice");
    expect(ctx).toContain("telegram");
    expect(ctx).toContain("feishu");
    expect(ctx).toContain("dark mode");
    expect(ctx).toContain("TypeScript");
  });

  it("includes episodic memories", async () => {
    const identity = identityStore.createIdentity({
      name: "Bob",
      platform: "discord",
      platformUserId: "dc-bob",
    });
    await memoryStore.writeEpisodic({
      identityId: identity.id,
      summary: "Discussed deployment pipeline",
      tags: ["deployment"],
      platform: "discord",
    });

    const ctx = await buildMemoryContext({
      identityStore,
      memoryStore,
      identityId: identity.id,
      currentMessage: "Tell me about deployment",
      maxLength: 2000,
    });

    expect(ctx).toContain("deployment pipeline");
  });

  it("truncates context to maxLength", async () => {
    const identity = identityStore.createIdentity({
      name: "Carol",
      platform: "telegram",
      platformUserId: "tg-carol",
    });
    // Write many entries to exceed limit.
    for (let i = 0; i < 20; i++) {
      await memoryStore.writeEpisodic({
        identityId: identity.id,
        summary: `Long entry number ${i} with lots of text to fill up space quickly`,
        tags: ["test"],
      });
    }

    const ctx = await buildMemoryContext({
      identityStore,
      memoryStore,
      identityId: identity.id,
      maxLength: 200,
    });

    expect(ctx).toBeTruthy();
    expect(ctx!.length).toBeLessThanOrEqual(200);
  });
});
