// Matrix tests cover approval reactions plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixApprovalReactionHint,
  clearMatrixApprovalReactionTargetsForTest,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTargetWithPersistence,
  unregisterMatrixApprovalReactionTarget,
} from "./approval-reactions.js";
import { setMatrixRuntime } from "./runtime.js";

function createRuntimeLogger(overrides: { warn?: ReturnType<typeof vi.fn> } = {}) {
  // Runtime state survives no-isolate workers, so expose every logger method later files may call.
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: overrides.warn ?? vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  clearMatrixApprovalReactionTargetsForTest();
  vi.restoreAllMocks();
});

describe("matrix approval reactions", () => {
  it("lists reactions in stable decision order", () => {
    expect(listMatrixApprovalReactionBindings(["allow-once", "deny", "allow-always"])).toEqual([
      { decision: "allow-once", emoji: "✅", label: "Allow once" },
      { decision: "allow-always", emoji: "♾️", label: "Allow always" },
      { decision: "deny", emoji: "❌", label: "Deny" },
    ]);
  });

  it("builds a compact reaction hint", () => {
    expect(buildMatrixApprovalReactionHint(["allow-once", "deny"])).toBe(
      "React here: ✅ Allow once, ❌ Deny",
    );
  });

  it("resolves a registered approval anchor event back to an approval decision", async () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "allow-once",
    });
    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "♾️",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "allow-always",
    });
    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "❌",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "deny",
    });
  });

  it("ignores reactions that are not allowed on the registered approval anchor event", async () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "deny"],
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "♾️",
      }),
    ).toBeNull();
  });

  it("stops resolving reactions after the approval anchor event is unregistered", async () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    unregisterMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).toBeNull();
  });

  it("persists approval reaction targets when runtime state is available", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue({
      version: 1,
      target: { approvalId: "req-persisted", allowedDecisions: ["deny"] },
    });
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMatrixRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => createRuntimeLogger() },
    } as never);

    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg-2",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "deny"],
      ttlMs: 1000,
    });

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith(
      "!ops:example.org:$approval-msg-2",
      {
        version: 1,
        target: { approvalId: "req-123", allowedDecisions: ["allow-once", "deny"] },
      },
      { ttlMs: 1000 },
    );

    clearMatrixApprovalReactionTargetsForTest();
    await expect(
      resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg-2",
        reactionKey: "❌",
      }),
    ).resolves.toEqual({ approvalId: "req-persisted", decision: "deny" });
    expect(openKeyedStore).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith("!ops:example.org:$approval-msg-2");
  });

  it("falls back to in-memory approval reaction targets when persistent state cannot open", async () => {
    const warn = vi.fn();
    setMatrixRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => createRuntimeLogger({ warn }) },
    } as never);

    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg-3",
      approvalId: "req-fallback",
      allowedDecisions: ["deny"],
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg-3",
        reactionKey: "❌",
      }),
    ).toEqual({ approvalId: "req-fallback", decision: "deny" });
    expect(warn).toHaveBeenCalled();
  });
});
