import type { SessionUpstreamProbe } from "openclaw/plugin-sdk/session-catalog";
import { describe, expect, it, vi } from "vitest";
import type { CodexTurn } from "./app-server/protocol.js";
import {
  checkCodexUpstreamActivity,
  classifyCodexUpstreamTurns,
} from "./session-upstream-activity.js";

function probe(overrides: Partial<SessionUpstreamProbe> = {}): SessionUpstreamProbe {
  return {
    sessionKey: "agent:main:adopted:codex",
    agentId: "main",
    threadId: "thread-1",
    hostId: "gateway:local",
    upstreamKind: "codex-app-server",
    upstreamRef: { connectionFingerprint: "connection-1", threadId: "thread-1" },
    marker: { turnId: "turn-1", userMessageCount: 1 },
    ownRecentUserTexts: [],
    ...overrides,
  };
}

function turn(id: string, itemTypes: string[], startedAt: number): CodexTurn {
  return {
    id,
    startedAt,
    items: itemTypes.map((type, index) => ({
      id: `${id}-item-${index}`,
      type,
      text: type === "userMessage" ? `${id} prompt ${index}` : "",
    })) as CodexTurn["items"],
  };
}

describe("Codex upstream activity", () => {
  it("counts userMessage turns and uses the latest human timestamp", () => {
    expect(
      classifyCodexUpstreamTurns({
        probe: probe(),
        turns: [
          turn("turn-4", ["agentMessage"], 400),
          turn("turn-3", ["userMessage", "agentMessage"], 300),
          turn("turn-2", ["agentMessage"], 200),
          turn("turn-1", ["userMessage"], 100),
        ],
      }),
    ).toEqual({
      sessionKey: "agent:main:adopted:codex",
      occurredAt: 300_000,
      humanTurns: 1,
      nextMarker: { turnId: "turn-4", userMessageCount: 0 },
      dedupeId: "turn-4:0",
    });
  });

  it("uses the pinned connection and a bounded descending summary page", async () => {
    const listTurnPage = vi.fn(async () => ({
      data: [turn("turn-2", ["userMessage"], 200), turn("turn-1", [], 100)],
    }));
    const control: Parameters<typeof checkCodexUpstreamActivity>[1] = {
      connectionFingerprint: "connection-1",
      listTurnPage,
      withPinnedConnection: async (run) => await run(control),
    };

    await expect(
      checkCodexUpstreamActivity([probe()], control, async () => "thread-canonical"),
    ).resolves.toEqual([expect.objectContaining({ dedupeId: "turn-2:1", humanTurns: 1 })]);
    expect(listTurnPage).toHaveBeenCalledWith({
      threadId: "thread-canonical",
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    });
  });

  it("isolates a stale thread from healthy probes", async () => {
    const listTurnPage = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === "thread-stale") {
        throw new Error("thread missing");
      }
      return { data: [turn("turn-2", ["userMessage"], 200), turn("turn-1", [], 100)] };
    });
    const control: Parameters<typeof checkCodexUpstreamActivity>[1] = {
      connectionFingerprint: "connection-1",
      listTurnPage,
      withPinnedConnection: async (run) => await run(control),
    };

    await expect(
      checkCodexUpstreamActivity(
        [probe({ threadId: "thread-stale" }), probe({ sessionKey: "healthy" })],
        control,
      ),
    ).resolves.toEqual([expect.objectContaining({ sessionKey: "healthy" })]);
  });

  it("detects a steer-appended user message on the marker turn", () => {
    expect(
      classifyCodexUpstreamTurns({
        probe: probe({ marker: { turnId: "turn-1", userMessageCount: 1 } }),
        turns: [turn("turn-1", ["userMessage", "agentMessage", "userMessage"], 100)],
      }),
    ).toEqual({
      sessionKey: "agent:main:adopted:codex",
      occurredAt: 100_000,
      humanTurns: 1,
      nextMarker: { turnId: "turn-1", userMessageCount: 2 },
      dedupeId: "turn-1:2",
    });
  });

  it("upgrades a legacy turn marker without reporting existing steers", () => {
    expect(
      classifyCodexUpstreamTurns({
        probe: probe({ marker: { turnId: "turn-1" } }),
        turns: [turn("turn-1", ["userMessage", "agentMessage", "userMessage"], 100)],
      }),
    ).toEqual({
      sessionKey: "agent:main:adopted:codex",
      humanTurns: 0,
      nextMarker: { turnId: "turn-1", userMessageCount: 2 },
    });
  });

  it("filters OpenClaw-authored user items by normalized transcript text", () => {
    expect(
      classifyCodexUpstreamTurns({
        probe: probe({
          marker: { turnId: "turn-1", userMessageCount: 0 },
          ownRecentUserTexts: ["same prompt"],
        }),
        turns: [
          {
            ...turn("turn-1", [], 100),
            items: [
              {
                id: "user-1",
                type: "userMessage",
                text: "",
                content: [{ type: "text", text: " same   prompt ", text_elements: [] }],
              } as unknown as CodexTurn["items"][number],
            ],
          },
        ],
      }),
    ).toEqual({
      sessionKey: "agent:main:adopted:codex",
      humanTurns: 0,
      nextMarker: { turnId: "turn-1", userMessageCount: 1 },
    });
  });

  it("filters a batched OpenClaw steer by its component transcript texts", () => {
    expect(
      classifyCodexUpstreamTurns({
        probe: probe({
          marker: { turnId: "turn-1", userMessageCount: 0 },
          ownRecentUserTexts: ["first steer", "second steer"],
        }),
        turns: [
          {
            ...turn("turn-1", [], 100),
            items: [
              {
                id: "user-1",
                type: "userMessage",
                text: "",
                content: [
                  { type: "text", text: " first   steer ", text_elements: [] },
                  { type: "text", text: "second steer", text_elements: [] },
                ],
              } as unknown as CodexTurn["items"][number],
            ],
          },
        ],
      }),
    ).toEqual({
      sessionKey: "agent:main:adopted:codex",
      humanTurns: 0,
      nextMarker: { turnId: "turn-1", userMessageCount: 1 },
    });
  });
});
