import { afterEach, describe, expect, it } from "vitest";
import {
  listKnownNames,
  lookupMention,
  recordMention,
  recordSender,
  resetMentionRegistryForTests,
} from "./mention-registry.js";

const ACC = "bot1";
const CHAT = "oc_chat1";

afterEach(() => {
  resetMentionRegistryForTests();
});

describe("mention-registry", () => {
  describe("R1: recordMention", () => {
    it("records and looks up a mention by exact name", () => {
      recordMention({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "ou_alice" });
      const entry = lookupMention({ accountId: ACC, chatId: CHAT, name: "Alice" });
      expect(entry).toBeDefined();
      expect(entry!.openId).toBe("ou_alice");
      expect(entry!.source).toBe("mention");
    });

    it("lookup is case-insensitive", () => {
      recordMention({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "ou_alice" });
      expect(lookupMention({ accountId: ACC, chatId: CHAT, name: "alice" })?.openId).toBe(
        "ou_alice",
      );
      expect(lookupMention({ accountId: ACC, chatId: CHAT, name: "ALICE" })?.openId).toBe(
        "ou_alice",
      );
    });

    it("returns undefined for unknown names", () => {
      expect(lookupMention({ accountId: ACC, chatId: CHAT, name: "Bob" })).toBeUndefined();
    });

    it("isolates registries by chat", () => {
      recordMention({ accountId: ACC, chatId: "oc_1", name: "Alice", openId: "ou_a1" });
      recordMention({ accountId: ACC, chatId: "oc_2", name: "Alice", openId: "ou_a2" });
      expect(lookupMention({ accountId: ACC, chatId: "oc_1", name: "Alice" })?.openId).toBe(
        "ou_a1",
      );
      expect(lookupMention({ accountId: ACC, chatId: "oc_2", name: "Alice" })?.openId).toBe(
        "ou_a2",
      );
    });

    it("isolates registries by account", () => {
      recordMention({ accountId: "app1", chatId: CHAT, name: "Alice", openId: "ou_a1" });
      recordMention({ accountId: "app2", chatId: CHAT, name: "Alice", openId: "ou_a2" });
      expect(lookupMention({ accountId: "app1", chatId: CHAT, name: "Alice" })?.openId).toBe(
        "ou_a1",
      );
      expect(lookupMention({ accountId: "app2", chatId: CHAT, name: "Alice" })?.openId).toBe(
        "ou_a2",
      );
    });
  });

  describe("R4: recordSender", () => {
    it("records and looks up a sender", () => {
      recordSender({ accountId: ACC, chatId: CHAT, name: "Bob", openId: "ou_bob" });
      const entry = lookupMention({ accountId: ACC, chatId: CHAT, name: "Bob" });
      expect(entry).toBeDefined();
      expect(entry!.openId).toBe("ou_bob");
      expect(entry!.source).toBe("sender");
    });

    it("mention source does not get downgraded to sender for same openId", () => {
      recordMention({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "ou_alice" });
      recordSender({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "ou_alice" });
      expect(lookupMention({ accountId: ACC, chatId: CHAT, name: "Alice" })?.source).toBe(
        "mention",
      );
    });

    it("sender does not overwrite a mention's openId, even when different", () => {
      // A mention is the authoritative name→openId source (Feishu resolves the
      // @-target's open_id directly). A later sender with the same display name
      // but a different open_id must not clobber it — names can collide across
      // distinct users, and the explicitly @-mentioned one is the safer match.
      recordMention({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "ou_old" });
      recordSender({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "ou_new" });
      const entry = lookupMention({ accountId: ACC, chatId: CHAT, name: "Alice" });
      expect(entry?.openId).toBe("ou_old");
      expect(entry?.source).toBe("mention");
    });
  });

  describe("fuzzy lookup", () => {
    it("matches after stripping whitespace", () => {
      recordMention({ accountId: ACC, chatId: CHAT, name: "Li Si", openId: "ou_lisi" });
      expect(lookupMention({ accountId: ACC, chatId: CHAT, name: "LiSi" })?.openId).toBe("ou_lisi");
    });
  });

  describe("listKnownNames", () => {
    it("returns all recorded names", () => {
      recordMention({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "ou_a" });
      recordSender({ accountId: ACC, chatId: CHAT, name: "Bob", openId: "ou_b" });
      const names = listKnownNames({ accountId: ACC, chatId: CHAT });
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
    });

    it("returns empty array for unknown chat", () => {
      expect(listKnownNames({ accountId: ACC, chatId: "oc_unknown" })).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("ignores empty name or openId", () => {
      recordMention({ accountId: ACC, chatId: CHAT, name: "", openId: "ou_x" });
      recordMention({ accountId: ACC, chatId: CHAT, name: "Alice", openId: "" });
      expect(listKnownNames({ accountId: ACC, chatId: CHAT })).toEqual([]);
    });
  });
});
