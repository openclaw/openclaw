import { describe, expect, it } from "vitest";
import type {
  DoltActiveLaneEntry,
  DoltLineageEdge,
  DoltQueryAvailability,
  DoltQueryRecord,
  DoltReadOnlyQueryHelpers,
  DoltRecordLevel,
  SearchTurnPayloadMatch,
} from "../read-only-dolt-store.js";
import { createDoltGrepTool } from "./dolt-grep.js";

describe("createDoltGrepTool", () => {
  it("returns a helpful error for invalid regex patterns", async () => {
    const tool = createDoltGrepTool({
      queries: createQueries({
        availability: {
          available: true,
          dbPath: "/tmp/dolt.db",
        },
      }),
    });

    await expect(
      tool.execute("call-1", {
        pattern: "(",
        session_id: "session-1",
      }),
    ).rejects.toThrow(/Invalid regex pattern/);
  });

  it("returns no-context fallback when the dolt DB is unavailable", async () => {
    const tool = createDoltGrepTool({
      queries: createQueries({
        availability: {
          available: false,
          dbPath: "/tmp/dolt.db",
          reason: "missing_db",
        },
      }),
    });

    const result = await tool.execute("call-1", {
      pattern: "hello",
      session_id: "session-1",
    });
    const text = readText(result);

    expect(text).toContain("No context data yet.");
    expect(text).toContain("/tmp/dolt.db");
  });

  it("groups matches by covering leaf and includes uncompacted turns", async () => {
    const tool = createDoltGrepTool({
      queries: createQueries({
        availability: {
          available: true,
          dbPath: "/tmp/dolt.db",
        },
        searchMatches: [
          {
            pointer: "turn-1",
            sessionId: "session-1",
            eventTsMs: 100,
            role: "assistant",
            content: "first matching content",
            payloadJson: null,
            coveringLeafPointer: "leaf-1",
          },
          {
            pointer: "turn-2",
            sessionId: "session-1",
            eventTsMs: 120,
            role: "user",
            content: "second matching content",
            payloadJson: null,
            coveringLeafPointer: "leaf-1",
          },
          {
            pointer: "turn-3",
            sessionId: "session-1",
            eventTsMs: 140,
            role: null,
            content: "floating match",
            payloadJson: null,
            coveringLeafPointer: null,
          },
        ],
        activeLeaves: [
          {
            sessionId: "session-1",
            sessionKey: null,
            level: "leaf",
            pointer: "leaf-1",
            isActive: true,
            lastEventTsMs: 120,
            updatedAtMs: 120,
          },
        ],
        records: [
          {
            pointer: "leaf-1",
            sessionId: "session-1",
            sessionKey: null,
            level: "leaf",
            eventTsMs: 99,
            tokenCount: 73,
            tokenCountMethod: "estimateTokens",
            payload: null,
            payloadJson: null,
            finalizedAtReset: false,
            createdAtMs: 99,
            updatedAtMs: 99,
          },
        ],
      }),
    });

    const result = await tool.execute("call-1", {
      pattern: "match",
      session_id: "session-1",
      parent_pointer: "bindle-1",
      page: 1,
    });
    const text = readText(result);

    expect(text).toContain("## Dolt Grep Results");
    expect(text).toContain("Pattern: `match`");
    expect(text).toContain("Session: session-1");
    expect(text).toContain("[Scoped to: bindle-1]");
    expect(text).toContain("### Covered by: leaf-1");
    expect(text).toContain("[level=leaf active=true tokens=~73]");
    expect(text).toContain("- [ts=100] (assistant): first matching content");
    expect(text).toContain("### Covered by: (uncompacted turns)");
    expect(text).toContain("[level=turn active=false tokens=~unknown]");
  });

  it("paginates at 50 results and surfaces next-page guidance", async () => {
    const matches: SearchTurnPayloadMatch[] = [];
    for (let i = 0; i < 51; i += 1) {
      matches.push({
        pointer: `turn-${i}`,
        sessionId: "session-1",
        eventTsMs: i,
        role: "assistant",
        content: `result-${i}`,
        payloadJson: null,
        coveringLeafPointer: "leaf-1",
      });
    }

    const tool = createDoltGrepTool({
      queries: createQueries({
        availability: { available: true, dbPath: "/tmp/dolt.db" },
        searchMatches: matches,
        records: [
          {
            pointer: "leaf-1",
            sessionId: "session-1",
            sessionKey: null,
            level: "leaf",
            eventTsMs: 1,
            tokenCount: 55,
            tokenCountMethod: "estimateTokens",
            payload: null,
            payloadJson: null,
            finalizedAtReset: false,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
    });

    const result = await tool.execute("call-1", {
      pattern: "result",
      session_id: "session-1",
      page: 2,
    });
    const text = readText(result);

    expect(text).toContain("Page: 2");
    expect(text).toContain("More results available. Use page=3 to see more.");
    expect(text).toContain("- [ts=49] (assistant): result-49");
    expect(text).not.toContain("- [ts=50] (assistant): result-50");
  });
});

function readText(result: Awaited<ReturnType<AnyExecuteTool["execute"]>>): string {
  const first = result.content?.[0];
  return first?.type === "text" ? first.text : "";
}

type AnyExecuteTool = ReturnType<typeof createDoltGrepTool>;

function createQueries(params: {
  availability: DoltQueryAvailability;
  searchMatches?: SearchTurnPayloadMatch[];
  activeLeaves?: DoltActiveLaneEntry[];
  records?: DoltQueryRecord[];
}): DoltReadOnlyQueryHelpers {
  const recordsByPointer = new Map(
    (params.records ?? []).map((record) => [record.pointer, record]),
  );
  return {
    getAvailability: () => params.availability,
    getRecord: (pointer) => recordsByPointer.get(pointer) ?? null,
    listDirectChildren: (_parentPointer: string): DoltLineageEdge[] => [],
    listDirectChildRecords: (_parentPointer: string): DoltQueryRecord[] => [],
    listActiveLane: (
      _sessionId: string,
      _level: DoltRecordLevel,
      _activeOnly = true,
    ): DoltActiveLaneEntry[] => params.activeLeaves ?? [],
    getGhostSummary: (_bindlePointer: string) => null,
    searchTurnPayloads: (_searchParams) => params.searchMatches ?? [],
  };
}
