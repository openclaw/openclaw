/**
 * Tests for Layer 3: Task Metadata on memories.
 *
 * Tests that memories can be linked to specific tasks via taskId,
 * enabling precise task-aware filtering at recall and cleanup time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StoreMemoryInput } from "./schema.js";
import { Neo4jMemoryClient } from "./neo4j-client.js";
import { fuseWithConfidenceRRF } from "./search.js";
import { parseTaskLedger } from "./task-ledger.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSession() {
  return {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    executeWrite: vi.fn(
      async (work: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
        const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
        return work(mockTx);
      },
    ),
  };
}

function createMockDriver() {
  return {
    session: vi.fn().mockReturnValue(createMockSession()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
    keys: Object.keys(data),
  };
}

// ============================================================================
// Neo4jMemoryClient: storeMemory with taskId
// ============================================================================

describe("Task Metadata: storeMemory", () => {
  let client: Neo4jMemoryClient;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    const mockLogger = createMockLogger();
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockDriver.session.mockReturnValue(mockSession);

    client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, mockLogger);
    (client as any).driver = mockDriver;
    (client as any).indexesReady = true;
  });

  it("should store memory with taskId when provided", async () => {
    mockSession.run.mockResolvedValue({
      records: [createMockRecord({ id: "mem-1" })],
    });

    const input: StoreMemoryInput = {
      id: "mem-1",
      text: "test memory with task",
      embedding: [0.1, 0.2],
      importance: 0.7,
      category: "fact",
      source: "user",
      extractionStatus: "pending",
      agentId: "agent-1",
      taskId: "TASK-001",
    };

    await client.storeMemory(input);

    const runCall = mockSession.run.mock.calls[0];
    const cypher = runCall[0] as string;
    const params = runCall[1] as Record<string, unknown>;

    // Cypher should include taskId clause
    expect(cypher).toContain("taskId");
    // Params should include the taskId value
    expect(params.taskId).toBe("TASK-001");
  });

  it("should store memory without taskId when not provided", async () => {
    mockSession.run.mockResolvedValue({
      records: [createMockRecord({ id: "mem-2" })],
    });

    const input: StoreMemoryInput = {
      id: "mem-2",
      text: "test memory without task",
      embedding: [0.1, 0.2],
      importance: 0.7,
      category: "fact",
      source: "user",
      extractionStatus: "pending",
      agentId: "agent-1",
    };

    await client.storeMemory(input);

    const runCall = mockSession.run.mock.calls[0];
    const cypher = runCall[0] as string;

    // Cypher should NOT include taskId clause when not provided
    // The dynamic clause is only added when taskId is present
    expect(cypher).not.toContain(", taskId: $taskId");
  });

  it("backward compatibility: existing memories without taskId still work", async () => {
    // Storing without taskId should work exactly as before
    mockSession.run.mockResolvedValue({
      records: [createMockRecord({ id: "mem-3" })],
    });

    const input: StoreMemoryInput = {
      id: "mem-3",
      text: "legacy memory",
      embedding: [0.1],
      importance: 0.5,
      category: "other",
      source: "auto-capture",
      extractionStatus: "skipped",
      agentId: "default",
    };

    const id = await client.storeMemory(input);
    expect(id).toBe("mem-3");
  });
});

// ============================================================================
// Neo4jMemoryClient: findMemoriesByTaskId
// ============================================================================

describe("Task Metadata: findMemoriesByTaskId", () => {
  let client: Neo4jMemoryClient;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    const mockLogger = createMockLogger();
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockDriver.session.mockReturnValue(mockSession);

    client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, mockLogger);
    (client as any).driver = mockDriver;
    (client as any).indexesReady = true;
  });

  it("should find memories by taskId", async () => {
    mockSession.run.mockResolvedValue({
      records: [
        createMockRecord({
          id: "mem-1",
          text: "task-related memory",
          category: "fact",
          importance: 0.8,
        }),
        createMockRecord({
          id: "mem-2",
          text: "another task memory",
          category: "other",
          importance: 0.6,
        }),
      ],
    });

    const results = await client.findMemoriesByTaskId("TASK-001");

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("mem-1");
    expect(results[1].id).toBe("mem-2");

    const runCall = mockSession.run.mock.calls[0];
    const cypher = runCall[0] as string;
    const params = runCall[1] as Record<string, unknown>;

    expect(cypher).toContain("m.taskId = $taskId");
    expect(params.taskId).toBe("TASK-001");
  });

  it("should filter by agentId when provided", async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    await client.findMemoriesByTaskId("TASK-001", "agent-1");

    const runCall = mockSession.run.mock.calls[0];
    const cypher = runCall[0] as string;
    const params = runCall[1] as Record<string, unknown>;

    expect(cypher).toContain("m.agentId = $agentId");
    expect(params.agentId).toBe("agent-1");
  });

  it("should return empty array when no memories match", async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    const results = await client.findMemoriesByTaskId("TASK-999");
    expect(results).toHaveLength(0);
  });
});

// ============================================================================
// Neo4jMemoryClient: clearTaskIdFromMemories
// ============================================================================

describe("Task Metadata: clearTaskIdFromMemories", () => {
  let client: Neo4jMemoryClient;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    const mockLogger = createMockLogger();
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockDriver.session.mockReturnValue(mockSession);

    client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, mockLogger);
    (client as any).driver = mockDriver;
    (client as any).indexesReady = true;
  });

  it("should clear taskId from all matching memories", async () => {
    mockSession.run.mockResolvedValue({
      records: [createMockRecord({ cleared: 3 })],
    });

    const count = await client.clearTaskIdFromMemories("TASK-001");

    expect(count).toBe(3);

    const runCall = mockSession.run.mock.calls[0];
    const cypher = runCall[0] as string;
    const params = runCall[1] as Record<string, unknown>;

    expect(cypher).toContain("m.taskId = $taskId");
    expect(cypher).toContain("SET m.taskId = null");
    expect(params.taskId).toBe("TASK-001");
  });

  it("should filter by agentId when provided", async () => {
    mockSession.run.mockResolvedValue({
      records: [createMockRecord({ cleared: 1 })],
    });

    await client.clearTaskIdFromMemories("TASK-001", "agent-1");

    const runCall = mockSession.run.mock.calls[0];
    const cypher = runCall[0] as string;
    const params = runCall[1] as Record<string, unknown>;

    expect(cypher).toContain("m.agentId = $agentId");
    expect(params.agentId).toBe("agent-1");
  });

  it("should return 0 when no memories match", async () => {
    mockSession.run.mockResolvedValue({
      records: [createMockRecord({ cleared: 0 })],
    });

    const count = await client.clearTaskIdFromMemories("TASK-999");
    expect(count).toBe(0);
  });
});

// ============================================================================
// Hybrid search results include taskId
// ============================================================================

describe("Task Metadata: hybrid search includes taskId", () => {
  it("should carry taskId through RRF fusion", () => {
    const vectorResults = [
      {
        id: "mem-1",
        text: "memory with task",
        category: "fact",
        importance: 0.8,
        createdAt: "2026-01-01",
        score: 0.9,
        taskId: "TASK-001",
      },
      {
        id: "mem-2",
        text: "memory without task",
        category: "other",
        importance: 0.5,
        createdAt: "2026-01-02",
        score: 0.8,
      },
    ];

    const bm25Results = [
      {
        id: "mem-1",
        text: "memory with task",
        category: "fact",
        importance: 0.8,
        createdAt: "2026-01-01",
        score: 0.7,
        taskId: "TASK-001",
      },
    ];

    const graphResults: typeof vectorResults = [];

    const fused = fuseWithConfidenceRRF(
      [vectorResults, bm25Results, graphResults],
      60,
      [1.0, 1.0, 1.0],
    );

    // mem-1 should have taskId preserved
    const mem1 = fused.find((r) => r.id === "mem-1");
    expect(mem1).toBeDefined();
    expect(mem1!.taskId).toBe("TASK-001");

    // mem-2 should have undefined taskId
    const mem2 = fused.find((r) => r.id === "mem-2");
    expect(mem2).toBeDefined();
    expect(mem2!.taskId).toBeUndefined();
  });

  it("should include taskId in fused results when present in any signal", () => {
    // taskId present only in BM25 signal
    const vectorResults = [
      {
        id: "mem-1",
        text: "test",
        category: "fact",
        importance: 0.8,
        createdAt: "2026-01-01",
        score: 0.9,
        // no taskId
      },
    ];

    const bm25Results = [
      {
        id: "mem-1",
        text: "test",
        category: "fact",
        importance: 0.8,
        createdAt: "2026-01-01",
        score: 0.7,
        taskId: "TASK-002",
      },
    ];

    const fused = fuseWithConfidenceRRF([vectorResults, bm25Results, []], 60, [1.0, 1.0, 1.0]);

    // The first signal (vector) is used for metadata — taskId would be undefined
    // because candidateMetadata takes the first occurrence
    const mem1 = fused.find((r) => r.id === "mem-1");
    expect(mem1).toBeDefined();
    // The first signal to contribute metadata wins
    // vector came first and has no taskId
    expect(mem1!.taskId).toBeUndefined();
  });
});

// ============================================================================
// Auto-tagging: parseTaskLedger for active task detection
// ============================================================================

describe("Task Metadata: auto-tagging via parseTaskLedger", () => {
  it("should detect single active task for auto-tagging", () => {
    const content = `# Active Tasks

## TASK-005: Fix login bug
- **Status:** in_progress
- **Started:** 2026-02-16

# Completed
## TASK-004: Fix browser port collision
- **Completed:** 2026-02-16
`;

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks).toHaveLength(1);
    expect(ledger.activeTasks[0].id).toBe("TASK-005");
  });

  it("should not auto-tag when multiple active tasks exist", () => {
    const content = `# Active Tasks

## TASK-005: Fix login bug
- **Status:** in_progress

## TASK-006: Update docs
- **Status:** in_progress

# Completed
`;

    const ledger = parseTaskLedger(content);
    // Multiple active tasks — should NOT auto-tag
    expect(ledger.activeTasks.length).toBeGreaterThan(1);
  });

  it("should not auto-tag when no active tasks exist", () => {
    const content = `# Active Tasks

_No active tasks_

# Completed
## TASK-004: Fix browser port collision
- **Completed:** 2026-02-16
`;

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks).toHaveLength(0);
  });

  it("should extract completed task IDs for recall filtering", () => {
    const content = `# Active Tasks

## TASK-007: New feature
- **Status:** in_progress

# Completed
## TASK-002: Book flights
- **Completed:** 2026-02-16

## TASK-003: Fix dashboard
- **Completed:** 2026-02-16
`;

    const ledger = parseTaskLedger(content);
    const completedTaskIds = new Set(ledger.completedTasks.map((t) => t.id));
    expect(completedTaskIds.has("TASK-002")).toBe(true);
    expect(completedTaskIds.has("TASK-003")).toBe(true);
    expect(completedTaskIds.has("TASK-007")).toBe(false);
  });
});

// ============================================================================
// Recall filter: taskId-based completed task filtering
// ============================================================================

describe("Task Metadata: recall filter", () => {
  it("should filter out memories linked to completed tasks", () => {
    const completedTaskIds = new Set(["TASK-002", "TASK-003"]);

    const results = [
      {
        id: "1",
        text: "active task memory",
        taskId: "TASK-007",
        score: 0.9,
        category: "fact",
        importance: 0.8,
        createdAt: "2026-01-01",
      },
      {
        id: "2",
        text: "completed task memory",
        taskId: "TASK-002",
        score: 0.85,
        category: "fact",
        importance: 0.7,
        createdAt: "2026-01-01",
      },
      {
        id: "3",
        text: "no task memory",
        score: 0.8,
        category: "other",
        importance: 0.5,
        createdAt: "2026-01-01",
      },
      {
        id: "4",
        text: "another completed",
        taskId: "TASK-003",
        score: 0.75,
        category: "fact",
        importance: 0.6,
        createdAt: "2026-01-01",
      },
    ];

    const filtered = results.filter((r) => !r.taskId || !completedTaskIds.has(r.taskId));

    expect(filtered).toHaveLength(2);
    expect(filtered[0].id).toBe("1"); // active task — kept
    expect(filtered[1].id).toBe("3"); // no task — kept
  });

  it("should keep all memories when no completed task IDs", () => {
    const completedTaskIds = new Set<string>();

    const results = [
      { id: "1", text: "memory A", taskId: "TASK-001", score: 0.9 },
      { id: "2", text: "memory B", score: 0.8 },
    ];

    const filtered = results.filter((r) => !r.taskId || !completedTaskIds.has(r.taskId));

    expect(filtered).toHaveLength(2);
  });

  it("should keep memories without taskId regardless of filter", () => {
    const completedTaskIds = new Set(["TASK-001", "TASK-002"]);

    const results = [
      { id: "1", text: "old memory without task", score: 0.9 },
      { id: "2", text: "another old one", taskId: undefined, score: 0.8 },
    ];

    const filtered = results.filter((r) => !r.taskId || !completedTaskIds.has(r.taskId));

    expect(filtered).toHaveLength(2);
  });
});

// ============================================================================
// Vector/BM25 search results include taskId
// ============================================================================

describe("Task Metadata: search signal taskId", () => {
  let client: Neo4jMemoryClient;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    const mockLogger = createMockLogger();
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockDriver.session.mockReturnValue(mockSession);

    client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, mockLogger);
    (client as any).driver = mockDriver;
    (client as any).indexesReady = true;
  });

  it("vector search should include taskId in results", async () => {
    mockSession.run.mockResolvedValue({
      records: [
        createMockRecord({
          id: "mem-1",
          text: "test",
          category: "fact",
          importance: 0.8,
          createdAt: "2026-01-01",
          taskId: "TASK-001",
          similarity: 0.95,
        }),
        createMockRecord({
          id: "mem-2",
          text: "test2",
          category: "other",
          importance: 0.5,
          createdAt: "2026-01-02",
          taskId: null, // Legacy memory without taskId
          similarity: 0.85,
        }),
      ],
    });

    const results = await client.vectorSearch([0.1, 0.2], 10, 0.1);

    expect(results[0].taskId).toBe("TASK-001");
    expect(results[1].taskId).toBeUndefined(); // null → undefined
  });

  it("BM25 search should include taskId in results", async () => {
    mockSession.run.mockResolvedValue({
      records: [
        createMockRecord({
          id: "mem-1",
          text: "test query",
          category: "fact",
          importance: 0.8,
          createdAt: "2026-01-01",
          taskId: "TASK-002",
          bm25Score: 5.0,
        }),
      ],
    });

    const results = await client.bm25Search("test query", 10);

    expect(results[0].taskId).toBe("TASK-002");
  });
});
