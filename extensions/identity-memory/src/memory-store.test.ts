import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "./memory-store.js";

describe("MemoryStore", () => {
  let dataDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "memory-store-test-"));
    store = new MemoryStore(dataDir);
    await store.load();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("episodic memory", () => {
    it("writes and reads episodic entries", async () => {
      await store.writeEpisodic({
        identityId: "id-1",
        summary: "User asked about weather",
        tags: ["weather", "smalltalk"],
      });
      await store.writeEpisodic({
        identityId: "id-1",
        summary: "User asked about code review",
        tags: ["code", "review"],
      });

      const entries = await store.readEpisodic("id-1");
      expect(entries).toHaveLength(2);
      expect(entries[0].summary).toBe("User asked about weather");
    });

    it("returns empty array for unknown identity", async () => {
      const entries = await store.readEpisodic("nonexistent");
      expect(entries).toHaveLength(0);
    });

    it("searches by tags", async () => {
      await store.writeEpisodic({
        identityId: "id-2",
        summary: "Discussed Python",
        tags: ["python", "coding"],
      });
      await store.writeEpisodic({
        identityId: "id-2",
        summary: "Discussed TypeScript",
        tags: ["typescript", "coding"],
      });
      await store.writeEpisodic({
        identityId: "id-2",
        summary: "Asked about lunch",
        tags: ["food"],
      });

      const results = await store.searchEpisodic({
        identityId: "id-2",
        tags: ["coding"],
      });
      expect(results).toHaveLength(2);
    });

    it("searches by keyword", async () => {
      await store.writeEpisodic({
        identityId: "id-3",
        summary: "Fixed a critical bug in the parser",
        tags: ["bugfix"],
      });
      await store.writeEpisodic({
        identityId: "id-3",
        summary: "Added new feature for auth",
        tags: ["feature"],
      });

      const results = await store.searchEpisodic({
        identityId: "id-3",
        keyword: "parser",
      });
      expect(results).toHaveLength(1);
      expect(results[0].summary).toContain("parser");
    });

    it("compresses old entries", async () => {
      for (let i = 0; i < 10; i++) {
        await store.writeEpisodic({
          identityId: "id-4",
          summary: `Entry ${i}`,
          tags: ["test"],
        });
      }

      const removed = await store.compressEpisodic("id-4", 5);
      expect(removed).toHaveLength(5);

      const remaining = await store.readEpisodic("id-4");
      expect(remaining).toHaveLength(5);
    });

    it("counts entries correctly", async () => {
      await store.writeEpisodic({ identityId: "id-5", summary: "a", tags: [] });
      await store.writeEpisodic({ identityId: "id-5", summary: "b", tags: [] });
      expect(await store.countEpisodic("id-5")).toBe(2);
    });
  });

  describe("semantic memory (profiles)", () => {
    it("creates a default profile", () => {
      const profile = store.getProfile("id-10");
      expect(profile.identityId).toBe("id-10");
      expect(profile.interactionCount).toBe(0);
      expect(profile.preferences).toEqual([]);
    });

    it("updates profile preferences", () => {
      store.updateProfile("id-11", {
        name: "Alice",
        preferences: ["dark mode", "concise replies"],
        expertise: ["TypeScript"],
      });

      const profile = store.getProfile("id-11");
      expect(profile.name).toBe("Alice");
      expect(profile.preferences).toContain("dark mode");
      expect(profile.expertise).toContain("TypeScript");
    });

    it("records interactions", () => {
      store.recordInteraction("id-12", ["deployment"]);
      store.recordInteraction("id-12", ["debugging"]);

      const profile = store.getProfile("id-12");
      expect(profile.interactionCount).toBe(2);
      expect(profile.recentTopics).toContain("deployment");
      expect(profile.recentTopics).toContain("debugging");
    });

    it("persists profiles", async () => {
      store.updateProfile("id-13", { name: "Persistent User" });
      await store.save();

      const store2 = new MemoryStore(dataDir);
      await store2.load();
      const profile = store2.getProfile("id-13");
      expect(profile.name).toBe("Persistent User");
    });
  });
});
