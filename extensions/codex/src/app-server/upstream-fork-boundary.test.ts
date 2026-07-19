import { describe, expect, it, vi } from "vitest";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";
import {
  resolveCodexUpstreamForkBoundary,
  resolveCodexUpstreamForkBoundaryFromTurns,
} from "./upstream-fork-boundary.js";

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
      localPrefixTexts: ["one", "two"],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-2",
        targetTurnId: "turn-2",
        retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
      },
    });
  });

  it("rejects a cut at the first turn instead of copying the whole thread", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("one")])],
      userMessageOrdinal: 0,
      localPrefixTexts: ["one"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("first-message");
    }
  });

  it("rejects a selected steer message", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("one"), user("steer")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["one", "steer"],
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
      localPrefixTexts: ["visible"],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-2",
        targetTurnId: "turn-2",
        retainedMarker: { turnId: "turn-review", userMessageCount: 1 },
      },
    });
  });

  it("rejects an in-progress target turn", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("one")], { status: "inProgress" })],
      userMessageOrdinal: 0,
      localPrefixTexts: ["one"],
    });

    expect(result).toMatchObject({ ok: false, code: "in-progress-turn" });
  });

  it("rejects local and upstream text drift", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("persisted")])],
      userMessageOrdinal: 0,
      localPrefixTexts: ["local mirror"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects equal targets over divergent prefixes", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("upstream-old")]), turn("turn-2", [user("target")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["local-old", "target"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects upstream messages carrying semantic non-text inputs", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [
        turn("turn-1", [
          item("userMessage", {
            content: [
              { type: "text", text: "one", textElements: [] },
              { type: "skill", name: "reviewer" },
            ],
          }),
        ]),
        turn("turn-2", [user("target")]),
      ],
      userMessageOrdinal: 1,
      localPrefixTexts: ["one", "target"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects prefixes whose content identity cannot be verified", () => {
    const result = resolveCodexUpstreamForkBoundaryFromTurns({
      turns: [turn("turn-1", [user("one")]), turn("turn-2", [user("target")])],
      userMessageOrdinal: 1,
      localPrefixTexts: [undefined, "target"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });
});

describe("resolveCodexUpstreamForkBoundary", () => {
  it("rejects paginated-history threads before reading turns", async () => {
    const readThread = vi.fn(async () => ({ id: "thread-1", historyMode: "paginated" }));
    const result = await resolveCodexUpstreamForkBoundary({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:upstream",
      storePath: "/tmp/does-not-matter",
      entryId: "entry-1",
      threadId: "thread-1",
      control: { readThread } as unknown as Parameters<
        typeof resolveCodexUpstreamForkBoundary
      >[0]["control"],
    });

    expect(result).toMatchObject({ ok: false, code: "upstream-unavailable" });
    expect(readThread).toHaveBeenCalledWith("thread-1", false);
  });
});
