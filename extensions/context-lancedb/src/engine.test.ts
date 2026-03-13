import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { EmbeddingProvider, EmbeddingProviderResult } from "../../../src/memory/embeddings.js";
import { createLanceDbContextEngine } from "./engine.js";

const compactEmbeddedPiSessionDirect = vi.fn(async () => ({
  ok: true,
  compacted: true,
  reason: "legacy",
  result: {
    summary: "legacy summary",
    firstKeptEntryId: "entry-1",
    tokensBefore: 120,
    tokensAfter: 60,
    details: { source: "mock" },
  },
}));

vi.mock("../../../src/agents/pi-embedded-runner/compact.runtime.js", () => ({
  compactEmbeddedPiSessionDirect,
}));

class FakeField {
  constructor(
    readonly name: string,
    readonly type: unknown,
    readonly nullable: boolean,
  ) {}
}

class FakeSchema {
  constructor(readonly fields: unknown[]) {}
}

class FakeUtf8 {}
class FakeInt32 {}
class FakeFloat32 {}
class FakeFloat64 {}

type FakeRow = Record<string, unknown>;

function dotProduct(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return -1;
  }
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index]! * right[index]!;
  }
  return total;
}

function decodeSqlString(value: string): string {
  return value.replace(/''/g, "'");
}

function matchesClause(row: FakeRow, clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) {
    return true;
  }

  let match = trimmed.match(/^([a-z_]+)\s+IS\s+NOT\s+NULL$/i);
  if (match) {
    return row[match[1]!] != null;
  }

  match = trimmed.match(/^([a-z_]+)\s*!=\s*'(.*)'$/i);
  if (match) {
    return String(row[match[1]!] ?? "") !== decodeSqlString(match[2]!);
  }

  match = trimmed.match(/^([a-z_]+)\s*=\s*'(.*)'$/i);
  if (match) {
    return String(row[match[1]!] ?? "") === decodeSqlString(match[2]!);
  }

  match = trimmed.match(/^([a-z_]+)\s*>\s*(-?\d+(?:\.\d+)?)$/i);
  if (match) {
    return Number(row[match[1]!] ?? 0) > Number(match[2]!);
  }

  throw new Error(`Unsupported fake LanceDB filter clause: ${trimmed}`);
}

function matchesFilter(row: FakeRow, filter?: string): boolean {
  if (!filter) {
    return true;
  }
  return filter.split(/\s+AND\s+/).every((clause) => matchesClause(row, clause));
}

class FakeQuery {
  protected whereClause = "";
  protected rowLimit = Number.POSITIVE_INFINITY;

  constructor(protected readonly rows: FakeRow[]) {}

  where(clause: string): this {
    this.whereClause = clause;
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  async toArray(): Promise<FakeRow[]> {
    return this.rows
      .filter((row) => matchesFilter(row, this.whereClause))
      .slice(0, this.rowLimit)
      .map((row) => ({ ...row }));
  }
}

class FakeVectorQuery extends FakeQuery {
  constructor(
    rows: FakeRow[],
    private readonly queryVector: number[],
  ) {
    super(rows);
  }

  override async toArray(): Promise<FakeRow[]> {
    return this.rows
      .filter((row) => matchesFilter(row, this.whereClause))
      .map((row) => ({
        row,
        score: Array.isArray(row.embedding)
          ? dotProduct(this.queryVector, row.embedding as number[])
          : -1,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, this.rowLimit)
      .map((item) => ({ ...item.row }));
  }
}

class FakeTable {
  readonly rows: FakeRow[] = [];

  constructor(readonly name: string) {}

  mergeInsert(key: string) {
    const builder = {
      whenMatchedUpdateAll: () => builder,
      whenNotMatchedInsertAll: () => builder,
      execute: async (rows: FakeRow[]) => {
        for (const row of rows) {
          const value = row[key];
          const index = this.rows.findIndex((candidate) => candidate[key] === value);
          if (index >= 0) {
            this.rows[index] = { ...this.rows[index]!, ...row };
          } else {
            this.rows.push({ ...row });
          }
        }
      },
    };
    return builder;
  }

  query(): FakeQuery {
    return new FakeQuery(this.rows);
  }

  vectorSearch(vector: number[]): FakeVectorQuery {
    return new FakeVectorQuery(this.rows, vector);
  }

  async delete(predicate: string): Promise<void> {
    const kept = this.rows.filter((row) => !matchesFilter(row, predicate));
    this.rows.splice(0, this.rows.length, ...kept);
  }

  async createIndex(_column: string): Promise<void> {}

  async optimize(): Promise<void> {}
}

class FakeConnection {
  private readonly tables = new Map<string, FakeTable>();

  async tableNames(): Promise<string[]> {
    return [...this.tables.keys()];
  }

  async openTable(name: string): Promise<FakeTable> {
    const table = this.tables.get(name);
    if (!table) {
      throw new Error(`Missing fake table: ${name}`);
    }
    return table;
  }

  async createEmptyTable(name: string, _schema: unknown): Promise<FakeTable> {
    const table = new FakeTable(name);
    this.tables.set(name, table);
    return table;
  }

  async createTable(name: string, data: FakeRow[]): Promise<FakeTable> {
    const table = new FakeTable(name);
    table.rows.push(...data.map((row) => ({ ...row })));
    this.tables.set(name, table);
    return table;
  }
}

function createFakeLanceDbModule() {
  const connections = new Map<string, FakeConnection>();
  return {
    Field: FakeField,
    Float32: FakeFloat32,
    Float64: FakeFloat64,
    Int32: FakeInt32,
    Schema: FakeSchema,
    Utf8: FakeUtf8,
    newVectorType: (dimensions: number, inner: unknown) => ({ dimensions, inner }),
    connect: async (uri: string) => {
      let connection = connections.get(uri);
      if (!connection) {
        connection = new FakeConnection();
        connections.set(uri, connection);
      }
      return connection;
    },
  };
}

function createEmbeddingProvider(): EmbeddingProvider {
  const vocabulary = [
    "auth",
    "token",
    "lancedb",
    "summary",
    "context",
    "history",
    "session",
    "reset",
  ];

  const embed = (text: string): number[] => {
    const lower = text.toLowerCase();
    const vector = vocabulary.map((token) => {
      const matches = lower.match(new RegExp(token, "g"));
      return matches?.length ?? 0;
    });
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
  };

  return {
    id: "test",
    model: "test-model",
    embedQuery: async (text) => embed(text),
    embedBatch: async (texts) => texts.map((text) => embed(text)),
  };
}

function createEmbeddingProviderResult(): Promise<EmbeddingProviderResult> {
  return Promise.resolve({
    provider: createEmbeddingProvider(),
    requestedProvider: "openai",
  });
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMessage(params: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool";
  content: string;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: params.role,
      content: params.content,
      timestamp: Date.now(),
    },
  };
}

function createCompaction(params: {
  id: string;
  parentId: string | null;
  summary: string;
  firstKeptEntryId: string;
}) {
  return {
    type: "compaction",
    id: params.id,
    parentId: params.parentId,
    timestamp: new Date().toISOString(),
    summary: params.summary,
    firstKeptEntryId: params.firstKeptEntryId,
    tokensBefore: 100,
  };
}

async function writeTranscript(file: string, entries: unknown[]): Promise<void> {
  const header = {
    type: "session",
    version: 3,
    id: path.basename(file, ".jsonl"),
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(file, `${content}\n`, "utf-8");
}

async function writeSessionStore(
  dir: string,
  entries: Record<string, { sessionId: string; updatedAt: number }>,
): Promise<void> {
  await fs.writeFile(path.join(dir, "sessions.json"), JSON.stringify(entries, null, 2), "utf-8");
}

function createEngine(params: {
  dbPath: string;
  logger?: ReturnType<typeof createLogger>;
  loadLanceDb?: () => Promise<typeof import("@lancedb/lancedb")>;
  embeddingProviderFactory?: (params: {
    config: OpenClawConfig;
    resolved: {
      embedding: { dimensions: number };
    };
    agentDir?: string;
  }) => Promise<EmbeddingProviderResult>;
}) {
  return createLanceDbContextEngine({
    config: {} as OpenClawConfig,
    pluginConfig: {
      dbPath: params.dbPath,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 8,
      },
      assembly: {
        recentTailTokens: 2_000,
        retrievalTopK: 4,
        retrievalMinScore: 0.15,
        maxRetrievedChars: 4_000,
        crossSessionScope: "session_key",
        crossSessionRecallMode: "summary-first",
      },
      maintenance: {
        optimizeIntervalMinutes: 30,
      },
      limits: {
        maxMessageCharsForEmbedding: 1_000,
        skipLargeToolResultChars: 2_000,
      },
    },
    logger: params.logger ?? createLogger(),
    resolvePath: (input) => input,
    deps: {
      loadLanceDb: params.loadLanceDb ?? (async () => createFakeLanceDbModule() as never),
      embeddingProviderFactory: params.embeddingProviderFactory ?? createEmbeddingProviderResult,
    },
  });
}

function runtimeMessages(query: string): AgentMessage[] {
  return [
    {
      role: "user",
      content: query,
      timestamp: Date.now(),
    } as AgentMessage,
  ];
}

const tempRoots: string[] = [];

afterEach(async () => {
  compactEmbeddedPiSessionDirect.mockClear();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

describe("context-lancedb engine", () => {
  it("bootstrap indexes transcript and resolves session_key from sessions.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lancedb-context-"));
    tempRoots.push(root);

    const sessionFile = path.join(root, "current-1.jsonl");
    await writeTranscript(sessionFile, [
      createMessage({ id: "m1", parentId: null, role: "user", content: "We store auth tokens." }),
      createMessage({
        id: "m2",
        parentId: "m1",
        role: "assistant",
        content: "We keep a compact session summary in LanceDB.",
      }),
      createCompaction({
        id: "c1",
        parentId: "m2",
        summary: "Current session summary keeps LanceDB auth token context.",
        firstKeptEntryId: "m2",
      }),
    ]);
    await writeSessionStore(root, {
      "family-key": {
        sessionId: "current-1",
        updatedAt: Date.now(),
      },
    });

    const engine = createEngine({
      dbPath: path.join(root, "db"),
    });

    expect(engine.bootstrap).toBeDefined();
    const bootstrap = await engine.bootstrap!({
      sessionId: "current-1",
      sessionFile,
    });
    expect(bootstrap.bootstrapped).toBe(true);
    expect(bootstrap.importedMessages).toBe(2);

    const assembled = await engine.assemble({
      sessionId: "current-1",
      messages: runtimeMessages("Why do we keep auth token context in LanceDB summaries?"),
      tokenBudget: 4_000,
    });

    expect(assembled.systemPromptAddition).toContain("Current session summary");
    expect(assembled.systemPromptAddition).toContain(
      "Current session summary keeps LanceDB auth token context.",
    );
  });

  it("assembles current summary plus same-session_key historical summaries and messages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lancedb-context-"));
    tempRoots.push(root);

    const oldSummaryFile = path.join(root, "old-summary.jsonl");
    const oldMessagesFile = path.join(root, "old-messages.jsonl");
    const currentFile = path.join(root, "current.jsonl");
    const otherFamilyFile = path.join(root, "other-family.jsonl");

    await writeTranscript(oldSummaryFile, [
      createMessage({
        id: "os1",
        parentId: null,
        role: "user",
        content: "We need durable auth token context.",
      }),
      createMessage({
        id: "os2",
        parentId: "os1",
        role: "assistant",
        content: "Use LanceDB summaries so reset sessions can recall auth token context.",
      }),
      createMessage({
        id: "os3",
        parentId: "os2",
        role: "user",
        content: "Make sure reset still recalls the auth context.",
      }),
      createCompaction({
        id: "osc1",
        parentId: "os3",
        summary: "Historical decision: LanceDB summaries preserve auth token context across reset.",
        firstKeptEntryId: "os3",
      }),
    ]);

    await writeTranscript(oldMessagesFile, [
      createMessage({
        id: "om1",
        parentId: null,
        role: "user",
        content:
          "When there is no summary yet, keep the raw auth token context message searchable.",
      }),
      createMessage({
        id: "om2",
        parentId: "om1",
        role: "assistant",
        content: "LanceDB message recall supplements historical sessions without summaries.",
      }),
    ]);

    await writeTranscript(currentFile, [
      createMessage({
        id: "cu1",
        parentId: null,
        role: "user",
        content: "We are refining the current session context engine.",
      }),
      createMessage({
        id: "cu2",
        parentId: "cu1",
        role: "assistant",
        content: "Current session summary tracks the context-engine changes.",
      }),
      createCompaction({
        id: "cuc1",
        parentId: "cu2",
        summary: "Current session summary: implementing LanceDB context-engine projection.",
        firstKeptEntryId: "cu2",
      }),
    ]);

    await writeTranscript(otherFamilyFile, [
      createMessage({
        id: "of1",
        parentId: null,
        role: "user",
        content: "Other family also mentions auth token context and LanceDB.",
      }),
      createCompaction({
        id: "ofc1",
        parentId: "of1",
        summary: "This summary belongs to another session family and must not be recalled.",
        firstKeptEntryId: "of1",
      }),
    ]);

    const engine = createEngine({
      dbPath: path.join(root, "db"),
    });

    expect(engine.afterTurn).toBeDefined();
    await engine.afterTurn!({
      sessionId: "old-summary",
      sessionFile: oldSummaryFile,
      messages: [],
      prePromptMessageCount: 0,
      runtimeContext: { sessionKey: "family-key", agentDir: root },
    });
    await engine.afterTurn!({
      sessionId: "old-messages",
      sessionFile: oldMessagesFile,
      messages: [],
      prePromptMessageCount: 0,
      runtimeContext: { sessionKey: "family-key", agentDir: root },
    });
    await engine.afterTurn!({
      sessionId: "current",
      sessionFile: currentFile,
      messages: [],
      prePromptMessageCount: 0,
      runtimeContext: { sessionKey: "family-key", agentDir: root },
    });
    await engine.afterTurn!({
      sessionId: "other-family",
      sessionFile: otherFamilyFile,
      messages: [],
      prePromptMessageCount: 0,
      runtimeContext: { sessionKey: "other-key", agentDir: root },
    });

    const assembled = await engine.assemble({
      sessionId: "current",
      messages: runtimeMessages(
        "Why do we use LanceDB to preserve auth token context after reset?",
      ),
      tokenBudget: 4_000,
    });

    expect(assembled.systemPromptAddition).toContain(
      "Current session summary: implementing LanceDB context-engine projection.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "Historical decision: LanceDB summaries preserve auth token context across reset.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "LanceDB message recall supplements historical sessions without summaries.",
    );
    expect(assembled.systemPromptAddition).not.toContain(
      "This summary belongs to another session family and must not be recalled.",
    );

    const summaryIndex = assembled.systemPromptAddition?.indexOf(
      "Relevant history from earlier sessions in this conversation family",
    );
    const messageIndex = assembled.systemPromptAddition?.indexOf("Relevant prior messages");
    expect(summaryIndex).toBeTypeOf("number");
    expect(messageIndex).toBeTypeOf("number");
    expect(summaryIndex!).toBeLessThan(messageIndex!);
  });

  it("delegates compact() to the legacy compaction runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lancedb-context-"));
    tempRoots.push(root);

    const engine = createEngine({
      dbPath: path.join(root, "db"),
    });

    const result = await engine.compact({
      sessionId: "current",
      sessionFile: path.join(root, "session.jsonl"),
      tokenBudget: 2_000,
      force: true,
      runtimeContext: {
        sessionKey: "family-key",
        workspaceDir: root,
      },
    });

    expect(compactEmbeddedPiSessionDirect).toHaveBeenCalledTimes(1);
    expect(compactEmbeddedPiSessionDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "current",
        sessionFile: path.join(root, "session.jsonl"),
        tokenBudget: 2_000,
        force: true,
        sessionKey: "family-key",
        workspaceDir: root,
      }),
    );
    expect(result).toEqual({
      ok: true,
      compacted: true,
      reason: "legacy",
      result: {
        summary: "legacy summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 60,
        details: { source: "mock" },
      },
    });
  });

  it("caches embedding providers per agentDir and reuses the session agent for assemble", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lancedb-context-"));
    tempRoots.push(root);

    const alphaSessionsDir = path.join(root, "agents", "alpha", "sessions");
    const betaSessionsDir = path.join(root, "agents", "beta", "sessions");
    await fs.mkdir(alphaSessionsDir, { recursive: true });
    await fs.mkdir(betaSessionsDir, { recursive: true });

    const alphaAgentDir = path.join(root, "agents", "alpha", "agent");
    const betaAgentDir = path.join(root, "agents", "beta", "agent");

    const alphaFile = path.join(alphaSessionsDir, "alpha.jsonl");
    const betaOldFile = path.join(betaSessionsDir, "beta-old.jsonl");
    const betaCurrentFile = path.join(betaSessionsDir, "beta-current.jsonl");

    await writeTranscript(alphaFile, [
      createMessage({
        id: "a1",
        parentId: null,
        role: "user",
        content: "Alpha session uses a different embedding provider.",
      }),
    ]);

    await writeTranscript(betaOldFile, [
      createMessage({
        id: "b1",
        parentId: null,
        role: "user",
        content: "Beta history must be recalled for auth token context.",
      }),
      createCompaction({
        id: "bc1",
        parentId: "b1",
        summary: "Beta historical summary should only recall with the beta embedding provider.",
        firstKeptEntryId: "b1",
      }),
    ]);

    await writeTranscript(betaCurrentFile, [
      createMessage({
        id: "b2",
        parentId: null,
        role: "user",
        content: "Current beta session is asking about auth token context.",
      }),
      createCompaction({
        id: "bc2",
        parentId: "b2",
        summary: "Current beta summary.",
        firstKeptEntryId: "b2",
      }),
    ]);

    const embeddingProviderFactory = vi.fn(
      async (params: {
        config: OpenClawConfig;
        resolved: { embedding: { dimensions: number } };
        agentDir?: string;
      }): Promise<EmbeddingProviderResult> => {
        const vector = Array.from({ length: params.resolved.embedding.dimensions }, (_, index) => {
          if (params.agentDir === alphaAgentDir) {
            return index === 0 ? 1 : 0;
          }
          if (params.agentDir === betaAgentDir) {
            return index === 1 ? 1 : 0;
          }
          return index === 2 ? 1 : 0;
        });

        return {
          provider: {
            id: params.agentDir ?? "default",
            model: "test-model",
            embedQuery: async () => vector,
            embedBatch: async (texts) => texts.map(() => vector),
          },
          requestedProvider: "openai",
        };
      },
    );

    const engine = createEngine({
      dbPath: path.join(root, "db"),
      embeddingProviderFactory,
    });

    await engine.afterTurn!({
      sessionId: "alpha",
      sessionFile: alphaFile,
      messages: [],
      prePromptMessageCount: 0,
      runtimeContext: { sessionKey: "alpha-key", agentDir: alphaAgentDir },
    });
    await engine.afterTurn!({
      sessionId: "beta-old",
      sessionFile: betaOldFile,
      messages: [],
      prePromptMessageCount: 0,
      runtimeContext: { sessionKey: "beta-key", agentDir: betaAgentDir },
    });
    await engine.afterTurn!({
      sessionId: "beta-current",
      sessionFile: betaCurrentFile,
      messages: [],
      prePromptMessageCount: 0,
      runtimeContext: { sessionKey: "beta-key", agentDir: betaAgentDir },
    });

    const assembled = await engine.assemble({
      sessionId: "beta-current",
      messages: runtimeMessages("Which historical auth token context should beta sessions recall?"),
      tokenBudget: 4_000,
    });

    expect(assembled.systemPromptAddition).toContain(
      "Beta historical summary should only recall with the beta embedding provider.",
    );
    expect(embeddingProviderFactory).toHaveBeenCalledTimes(2);
    expect(embeddingProviderFactory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentDir: alphaAgentDir }),
    );
    expect(embeddingProviderFactory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ agentDir: betaAgentDir }),
    );
  });
});
