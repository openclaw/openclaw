import { describe, expect, it } from "vitest";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";
import { resolveCodexUpstreamForkBoundaryFromTurns } from "./upstream-fork-boundary.js";

function item(type: string, overrides: Record<string, unknown> = {}): CodexThreadItem {
  return { id: `${type}-item`, type, ...overrides } as CodexThreadItem;
}

function user(text: string): CodexThreadItem {
  return item("userMessage", { content: [{ type: "text", text, textElements: [] }] });
}

function turn(id: string, items: CodexThreadItem[], overrides: Partial<CodexTurn> = {}): CodexTurn {
  return { id, status: "completed", items, ...overrides };
}

describe("resolveCodexUpstreamForkBoundaryFromTurns", () => {
  it("maps the local user ordinal to the upstream turn", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("one")]), turn("turn-2", [user("two")])],
      userMessageOrdinal: 1,
      localText: "two",
    });

    expect(result).toEqual({
      ok: true,
      boundary: { beforeTurnId: "turn-2", targetTurnId: "turn-2" },
    });
  });

  it("returns a whole-thread boundary for the first turn", () => {
    expect(
      resolveCodexUpstreamForkBoundaryFromTurns({
        turns: [turn("turn-1", [user("one")])],
        userMessageOrdinal: 0,
        localText: "one",
      }),
    ).toEqual({
      ok: true,
      boundary: { wholeThread: true, targetTurnId: "turn-1" },
    });
  });

  it("rejects a selected steer message", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("one"), user("steer")])],
      userMessageOrdinal: 1,
      localText: "steer",
    });

    expect(result).toMatchObject({ ok: false, code: "steer-message" });
  });

  it("skips prompts inside review spans", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [
        turn("turn-review", [
          item("enteredReviewMode"),
          user("hidden review prompt"),
          item("exitedReviewMode"),
        ]),
        turn("turn-2", [user("visible")]),
      ],
      userMessageOrdinal: 0,
      localText: "visible",
    });

    expect(result).toEqual({
      ok: true,
      boundary: { beforeTurnId: "turn-2", targetTurnId: "turn-2" },
    });
  });

  it("rejects an in-progress target turn", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("one")], { status: "inProgress" })],
      userMessageOrdinal: 0,
      localText: "one",
    });

    expect(result).toMatchObject({ ok: false, code: "in-progress-turn" });
  });

  it("rejects local and upstream text drift", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("persisted")])],
      userMessageOrdinal: 0,
      localText: "local mirror",
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });
});
