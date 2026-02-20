import { describe, expect, it } from "vitest";
import type {
  DoltQueryAvailability,
  DoltQueryRecord,
  DoltReadOnlyQueryHelpers,
} from "../read-only-dolt-store.js";
import { createDoltExpandTool } from "./dolt-expand.js";

function createRecord(overrides: Partial<DoltQueryRecord>): DoltQueryRecord {
  return {
    pointer: overrides.pointer ?? "record:pointer",
    sessionId: overrides.sessionId ?? "session-1",
    sessionKey: overrides.sessionKey ?? null,
    level: overrides.level ?? "leaf",
    eventTsMs: overrides.eventTsMs ?? 1_000,
    tokenCount: overrides.tokenCount ?? 7,
    tokenCountMethod: overrides.tokenCountMethod ?? "estimateTokens",
    payload: overrides.payload ?? {},
    payloadJson: overrides.payloadJson ?? JSON.stringify(overrides.payload ?? {}),
    finalizedAtReset: overrides.finalizedAtReset ?? false,
    createdAtMs: overrides.createdAtMs ?? 1_000,
    updatedAtMs: overrides.updatedAtMs ?? 1_000,
  };
}

function createQueries(params?: {
  availability?: DoltQueryAvailability;
  records?: Record<string, DoltQueryRecord>;
  childrenByParent?: Record<string, DoltQueryRecord[]>;
  activeBySessionLevel?: Record<string, string[]>;
  ghostSummaryByBindle?: Record<string, string>;
}): DoltReadOnlyQueryHelpers {
  const availability = params?.availability ?? {
    available: true,
    dbPath: "/tmp/dolt.db",
  };
  const records = params?.records ?? {};
  const childrenByParent = params?.childrenByParent ?? {};
  const activeBySessionLevel = params?.activeBySessionLevel ?? {};
  const ghostSummaryByBindle = params?.ghostSummaryByBindle ?? {};

  return {
    getAvailability: () => availability,
    getRecord: (pointer) => records[pointer] ?? null,
    listDirectChildren: (parentPointer) =>
      (childrenByParent[parentPointer] ?? []).map((child, idx) => ({
        parentPointer,
        childPointer: child.pointer,
        childIndex: idx,
        childLevel: child.level,
        createdAtMs: child.createdAtMs,
      })),
    listDirectChildRecords: (parentPointer) => childrenByParent[parentPointer] ?? [],
    listActiveLane: (sessionId, level) => {
      const key = `${sessionId}:${level}`;
      return (activeBySessionLevel[key] ?? []).map((pointer) => ({
        sessionId,
        sessionKey: null,
        level,
        pointer,
        isActive: true,
        lastEventTsMs: 1_000,
        updatedAtMs: 1_000,
      }));
    },
    getGhostSummary: (bindlePointer) => {
      const summary = ghostSummaryByBindle[bindlePointer];
      if (!summary) {
        return null;
      }
      return {
        bindlePointer,
        summaryText: summary,
        tokenCount: 10,
        row: {},
      };
    },
    searchTurnPayloads: () => [],
  };
}

function getText(
  result: Awaited<ReturnType<ReturnType<typeof createDoltExpandTool>["execute"]>>,
): string {
  return String(result.content?.[0]?.text ?? "");
}

describe("dolt_expand", () => {
  it("returns a no-context message when dolt.db is unavailable", async () => {
    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        availability: {
          available: false,
          dbPath: "/tmp/missing/dolt.db",
          reason: "missing_db",
        },
      }),
    });

    const result = await tool.execute("call1", { pointer: "leaf:missing" });
    expect(getText(result)).toContain("No context data yet.");
  });

  it("rejects calls from main sessions", async () => {
    const tool = createDoltExpandTool({
      sessionKey: "agent:main:main",
      queries: createQueries(),
    });

    const result = await tool.execute("call2", { pointer: "leaf:session-1:100:1" });
    const text = getText(result);

    expect(text).toContain("ERROR: Only sub-agents can expand dolt pointers.");
    expect(text).toContain(
      'Task(prompt="Use dolt_expand on leaf:session-1:100:1 to find <your question>")',
    );
  });

  it("returns not found for missing pointers", async () => {
    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries(),
    });

    const result = await tool.execute("call3", { pointer: "leaf:missing" });
    expect(getText(result)).toBe('No Dolt record found for pointer "leaf:missing".');
  });

  it("rejects turn pointers with guidance", async () => {
    const turn = createRecord({
      pointer: "turn:session-1:100:1",
      level: "turn",
      payload: { role: "assistant", content: "hello" },
    });
    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: {
          [turn.pointer]: turn,
        },
      }),
    });

    const result = await tool.execute("call4", { pointer: turn.pointer });
    const text = getText(result);
    expect(text).toContain("resolves to a turn record");
    expect(text).toContain("Use dolt_describe");
  });

  it("expands bindles into child leaf summaries", async () => {
    const bindle = createRecord({
      pointer: "bindle:session-1:100:1",
      level: "bindle",
      payload: { summary: "bindle payload summary" },
      tokenCount: 200,
    });
    const leaf1 = createRecord({
      pointer: "leaf:session-1:90:1",
      level: "leaf",
      payload: { summary: "first summary" },
      tokenCount: 90,
    });
    const leaf2 = createRecord({
      pointer: "leaf:session-1:95:1",
      level: "leaf",
      payload: { summary: "second summary" },
      tokenCount: 95,
    });

    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: {
          [bindle.pointer]: bindle,
        },
        childrenByParent: {
          [bindle.pointer]: [leaf1, leaf2],
        },
        activeBySessionLevel: {
          "session-1:bindle": [bindle.pointer],
        },
        ghostSummaryByBindle: {
          [bindle.pointer]: "ghost summary text",
        },
      }),
    });

    const result = await tool.execute("call5", { pointer: bindle.pointer });
    const text = getText(result);
    expect(text).toContain(`Pointer: ${bindle.pointer}`);
    expect(text).toContain("Status: active");
    expect(text).toContain("Ghost summary: ghost summary text");
    expect(text).toContain("--- Child 1");
    expect(text).toContain("first summary");
    expect(text).toContain("--- Child 2");
    expect(text).toContain("second summary");
  });

  it("expands leaves into child turn content (role + content)", async () => {
    const leaf = createRecord({
      pointer: "leaf:session-2:100:1",
      level: "leaf",
      payload: { summary: "leaf summary" },
      tokenCount: 100,
    });
    const turn = createRecord({
      pointer: "turn:session-2:105:1",
      level: "turn",
      payload: {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
      tokenCount: 20,
    });

    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: {
          [leaf.pointer]: leaf,
        },
        childrenByParent: {
          [leaf.pointer]: [turn],
        },
      }),
    });

    const result = await tool.execute("call6", { pointer: leaf.pointer });
    const text = getText(result);
    expect(text).toContain(`Pointer: ${leaf.pointer}`);
    expect(text).toContain("Role: assistant");
    expect(text).toContain("hello\nworld");
  });

  it("falls back to payload text when no lineage children are found", async () => {
    const leaf = createRecord({
      pointer: "leaf:session-3:100:1",
      level: "leaf",
      payload: { summary: "self summary" },
      tokenCount: 100,
    });

    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: {
          [leaf.pointer]: leaf,
        },
        childrenByParent: {
          [leaf.pointer]: [],
        },
      }),
    });

    const result = await tool.execute("call7", { pointer: leaf.pointer });
    const text = getText(result);
    expect(text).toContain("No lineage children were found for this pointer.");
    expect(text).toContain("self summary");
  });

  it("caps output near 40k and appends truncation guidance", async () => {
    const bindle = createRecord({
      pointer: "bindle:session-4:100:1",
      level: "bindle",
      payload: { summary: "root" },
      tokenCount: 400,
    });

    // Each child has only 50 tokens but a huge payload string, so the char
    // safety net in buildChildrenBody will kick in within a single page.
    const children = Array.from({ length: 50 }, (_unused, idx) =>
      createRecord({
        pointer: `leaf:session-4:${idx}:1`,
        level: "leaf",
        tokenCount: 50,
        payload: {
          summary: `summary-${idx} ${"x".repeat(2_000)}`,
        },
      }),
    );

    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: {
          [bindle.pointer]: bindle,
        },
        childrenByParent: {
          [bindle.pointer]: children,
        },
      }),
    });

    const result = await tool.execute("call8", { pointer: bindle.pointer });
    const text = getText(result);
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(text).toContain("more children not shown");
  });

  it("paginates leaf turns by token budget (~2k tokens per page)", async () => {
    const leaf = createRecord({
      pointer: "leaf:session-5:100:1",
      level: "leaf",
      payload: { summary: "a leaf" },
      tokenCount: 5000,
    });

    // 10 turns, each 500 tokens. Page budget is 2k, so:
    //   page 1: turns 1-4 (2000 tokens, exactly at budget → cut)
    //   page 2: turns 5-8 (2000 tokens)
    //   page 3: turns 9-10 (1000 tokens, remainder)
    const turns = Array.from({ length: 10 }, (_unused, idx) =>
      createRecord({
        pointer: `turn:session-5:${100 + idx}:1`,
        level: "turn",
        tokenCount: 500,
        payload: { role: "assistant", content: `message ${idx + 1}` },
      }),
    );

    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: { [leaf.pointer]: leaf },
        childrenByParent: { [leaf.pointer]: turns },
      }),
    });

    // Page 1 (default)
    const r1 = await tool.execute("call-p1", { pointer: leaf.pointer });
    const t1 = getText(r1);
    expect(t1).toContain("Page 1 of 3");
    expect(t1).toContain("10 children total");
    expect(t1).toContain("--- Child 1");
    expect(t1).toContain("--- Child 4");
    expect(t1).not.toContain("--- Child 5");
    expect(t1).toContain("page=2 for the next page");

    // Page 2
    const r2 = await tool.execute("call-p2", { pointer: leaf.pointer, page: 2 });
    const t2 = getText(r2);
    expect(t2).toContain("Page 2 of 3");
    expect(t2).toContain("--- Child 5");
    expect(t2).toContain("--- Child 8");
    expect(t2).not.toContain("--- Child 9");
    expect(t2).toContain("page=3 for the next page");

    // Page 3 (last page — no "next page" prompt)
    const r3 = await tool.execute("call-p3", { pointer: leaf.pointer, page: 3 });
    const t3 = getText(r3);
    expect(t3).toContain("Page 3 of 3");
    expect(t3).toContain("--- Child 9");
    expect(t3).toContain("--- Child 10");
    expect(t3).not.toContain("next page");
  });

  it("clamps out-of-range page numbers to the last page", async () => {
    const leaf = createRecord({
      pointer: "leaf:session-6:100:1",
      level: "leaf",
      payload: { summary: "leaf" },
      tokenCount: 1000,
    });

    const turns = Array.from({ length: 4 }, (_unused, idx) =>
      createRecord({
        pointer: `turn:session-6:${100 + idx}:1`,
        level: "turn",
        tokenCount: 800,
        payload: { role: "user", content: `msg ${idx + 1}` },
      }),
    );

    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: { [leaf.pointer]: leaf },
        childrenByParent: { [leaf.pointer]: turns },
      }),
    });

    // Page 999 should clamp to last page, not crash.
    const result = await tool.execute("call-overflow", { pointer: leaf.pointer, page: 999 });
    const text = getText(result);
    expect(text).toContain("Child");
    expect(result.details).toHaveProperty("page");
    expect((result.details as Record<string, unknown>).totalPages).toBeGreaterThan(0);
  });

  it("includes the boundary-crossing record then cuts", async () => {
    const leaf = createRecord({
      pointer: "leaf:session-7:100:1",
      level: "leaf",
      payload: { summary: "leaf" },
      tokenCount: 3000,
    });

    // 3 turns: 1300 + 1000 + 700 tokens. Budget is 2k.
    // Page 1: turn 1 (1300) + turn 2 (1000) = 2300 ≥ 2000 → cut after turn 2
    // Page 2: turn 3 (700)
    const turns = [
      createRecord({
        pointer: "turn:s7:1:1",
        level: "turn",
        tokenCount: 1300,
        payload: { role: "user", content: "big message" },
      }),
      createRecord({
        pointer: "turn:s7:2:1",
        level: "turn",
        tokenCount: 1000,
        payload: { role: "assistant", content: "reply" },
      }),
      createRecord({
        pointer: "turn:s7:3:1",
        level: "turn",
        tokenCount: 700,
        payload: { role: "user", content: "follow up" },
      }),
    ];

    const tool = createDoltExpandTool({
      sessionKey: "agent:main:subagent:worker",
      queries: createQueries({
        records: { [leaf.pointer]: leaf },
        childrenByParent: { [leaf.pointer]: turns },
      }),
    });

    // Page 1 should have 2 children (1300 + 1000 = 2300 tokens)
    const r1 = await tool.execute("call-boundary", { pointer: leaf.pointer });
    const t1 = getText(r1);
    expect(t1).toContain("Page 1 of 2");
    expect(t1).toContain("--- Child 1");
    expect(t1).toContain("--- Child 2");
    expect(t1).not.toContain("--- Child 3");

    // Page 2 should have 1 child (700 tokens)
    const r2 = await tool.execute("call-boundary-p2", { pointer: leaf.pointer, page: 2 });
    const t2 = getText(r2);
    expect(t2).toContain("Page 2 of 2");
    expect(t2).toContain("--- Child 3");
    expect(t2).not.toContain("next page");
  });
});
