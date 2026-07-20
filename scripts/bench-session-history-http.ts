// Benchmarks production HTTP/SSE/WebSocket visible-history reads against a 100k-message session.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVENT_COUNT = 100_000;
const PAGE_SIZE = 50;
const RAW_WINDOW = PAGE_SIZE * 20 + 20;
const RUNS = 12;
const WARMUPS = 3;
const CHECKOUT = path.resolve(process.env.OPENCLAW_BENCH_CHECKOUT ?? process.cwd());

type OperationSample = {
  eventParses: number;
  heapDeltaBytes: number;
  latencyMs: number;
  rssDeltaBytes: number;
};

type BenchmarkModules = {
  closeAgentDatabases: () => void;
  closeStateDatabase: () => void;
  emitTranscriptUpdate: (update: Record<string, unknown>) => void;
  handleRequest: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    options: { auth: { mode: "none" } },
  ) => Promise<boolean>;
  openAgentDatabase: (options: { agentId: string; env: NodeJS.ProcessEnv }) => {
    db: import("node:sqlite").DatabaseSync;
  };
  encodeVisibleCursor: (params: {
    anchorEventSeq: number;
    generation: string;
    scope: VisibleReadScope;
  }) => string;
  readVisibleCursorPage: (
    scope: VisibleReadScope,
    options: { cursor?: string; maxMessages: number },
  ) => Promise<
    | {
        anchors: Array<{ eventSeq: number }>;
        generation: string;
        kind: "page";
        messages: unknown[];
      }
    | { kind: "missing" | "unsupported" }
    | { kind: "reset"; reason: string }
  >;
};

type VisibleReadScope = {
  agentId: string;
  sessionEntry: { sessionFile: string; sessionId: string };
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

function targetModule(relativePath: string): string {
  return pathToFileURL(path.join(CHECKOUT, relativePath)).href;
}

async function loadBenchmarkModules(): Promise<BenchmarkModules> {
  const [history, visibleHistory, updates, agentDb, stateDb] = await Promise.all([
    import(targetModule("src/gateway/sessions-history-http.ts")),
    import(targetModule("src/gateway/session-history-visible-reader.ts")),
    import(targetModule("src/sessions/transcript-events.ts")),
    import(targetModule("src/state/openclaw-agent-db.ts")),
    import(targetModule("src/state/openclaw-state-db.ts")),
  ]);
  return {
    closeAgentDatabases: agentDb.closeOpenClawAgentDatabasesForTest,
    closeStateDatabase: stateDb.closeOpenClawStateDatabaseForTest,
    emitTranscriptUpdate: updates.emitSessionTranscriptUpdate,
    encodeVisibleCursor: visibleHistory.encodeVisibleSessionMessagesCursor,
    handleRequest: history.handleSessionHistoryHttpRequest,
    openAgentDatabase: agentDb.openOpenClawAgentDatabase,
    readVisibleCursorPage: visibleHistory.readVisibleSessionMessagesCursorPageAsync,
  };
}

function seedTranscript(
  db: import("node:sqlite").DatabaseSync,
  params: { sessionId: string; sessionKey: string; storePath: string },
): void {
  const now = Date.now();
  const insertEvent = db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertIdentity = db.prepare(
    `INSERT INTO transcript_event_identities
       (session_id, event_id, seq, event_type, parent_id, created_at)
     VALUES (?, ?, ?, 'message', ?, ?)`,
  );
  const insertActive = db.prepare(
    `INSERT INTO session_transcript_active_events
       (session_id, active_position, event_seq, message_position)
     VALUES (?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    // Seed the canonical route and session entry used by the production HTTP
    // handler. The marker keeps both checkouts on their normal SQLite reader.
    db.prepare(
      `INSERT INTO sessions
         (session_id, session_key, session_scope, created_at, updated_at)
       VALUES (?, ?, 'conversation', ?, ?)`,
    ).run(params.sessionId, params.sessionKey, now, now);
    db.prepare(
      "INSERT INTO session_routes (session_key, session_id, updated_at) VALUES (?, ?, ?)",
    ).run(params.sessionKey, params.sessionId, now);
    db.prepare(
      `INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      params.sessionKey,
      params.sessionId,
      JSON.stringify({
        sessionFile: `sqlite:main:${params.sessionId}:${params.storePath}`,
        sessionId: params.sessionId,
        updatedAt: now,
      }),
      now,
    );
    // Current main may predate the stacked generation table, while the
    // candidate requires it. Both fixtures otherwise remain byte-identical.
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_transcript_generations'",
        )
        .get()
    ) {
      db.prepare(
        `INSERT INTO session_transcript_generations (session_id, generation, updated_at)
         VALUES (?, 'benchmark-generation', ?)`,
      ).run(params.sessionId, now);
    }
    // Every raw event is a visible active-path message so deserialization
    // counts directly describe transcript work instead of a synthetic proxy.
    for (let seq = 0; seq < EVENT_COUNT; seq += 1) {
      const eventId = `benchmark-${String(seq)}`;
      const parentId = seq === 0 ? null : `benchmark-${String(seq - 1)}`;
      insertEvent.run(
        params.sessionId,
        seq,
        JSON.stringify({
          id: eventId,
          message: {
            content: [
              { type: "text", text: `message-${String(seq).padStart(6, "0")}-${"x".repeat(49)}` },
            ],
            role: "assistant",
          },
          parentId,
          type: "message",
        }),
        now + seq,
      );
      insertIdentity.run(params.sessionId, eventId, seq, parentId, now + seq);
      insertActive.run(params.sessionId, seq, seq, seq);
    }
    // Mark the materialized projection current at the 100k-event frontier.
    db.prepare(
      `INSERT INTO session_transcript_index_state
         (session_id, indexed_seq, leaf_event_id, needs_rebuild,
          active_event_count, active_message_count, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      params.sessionId,
      EVENT_COUNT - 1,
      `benchmark-${String(EVENT_COUNT - 1)}`,
      EVENT_COUNT,
      EVENT_COUNT,
      now + EVENT_COUNT,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return Number((sorted[index] ?? 0).toFixed(3));
}

function summarize(samples: readonly OperationSample[]) {
  return {
    eventParses: {
      max: Math.max(...samples.map((sample) => sample.eventParses)),
      median: percentile(
        samples.map((sample) => sample.eventParses),
        0.5,
      ),
      min: Math.min(...samples.map((sample) => sample.eventParses)),
    },
    heapDeltaBytesMedian: percentile(
      samples.map((sample) => sample.heapDeltaBytes),
      0.5,
    ),
    latencyMs: {
      median: percentile(
        samples.map((sample) => sample.latencyMs),
        0.5,
      ),
      p95: percentile(
        samples.map((sample) => sample.latencyMs),
        0.95,
      ),
    },
    rssDeltaBytesMedian: percentile(
      samples.map((sample) => sample.rssDeltaBytes),
      0.5,
    ),
    samples,
  };
}

function installEventParseCounter(): { read: () => number; reset: () => void } {
  const originalParse = JSON.parse.bind(JSON);
  let count = 0;
  JSON.parse = ((
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ) => {
    if (text.includes('"type":"message"') && text.includes('"id":"benchmark-')) {
      count += 1;
    }
    return originalParse(text, reviver);
  }) as JSON["parse"];
  return {
    read: () => count,
    reset: () => {
      count = 0;
    },
  };
}

async function measure(
  counter: ReturnType<typeof installEventParseCounter>,
  operation: () => Promise<void>,
): Promise<OperationSample> {
  globalThis.gc?.();
  const before = process.memoryUsage();
  counter.reset();
  const startedAt = performance.now();
  await operation();
  const latencyMs = performance.now() - startedAt;
  const after = process.memoryUsage();
  return {
    eventParses: counter.read(),
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    latencyMs: Number(latencyMs.toFixed(3)),
    rssDeltaBytes: after.rss - before.rss,
  };
}

async function runMeasured(
  counter: ReturnType<typeof installEventParseCounter>,
  operation: () => Promise<void>,
): Promise<OperationSample[]> {
  for (let index = 0; index < WARMUPS; index += 1) {
    await measure(counter, operation);
  }
  const samples: OperationSample[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    samples.push(await measure(counter, operation));
  }
  return samples;
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) {
        return JSON.parse(data);
      }
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before a history event");
    }
    buffer += decoder.decode(chunk.value, { stream: true });
  }
}

async function startHistoryServer(
  handleRequest: BenchmarkModules["handleRequest"],
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, { auth: { mode: "none" } }).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("benchmark server did not expose a TCP port");
  }
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, server };
}

async function fetchHistory(baseUrl: string, sessionKey: string, query: string) {
  const response = await fetch(
    `${baseUrl}/sessions/${encodeURIComponent(sessionKey)}/history${query}`,
    { headers: { "x-openclaw-scopes": "operator.read" } },
  );
  if (!response.ok) {
    throw new Error(`history request failed: ${String(response.status)} ${await response.text()}`);
  }
  return (await response.json()) as { messages?: unknown[]; nextCursor?: string };
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-visible-history-bench-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), '{"gateway":{"auth":{"mode":"none"}}}');
  const sessionId = "visible-history-benchmark";
  const sessionKey = "agent:main:visible-history-benchmark";
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const modules = await loadBenchmarkModules();
  const database = modules.openAgentDatabase({ agentId: "main", env: process.env });
  let server: Server | undefined;
  try {
    // The first bounded tail response supplies each checkout's native cursor;
    // all measured JSON reads request the same 50-message older page.
    seedTranscript(database.db, { sessionId, sessionKey, storePath });
    const started = await startHistoryServer(modules.handleRequest);
    server = started.server;
    const tail = await fetchHistory(started.baseUrl, sessionKey, `?limit=${String(PAGE_SIZE)}`);
    if (!tail.nextCursor || tail.messages?.length !== PAGE_SIZE) {
      throw new Error("tail bootstrap did not return a full cursor page");
    }
    const cursorQuery = `?limit=${String(PAGE_SIZE)}&cursor=${encodeURIComponent(tail.nextCursor)}`;
    const counter = installEventParseCounter();
    const httpSamples = await runMeasured(counter, async () => {
      const page = await fetchHistory(started.baseUrl, sessionKey, cursorQuery);
      if (page.messages?.length !== PAGE_SIZE) {
        throw new Error("HTTP cursor page did not return 50 messages");
      }
    });
    const visibleScope: VisibleReadScope = {
      agentId: "main",
      sessionEntry: {
        sessionFile: `sqlite:main:${sessionId}:${storePath}`,
        sessionId,
      },
      sessionId,
      sessionKey,
      storePath,
    };
    const visibleTail = await modules.readVisibleCursorPage(visibleScope, {
      maxMessages: RAW_WINDOW + 1,
    });
    if (visibleTail.kind !== "page" || visibleTail.anchors.length === 0) {
      throw new Error("WebSocket visible tail bootstrap did not return a cursor anchor");
    }
    const webSocketCursor = modules.encodeVisibleCursor({
      anchorEventSeq: visibleTail.anchors[0]?.eventSeq ?? 0,
      generation: visibleTail.generation,
      scope: visibleScope,
    });
    // This is the production bounded SQLite reader invoked by chat.history;
    // protocol framing and display projection are covered by the Gateway tests.
    const webSocketSamples = await runMeasured(counter, async () => {
      const page = await modules.readVisibleCursorPage(visibleScope, {
        cursor: webSocketCursor,
        maxMessages: RAW_WINDOW + 1,
      });
      if (page.kind !== "page" || page.messages.length !== RAW_WINDOW + 1) {
        throw new Error("WebSocket visible cursor reader did not return a full raw window");
      }
    });
    const measureSseRefresh = async (): Promise<OperationSample> => {
      globalThis.gc?.();
      const response = await fetch(
        `${started.baseUrl}/sessions/${encodeURIComponent(sessionKey)}/history${cursorQuery}`,
        {
          headers: {
            accept: "text/event-stream",
            "x-openclaw-scopes": "operator.read",
          },
        },
      );
      const reader = response.body?.getReader();
      if (!response.ok || !reader) {
        throw new Error("SSE cursor page did not open");
      }
      await readSseEvent(reader);
      counter.reset();
      const before = process.memoryUsage();
      const startedAt = performance.now();
      modules.emitTranscriptUpdate({ target: { agentId: "main", sessionId, sessionKey } });
      await readSseEvent(reader);
      const after = process.memoryUsage();
      const sample = {
        eventParses: counter.read(),
        heapDeltaBytes: after.heapUsed - before.heapUsed,
        latencyMs: Number((performance.now() - startedAt).toFixed(3)),
        rssDeltaBytes: after.rss - before.rss,
      };
      await reader.cancel();
      return sample;
    };
    for (let index = 0; index < WARMUPS; index += 1) {
      await measureSseRefresh();
    }
    // Each SSE sample measures only the production refresh after its initial
    // cursor page has arrived, matching the long-lived stream workload.
    const sseSamples: OperationSample[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      sseSamples.push(await measureSseRefresh());
    }
    // Pin the production candidate query shape to the active-message keyset
    // index and the transcript-event primary key, with no temporary sort.
    const visiblePlan = database.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT active.event_seq, active.message_position, event.event_json
           FROM session_transcript_active_events AS active
           JOIN transcript_events AS event
             ON event.session_id = active.session_id AND event.seq = active.event_seq
          WHERE active.session_id = ?
            AND active.message_position IS NOT NULL
            AND active.message_position < ?
          ORDER BY active.message_position DESC
          LIMIT ${String(RAW_WINDOW)}`,
      )
      .all(sessionId, EVENT_COUNT - PAGE_SIZE)
      .map((row) => (row as { detail: string }).detail);
    console.log(
      JSON.stringify(
        {
          checkout: CHECKOUT,
          fixture: {
            eventCount: EVENT_COUNT,
            eventShape: "linear active assistant messages with 64-character text payload",
            pageSize: PAGE_SIZE,
            rawWindow: RAW_WINDOW,
            webSocketRawWindow: RAW_WINDOW + 1,
          },
          gitSha: execFileSync("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          machine: { hostname: os.hostname(), platform: process.platform, arch: process.arch },
          memory: { peakRssKb: process.resourceUsage().maxRSS },
          node: process.version,
          runs: RUNS,
          timings: {
            httpJsonCursor: summarize(httpSamples),
            sseCursorRefresh: summarize(sseSamples),
            webSocketVisibleCursorReader: summarize(webSocketSamples),
          },
          visibleQueryPlan: visiblePlan,
          warmups: WARMUPS,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    modules.closeAgentDatabases();
    modules.closeStateDatabase();
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
}

await main();
