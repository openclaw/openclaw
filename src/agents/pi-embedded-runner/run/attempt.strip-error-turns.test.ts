import { describe, expect, it, vi } from "vitest";
import {
  isPureInfrastructureError,
  stripTrailingErrorFileEntries,
  stripTrailingErrorTurns,
} from "./attempt.strip-error-turns.js";

// ---------------------------------------------------------------------------
// isPureInfrastructureError predicate
// ---------------------------------------------------------------------------

describe("isPureInfrastructureError", () => {
  it("returns true for assistant error with empty content", () => {
    expect(
      isPureInfrastructureError({
        role: "assistant",
        stopReason: "error",
        content: [],
      }),
    ).toBe(true);
  });

  it("returns true for assistant error with no content array", () => {
    expect(
      isPureInfrastructureError({
        role: "assistant",
        stopReason: "error",
      }),
    ).toBe(true);
  });

  it("returns true for assistant error with text-only content", () => {
    // Provider returned text before failing — still infrastructure noise,
    // no tool state to preserve.
    expect(
      isPureInfrastructureError({
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "partial response..." }],
      }),
    ).toBe(true);
  });

  it("returns false for assistant error with ToolCall content (partial work)", () => {
    // This is the case tested in attempt.test.ts:1305 — errored turns with
    // valid tool-call state must be preserved for transcript repair.
    expect(
      isPureInfrastructureError({
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    ).toBe(false);
  });

  it("returns false for successful assistant turn", () => {
    expect(
      isPureInfrastructureError({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Hello!" }],
      }),
    ).toBe(false);
  });

  it("returns false for user turn", () => {
    expect(
      isPureInfrastructureError({
        role: "user",
        content: [{ type: "text", text: "hey" }],
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isPureInfrastructureError(null)).toBe(false);
    expect(isPureInfrastructureError(undefined)).toBe(false);
  });

  it("returns false for assistant with stopReason 'aborted'", () => {
    // Aborted turns are handled by stripSessionsYieldArtifacts, not us.
    expect(
      isPureInfrastructureError({
        role: "assistant",
        stopReason: "aborted",
        content: [],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripTrailingErrorTurns
// ---------------------------------------------------------------------------

describe("stripTrailingErrorTurns", () => {
  function makeSession(messages: unknown[]) {
    const agent = { replaceMessages: vi.fn() };
    return {
      messages: messages as never[],
      agent,
    };
  }

  it("strips trailing pure infrastructure errors and recovers exposed user turn", () => {
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hey" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      { role: "assistant", stopReason: "error", content: [] },
      { role: "assistant", stopReason: "error", content: [] },
    ]);
    const result = stripTrailingErrorTurns(session);
    expect(result.errorCount).toBe(2);
    // The exposed trailing user turn is also stripped and its text recovered.
    expect(result.recoveredUserText).toBe("again");
    expect(session.agent.replaceMessages).toHaveBeenCalledTimes(1);
    const replaced = session.agent.replaceMessages.mock.calls[0][0];
    expect(replaced).toHaveLength(2);
    expect(replaced[1].role).toBe("assistant");
  });

  it("preserves errored turns with ToolCall content", () => {
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "do stuff" }] },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", id: "c1", name: "exec", arguments: {} }],
      },
    ]);
    const result = stripTrailingErrorTurns(session);
    expect(result.errorCount).toBe(0);
    expect(result.recoveredUserText).toBeNull();
    expect(session.agent.replaceMessages).not.toHaveBeenCalled();
  });

  it("preserves non-trailing error turns", () => {
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hey" }] },
      { role: "assistant", stopReason: "error", content: [] },
      { role: "user", content: [{ type: "text", text: "retry" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
    ]);
    const result = stripTrailingErrorTurns(session);
    expect(result.errorCount).toBe(0);
    expect(result.recoveredUserText).toBeNull();
    expect(session.agent.replaceMessages).not.toHaveBeenCalled();
  });

  it("returns zero counts when no errors present", () => {
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hey" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
    ]);
    const result = stripTrailingErrorTurns(session);
    expect(result.errorCount).toBe(0);
    expect(result.recoveredUserText).toBeNull();
    expect(session.agent.replaceMessages).not.toHaveBeenCalled();
  });

  it("handles empty message array", () => {
    const session = makeSession([]);
    const result = stripTrailingErrorTurns(session);
    expect(result.errorCount).toBe(0);
    expect(result.recoveredUserText).toBeNull();
  });

  it("recovers user text when error follows user turn directly", () => {
    // The user's original prompt must be recovered, not silently lost.
    // Platform marks GUI messages read on delivery (before run completion),
    // so no replay source exists for the failed user request.
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hey" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "more" }] },
      { role: "assistant", stopReason: "error", content: [] },
    ]);
    const result = stripTrailingErrorTurns(session);
    expect(result.errorCount).toBe(1);
    expect(result.recoveredUserText).toBe("more");
    const replaced = session.agent.replaceMessages.mock.calls[0][0];
    // Both the error AND the user turn are stripped.
    expect(replaced).toHaveLength(2);
    expect(replaced[1].role).toBe("assistant");
  });

  it("returns null recoveredUserText when error follows assistant (not user)", () => {
    // Error after a successful assistant turn — no user turn to recover.
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hey" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", stopReason: "error", content: [] },
    ]);
    const result = stripTrailingErrorTurns(session);
    expect(result.errorCount).toBe(1);
    expect(result.recoveredUserText).toBeNull();
    const replaced = session.agent.replaceMessages.mock.calls[0][0];
    expect(replaced).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// stripTrailingErrorFileEntries
// ---------------------------------------------------------------------------

describe("stripTrailingErrorFileEntries", () => {
  function makeSessionManager(entries: unknown[]) {
    const byId = new Map<string, { id: string }>();
    for (const e of entries) {
      const entry = e as { id?: string };
      if (entry.id) {
        byId.set(entry.id, { id: entry.id });
      }
    }
    return {
      fileEntries: entries as never[],
      byId,
      leafId: (entries.at(-1) as { id?: string })?.id ?? null,
      _rewriteFile: vi.fn(),
    };
  }

  it("strips trailing error entries and updates byId, leafId, and rewrites file", () => {
    const sm = makeSessionManager([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", parentId: "s1", message: { role: "user" } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", stopReason: "stop" },
      },
      { type: "message", id: "m3", parentId: "m2", message: { role: "user" } },
      {
        type: "message",
        id: "m4",
        parentId: "m3",
        message: { role: "assistant", stopReason: "error", content: [] },
      },
    ]);

    const changed = stripTrailingErrorFileEntries(sm);
    expect(changed).toBe(true);

    // fileEntries should have m4 removed
    expect(sm.fileEntries).toHaveLength(4);
    expect(sm.fileEntries.at(-1)).toEqual(expect.objectContaining({ id: "m3" }));

    // byId should no longer contain m4
    expect(sm.byId.has("m4")).toBe(false);
    // Other entries should still be in byId
    expect(sm.byId.has("m1")).toBe(true);
    expect(sm.byId.has("m2")).toBe(true);

    // leafId should point to m3's parent (m3 is now tail)
    expect(sm.leafId).toBe("m3");

    // _rewriteFile should have been called exactly once
    expect(sm._rewriteFile).toHaveBeenCalledTimes(1);
  });

  it("strips multiple trailing error entries", () => {
    const sm = makeSessionManager([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", parentId: "s1", message: { role: "user" } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", stopReason: "error", content: [] },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        message: { role: "assistant", stopReason: "error", content: [] },
      },
    ]);

    const changed = stripTrailingErrorFileEntries(sm);
    expect(changed).toBe(true);
    expect(sm.fileEntries).toHaveLength(2); // session + user
    expect(sm.byId.has("m2")).toBe(false);
    expect(sm.byId.has("m3")).toBe(false);
    expect(sm.leafId).toBe("m1"); // m2's parentId (each pop sets leafId = last.parentId)
  });

  it("preserves errored entries with ToolCall content", () => {
    const sm = makeSessionManager([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", parentId: "s1", message: { role: "user" } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "toolCall", id: "c1", name: "exec" }],
        },
      },
    ]);

    const changed = stripTrailingErrorFileEntries(sm);
    expect(changed).toBe(false);
    expect(sm.fileEntries).toHaveLength(3);
    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  it("does not strip the session entry itself", () => {
    const sm = makeSessionManager([{ type: "session", id: "s1" }]);

    const changed = stripTrailingErrorFileEntries(sm);
    expect(changed).toBe(false);
    expect(sm.fileEntries).toHaveLength(1);
  });

  it("returns false when sessionManager is null/undefined", () => {
    expect(stripTrailingErrorFileEntries(null)).toBe(false);
    expect(stripTrailingErrorFileEntries(undefined)).toBe(false);
  });

  it("returns false when sessionManager has no fileEntries", () => {
    expect(stripTrailingErrorFileEntries({ byId: new Map() })).toBe(false);
  });

  it("preserves non-trailing error entries", () => {
    const sm = makeSessionManager([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", parentId: "s1", message: { role: "user" } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", stopReason: "error", content: [] },
      },
      { type: "message", id: "m3", parentId: "m2", message: { role: "user" } },
      {
        type: "message",
        id: "m4",
        parentId: "m3",
        message: { role: "assistant", stopReason: "stop", content: [] },
      },
    ]);

    const changed = stripTrailingErrorFileEntries(sm);
    expect(changed).toBe(false);
    expect(sm.fileEntries).toHaveLength(5);
  });

  it("strips trailing user turn when stripUserTurn=true", () => {
    const sm = makeSessionManager([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", parentId: "s1", message: { role: "user" } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", stopReason: "error", content: [] },
      },
    ]);

    const changed = stripTrailingErrorFileEntries(sm, true);
    expect(changed).toBe(true);
    // Both error entry AND user entry stripped
    expect(sm.fileEntries).toHaveLength(1);
    expect(sm.byId.has("m1")).toBe(false);
    expect(sm.byId.has("m2")).toBe(false);
    expect(sm.leafId).toBe("s1");
    expect(sm._rewriteFile).toHaveBeenCalledTimes(1);
  });

  it("does NOT strip trailing user turn when stripUserTurn=false (default)", () => {
    const sm = makeSessionManager([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", parentId: "s1", message: { role: "user" } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", stopReason: "error", content: [] },
      },
    ]);

    const changed = stripTrailingErrorFileEntries(sm);
    expect(changed).toBe(true);
    // Only error entry stripped, user entry preserved
    expect(sm.fileEntries).toHaveLength(2);
    expect(sm.byId.has("m1")).toBe(true);
    expect(sm.byId.has("m2")).toBe(false);
    expect(sm.leafId).toBe("m1");
  });
});
