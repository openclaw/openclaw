import { describe, expect, it } from "vitest";
import type {
  DoltActiveLaneEntry,
  DoltGhostSummary,
  DoltLineageEdge,
  DoltQueryAvailability,
  DoltQueryRecord,
  DoltReadOnlyQueryHelpers,
  SearchTurnPayloadMatch,
} from "../read-only-dolt-store.js";
import { createDoltDescribeTool } from "./dolt-describe.js";

type QueryFixture = {
  availability: DoltQueryAvailability;
  records: Record<string, DoltQueryRecord>;
  parents: Record<string, DoltLineageEdge[]>;
  children: Record<string, DoltLineageEdge[]>;
  lanes: Record<string, DoltActiveLaneEntry[]>;
  ghostSummaries: Record<string, DoltGhostSummary | null>;
};

function makeRecord(params: {
  pointer: string;
  sessionId: string;
  level: "turn" | "leaf" | "bindle";
  tokenCount: number;
  eventTsMs: number;
  payload: unknown;
  payloadJson?: string | null;
  finalizedAtReset?: boolean;
}): DoltQueryRecord {
  return {
    pointer: params.pointer,
    sessionId: params.sessionId,
    sessionKey: null,
    level: params.level,
    eventTsMs: params.eventTsMs,
    tokenCount: params.tokenCount,
    tokenCountMethod: "estimateTokens",
    payload: params.payload,
    payloadJson: params.payloadJson ?? JSON.stringify(params.payload),
    finalizedAtReset: params.finalizedAtReset ?? false,
    createdAtMs: params.eventTsMs,
    updatedAtMs: params.eventTsMs,
  };
}

function createQueries(fixture: QueryFixture): DoltReadOnlyQueryHelpers {
  return {
    getAvailability: () => fixture.availability,
    getRecord: (pointer: string) => fixture.records[pointer] ?? null,
    listDirectParents: (childPointer: string) => fixture.parents[childPointer] ?? [],
    listDirectChildren: (parentPointer: string) => fixture.children[parentPointer] ?? [],
    listDirectChildRecords: (_parentPointer: string) => [],
    listActiveLane: (sessionId: string, level, _activeOnly = true) =>
      fixture.lanes[`${sessionId}:${level}`] ?? [],
    getGhostSummary: (bindlePointer: string) => fixture.ghostSummaries[bindlePointer] ?? null,
    searchTurnPayloads: (_params): SearchTurnPayloadMatch[] => [],
  };
}

function getText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find((entry) => entry.type === "text");
  return typeof textBlock?.text === "string" ? textBlock.text : "";
}

describe("createDoltDescribeTool", () => {
  it("returns no-context messaging when dolt.db is unavailable", async () => {
    const tool = createDoltDescribeTool({
      queries: createQueries({
        availability: {
          available: false,
          dbPath: "/tmp/openclaw/dolt.db",
          reason: "missing_db",
        },
        records: {},
        parents: {},
        children: {},
        lanes: {},
        ghostSummaries: {},
      }),
    });

    const result = await tool.execute("id", { pointer: "turn:session-1:1:1" });
    expect(getText(result)).toContain("No context data");
  });

  it("returns a clear not-found response for unknown pointers", async () => {
    const tool = createDoltDescribeTool({
      queries: createQueries({
        availability: { available: true, dbPath: "/tmp/openclaw/dolt.db" },
        records: {},
        parents: {},
        children: {},
        lanes: {},
        ghostSummaries: {},
      }),
    });

    const result = await tool.execute("id", { pointer: "turn:session-1:missing:1" });
    expect(getText(result)).toContain("Pointer not found: turn:session-1:missing:1");
  });

  it("describes leaf metadata with parent bindle, child turns, and summary preview", async () => {
    const summary = "leaf-summary-".repeat(60);
    const bindlePointer = "bindle:session-1:100:1";
    const leafPointer = "leaf:session-1:100:1";
    const turnOne = "turn:session-1:100:1";
    const turnTwo = "turn:session-1:100:2";

    const tool = createDoltDescribeTool({
      queries: createQueries({
        availability: { available: true, dbPath: "/tmp/openclaw/dolt.db" },
        records: {
          [bindlePointer]: makeRecord({
            pointer: bindlePointer,
            sessionId: "session-1",
            level: "bindle",
            tokenCount: 44,
            eventTsMs: 1000,
            payload: { summary: "bindle summary" },
          }),
          [leafPointer]: makeRecord({
            pointer: leafPointer,
            sessionId: "session-1",
            level: "leaf",
            tokenCount: 20,
            eventTsMs: 2000,
            payload: { summary },
          }),
        },
        parents: {
          [leafPointer]: [
            {
              parentPointer: bindlePointer,
              childPointer: leafPointer,
              childIndex: 0,
              childLevel: "leaf",
              createdAtMs: 2100,
            },
          ],
        },
        children: {
          [leafPointer]: [
            {
              parentPointer: leafPointer,
              childPointer: turnOne,
              childIndex: 0,
              childLevel: "turn",
              createdAtMs: 2200,
            },
            {
              parentPointer: leafPointer,
              childPointer: turnTwo,
              childIndex: 1,
              childLevel: "turn",
              createdAtMs: 2300,
            },
          ],
        },
        lanes: {
          "session-1:leaf": [
            {
              sessionId: "session-1",
              sessionKey: null,
              level: "leaf",
              pointer: leafPointer,
              isActive: true,
              lastEventTsMs: 2000,
              updatedAtMs: 2000,
            },
          ],
        },
        ghostSummaries: {},
      }),
    });

    const result = await tool.execute("id", { pointer: leafPointer });
    const text = getText(result);
    expect(text).toContain("Level: leaf");
    expect(text).toContain(`Parent bindle: ${bindlePointer}`);
    expect(text).toContain(`Child turns: ${turnOne}, ${turnTwo}`);
    expect(text).toContain("Child count: 2");
    expect(text).toContain("Summary content:");
    expect(text).toContain("...");
  });

  it("describes bindle metadata with ghost summary and eviction state", async () => {
    const bindlePointer = "bindle:session-9:200:1";
    const leafOne = "leaf:session-9:200:1";
    const leafTwo = "leaf:session-9:200:2";

    const tool = createDoltDescribeTool({
      queries: createQueries({
        availability: { available: true, dbPath: "/tmp/openclaw/dolt.db" },
        records: {
          [bindlePointer]: makeRecord({
            pointer: bindlePointer,
            sessionId: "session-9",
            level: "bindle",
            tokenCount: 88,
            eventTsMs: 9000,
            payload: { summary: "bindle summary body" },
            finalizedAtReset: true,
          }),
        },
        parents: {},
        children: {
          [bindlePointer]: [
            {
              parentPointer: bindlePointer,
              childPointer: leafOne,
              childIndex: 0,
              childLevel: "leaf",
              createdAtMs: 9010,
            },
            {
              parentPointer: bindlePointer,
              childPointer: leafTwo,
              childIndex: 1,
              childLevel: "leaf",
              createdAtMs: 9020,
            },
          ],
        },
        lanes: {
          "session-9:bindle": [
            {
              sessionId: "session-9",
              sessionKey: null,
              level: "bindle",
              pointer: bindlePointer,
              isActive: false,
              lastEventTsMs: 9000,
              updatedAtMs: 9000,
            },
          ],
        },
        ghostSummaries: {
          [bindlePointer]: {
            bindlePointer,
            summaryText: "ghost summary text",
            tokenCount: 17,
            row: {},
          },
        },
      }),
    });

    const result = await tool.execute("id", { pointer: bindlePointer });
    const text = getText(result);
    expect(text).toContain(`Child leaves: ${leafOne}, ${leafTwo}`);
    expect(text).toContain("Child count: 2");
    expect(text).toContain("Ghost summary: ghost summary text");
    expect(text).toContain("Ghost token count: 17");
    expect(text).toContain("Evicted: yes");
    expect(text).toContain("Finalized at reset: yes");
  });

  it("describes turn metadata with parent leaf, role, and content preview", async () => {
    const leafPointer = "leaf:session-2:10:1";
    const turnPointer = "turn:session-2:10:1";
    const content = "assistant-turn-".repeat(40);

    const tool = createDoltDescribeTool({
      queries: createQueries({
        availability: { available: true, dbPath: "/tmp/openclaw/dolt.db" },
        records: {
          [leafPointer]: makeRecord({
            pointer: leafPointer,
            sessionId: "session-2",
            level: "leaf",
            tokenCount: 10,
            eventTsMs: 10000,
            payload: { summary: "parent leaf summary" },
          }),
          [turnPointer]: makeRecord({
            pointer: turnPointer,
            sessionId: "session-2",
            level: "turn",
            tokenCount: 12,
            eventTsMs: 11000,
            payload: { role: "assistant", content },
          }),
        },
        parents: {
          [turnPointer]: [
            {
              parentPointer: leafPointer,
              childPointer: turnPointer,
              childIndex: 0,
              childLevel: "turn",
              createdAtMs: 11050,
            },
          ],
        },
        children: {},
        lanes: {
          "session-2:turn": [
            {
              sessionId: "session-2",
              sessionKey: null,
              level: "turn",
              pointer: turnPointer,
              isActive: true,
              lastEventTsMs: 11000,
              updatedAtMs: 11000,
            },
          ],
        },
        ghostSummaries: {},
      }),
    });

    const result = await tool.execute("id", { pointer: turnPointer });
    const text = getText(result);
    expect(text).toContain(`Parent leaf: ${leafPointer}`);
    expect(text).toContain("Role: assistant");
    expect(text).toContain("Content preview:");
    expect(text).toContain("...");
  });
});
