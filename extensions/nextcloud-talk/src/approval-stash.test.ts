import { afterEach, describe, expect, it } from "vitest";
import {
  approvalStashSize,
  buildApprovalActions,
  clearApprovalStash,
  consumeApproval,
  lookupApproval,
  purgeExpiredApprovals,
  resolveReactionDecision,
  stashApproval,
} from "./approval-stash.js";

afterEach(() => {
  clearApprovalStash();
});

describe("buildApprovalActions", () => {
  it("maps the standard 3-decision set to keycap numerals", () => {
    const actions = buildApprovalActions(["allow-once", "allow-always", "deny"]);
    expect(actions).toEqual([
      { emoji: "1️⃣", decision: "allow-once" },
      { emoji: "2️⃣", decision: "allow-always" },
      { emoji: "3️⃣", decision: "deny" },
    ]);
  });

  it("falls back to 👍/👎 for a 2-decision set", () => {
    const actions = buildApprovalActions(["allow-once", "deny"]);
    expect(actions).toEqual([
      { emoji: "👍", decision: "allow-once" },
      { emoji: "👎", decision: "deny" },
    ]);
  });

  it("returns empty for an empty decision set", () => {
    expect(buildApprovalActions([])).toEqual([]);
  });

  it("maps a single-decision set to the binary fallback", () => {
    const actions = buildApprovalActions(["deny"]);
    expect(actions).toEqual([{ emoji: "👎", decision: "deny" }]);
  });
});

describe("stash / lookup / consume lifecycle", () => {
  it("stores and retrieves an approval entry", () => {
    stashApproval("acct-1", "room-A", "msg-10", {
      approvalId: "appr-123",
      approvalSlug: "appr-12",
      approvalKind: "exec",
      actions: [{ emoji: "1️⃣", decision: "allow-once" }],
    });

    const entry = lookupApproval("acct-1", "room-A", "msg-10");
    expect(entry).toBeDefined();
    expect(entry!.approvalId).toBe("appr-123");
    expect(entry!.approvalKind).toBe("exec");
    expect(entry!.createdAt).toBeGreaterThan(0);
    expect(approvalStashSize()).toBe(1);
  });

  it("returns undefined for unknown keys", () => {
    expect(lookupApproval("acct-1", "room-X", "msg-X")).toBeUndefined();
  });

  it("consume removes the entry", () => {
    stashApproval("acct-1", "room-A", "msg-10", {
      approvalId: "appr-1",
      approvalSlug: "appr-1",
      approvalKind: "exec",
      actions: [],
    });
    expect(approvalStashSize()).toBe(1);
    consumeApproval("acct-1", "room-A", "msg-10");
    expect(approvalStashSize()).toBe(0);
    expect(lookupApproval("acct-1", "room-A", "msg-10")).toBeUndefined();
  });
});

describe("resolveReactionDecision", () => {
  it("matches the emoji to the stashed action", () => {
    const entry = {
      approvalId: "a",
      approvalSlug: "a",
      approvalKind: "exec" as const,
      actions: [
        { emoji: "1️⃣", decision: "allow-once" as const },
        { emoji: "2️⃣", decision: "allow-always" as const },
        { emoji: "3️⃣", decision: "deny" as const },
      ],
      createdAt: Date.now(),
    };
    expect(resolveReactionDecision(entry, "2️⃣")).toBe("allow-always");
    expect(resolveReactionDecision(entry, "3️⃣")).toBe("deny");
  });

  it("returns undefined for non-matching emoji", () => {
    const entry = {
      approvalId: "a",
      approvalSlug: "a",
      approvalKind: "exec" as const,
      actions: [{ emoji: "1️⃣", decision: "allow-once" as const }],
      createdAt: Date.now(),
    };
    expect(resolveReactionDecision(entry, "🔥")).toBeUndefined();
  });
});

describe("purgeExpiredApprovals", () => {
  it("removes entries older than the TTL", () => {
    stashApproval("a", "r", "m1", {
      approvalId: "old",
      approvalSlug: "old",
      approvalKind: "exec",
      actions: [],
    });

    // Manually backdate the entry
    const entry = lookupApproval("a", "r", "m1")!;
    (entry as { createdAt: number }).createdAt = Date.now() - 20 * 60 * 1000;

    stashApproval("a", "r", "m2", {
      approvalId: "fresh",
      approvalSlug: "fresh",
      approvalKind: "exec",
      actions: [],
    });

    const removed = purgeExpiredApprovals(10 * 60 * 1000);
    expect(removed).toBe(1);
    expect(lookupApproval("a", "r", "m1")).toBeUndefined();
    expect(lookupApproval("a", "r", "m2")).toBeDefined();
  });

  it("returns 0 when nothing is expired", () => {
    stashApproval("a", "r", "m1", {
      approvalId: "x",
      approvalSlug: "x",
      approvalKind: "exec",
      actions: [],
    });
    expect(purgeExpiredApprovals()).toBe(0);
  });
});
