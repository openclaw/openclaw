import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IdentityStore } from "./identity-store.js";

describe("IdentityStore", () => {
  let dataDir: string;
  let store: IdentityStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "identity-store-test-"));
    store = new IdentityStore(dataDir);
    await store.load();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("createIdentity", () => {
    it("creates an identity with a platform link", () => {
      const id = store.createIdentity({
        name: "Alice",
        platform: "telegram",
        platformUserId: "tg-123",
      });
      expect(id.name).toBe("Alice");
      expect(id.links.telegram).toBe("tg-123");
      expect(id.id).toBeTruthy();
    });
  });

  describe("findByPlatform", () => {
    it("finds identity by platform + userId", () => {
      const created = store.createIdentity({
        name: "Bob",
        platform: "feishu",
        platformUserId: "fs-456",
      });
      const found = store.findByPlatform("feishu", "fs-456");
      expect(found?.id).toBe(created.id);
    });

    it("returns undefined for unknown platform user", () => {
      expect(store.findByPlatform("discord", "unknown")).toBeUndefined();
    });
  });

  describe("linkPlatform / unlinkPlatform", () => {
    it("links an additional platform to an identity", () => {
      const id = store.createIdentity({
        name: "Carol",
        platform: "telegram",
        platformUserId: "tg-789",
      });
      const linked = store.linkPlatform(id.id, "discord", "dc-789");
      expect(linked).toBe(true);

      const found = store.findByPlatform("discord", "dc-789");
      expect(found?.id).toBe(id.id);
      expect(found?.links.discord).toBe("dc-789");
    });

    it("unlinks a platform from an identity", () => {
      const id = store.createIdentity({
        name: "Dave",
        platform: "telegram",
        platformUserId: "tg-111",
      });
      store.linkPlatform(id.id, "feishu", "fs-111");

      const unlinked = store.unlinkPlatform(id.id, "feishu");
      expect(unlinked).toBe(true);
      expect(store.findByPlatform("feishu", "fs-111")).toBeUndefined();
    });

    it("returns false for non-existent identity", () => {
      expect(store.linkPlatform("nonexistent", "x", "y")).toBe(false);
    });
  });

  describe("searchByName", () => {
    it("finds identities by substring match", () => {
      store.createIdentity({ name: "Alice Smith", platform: "tg", platformUserId: "1" });
      store.createIdentity({ name: "Bob Jones", platform: "tg", platformUserId: "2" });
      store.createIdentity({ name: "alice lee", platform: "tg", platformUserId: "3" });

      const results = store.searchByName("alice");
      expect(results).toHaveLength(2);
    });
  });

  describe("verification flow", () => {
    it("creates and verifies a linking code", () => {
      const id = store.createIdentity({
        name: "Eve",
        platform: "telegram",
        platformUserId: "tg-eve",
      });

      const code = store.createVerification({
        identityId: id.id,
        fromPlatform: "telegram",
        fromPlatformUserId: "tg-eve",
        targetPlatform: "feishu",
        targetPlatformUserId: "fs-eve",
      });
      expect(code).toHaveLength(6);

      const result = store.verifyCode(code, 600_000, 5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identityId).toBe(id.id);
      }

      // Platform should now be linked.
      const found = store.findByPlatform("feishu", "fs-eve");
      expect(found?.id).toBe(id.id);
    });

    it("rejects expired codes", () => {
      const id = store.createIdentity({
        name: "Frank",
        platform: "tg",
        platformUserId: "tg-frank",
      });
      const code = store.createVerification({
        identityId: id.id,
        fromPlatform: "tg",
        fromPlatformUserId: "tg-frank",
        targetPlatform: "dc",
        targetPlatformUserId: "dc-frank",
      });

      // Verify with 0 TTL — should be expired.
      const result = store.verifyCode(code, 0, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("expired");
      }
    });

    it("rejects invalid codes", () => {
      const result = store.verifyCode("000000", 600_000, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("invalid_code");
      }
    });
  });

  describe("resolveSender", () => {
    it("creates a new identity for unknown senders", () => {
      const result = store.resolveSender("telegram", "tg-new", "New User");
      expect(result.isNew).toBe(true);
      expect(result.identityId).toBeTruthy();
    });

    it("returns existing identity for known senders", () => {
      const id = store.createIdentity({
        name: "Known",
        platform: "telegram",
        platformUserId: "tg-known",
      });
      const result = store.resolveSender("telegram", "tg-known");
      expect(result.isNew).toBe(false);
      expect(result.identityId).toBe(id.id);
    });
  });

  describe("persistence", () => {
    it("saves and loads identities across instances", async () => {
      store.createIdentity({
        name: "Persistent",
        platform: "telegram",
        platformUserId: "tg-persist",
      });
      await store.save();

      const store2 = new IdentityStore(dataDir);
      await store2.load();
      const found = store2.findByPlatform("telegram", "tg-persist");
      expect(found?.name).toBe("Persistent");
    });
  });
});
