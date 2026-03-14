# Agent Tracing Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `extensions/tracing` plugin that captures tool calls, LLM invocations, and sub-agent relationships as JSONL trace spans, viewable via CLI tree views.

**Architecture:** Plugin registers hooks (`session_start/end`, `llm_input/output`, `before/after_tool_call`, `subagent_spawning/ended`) that emit `TraceSpan` objects to a JSONL writer. A CLI command reads JSONL and renders call tree, entity tree, and waterfall views.

**Tech Stack:** TypeScript ESM, OpenClaw plugin SDK (`api.on()` hooks, `api.registerCli()`), Node fs for JSONL I/O.

---

### Task 1: Scaffold plugin package

**Files:**

- Create: `extensions/tracing/package.json`
- Create: `extensions/tracing/src/types.ts`

**Step 1: Create package.json**

```json
{
  "name": "@openclaw/tracing",
  "version": "2026.3.9",
  "description": "Agent execution tracing with tree-view CLI",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

**Step 2: Create types.ts**

```typescript
export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: "session" | "llm_call" | "tool_call" | "subagent";
  name: string;
  agentId?: string;
  sessionKey?: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  attributes: Record<string, string | number | boolean>;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  childSessionKey?: string;
  childAgentId?: string;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
};

export type TracingConfig = {
  enabled?: boolean;
  retentionDays?: number;
  redactToolParams?: boolean;
};
```

**Step 3: Commit**

```bash
scripts/committer "feat(tracing): scaffold plugin package and types" extensions/tracing/package.json extensions/tracing/src/types.ts
```

---

### Task 2: JSONL storage writer

**Files:**

- Create: `extensions/tracing/src/storage-jsonl.ts`
- Create: `extensions/tracing/src/storage-jsonl.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonlTraceWriter } from "./storage-jsonl.js";
import type { TraceSpan } from "./types.js";

describe("JsonlTraceWriter", () => {
  let tmpDir: string;
  let writer: JsonlTraceWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
    writer = new JsonlTraceWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes span to daily JSONL file", () => {
    const span: TraceSpan = {
      traceId: "t1",
      spanId: "s1",
      kind: "session",
      name: "test",
      startMs: Date.now(),
      attributes: {},
    };
    writer.write(span);
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const content = fs.readFileSync(path.join(tmpDir, files[0]!), "utf-8").trim();
    expect(JSON.parse(content)).toMatchObject({ traceId: "t1", spanId: "s1" });
  });

  it("appends multiple spans to same file", () => {
    const base = { kind: "session" as const, name: "test", startMs: Date.now(), attributes: {} };
    writer.write({ ...base, traceId: "t1", spanId: "s1" });
    writer.write({ ...base, traceId: "t1", spanId: "s2" });
    const files = fs.readdirSync(tmpDir);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]!), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("reads spans back from file", () => {
    const span: TraceSpan = {
      traceId: "t1",
      spanId: "s1",
      kind: "session",
      name: "test",
      startMs: Date.now(),
      attributes: {},
    };
    writer.write(span);
    const spans = writer.readToday();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.spanId).toBe("s1");
  });

  it("reads spans by date", () => {
    const span: TraceSpan = {
      traceId: "t1",
      spanId: "s1",
      kind: "session",
      name: "test",
      startMs: Date.now(),
      attributes: {},
    };
    writer.write(span);
    const today = new Date().toISOString().slice(0, 10);
    const spans = writer.readByDate(today);
    expect(spans).toHaveLength(1);
  });

  it("lists available trace dates", () => {
    writer.write({
      traceId: "t1",
      spanId: "s1",
      kind: "session",
      name: "test",
      startMs: Date.now(),
      attributes: {},
    });
    const dates = writer.listDates();
    expect(dates.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/tracing/src/storage-jsonl.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
import fs from "node:fs";
import path from "node:path";
import type { TraceSpan } from "./types.js";

export class JsonlTraceWriter {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private dateKey(date?: Date): string {
    return (date ?? new Date()).toISOString().slice(0, 10);
  }

  private filePath(dateKey: string): string {
    return path.join(this.dir, `${dateKey}.jsonl`);
  }

  write(span: TraceSpan): void {
    const file = this.filePath(this.dateKey());
    fs.appendFileSync(file, JSON.stringify(span) + "\n");
  }

  readByDate(dateKey: string): TraceSpan[] {
    const file = this.filePath(dateKey);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceSpan);
  }

  readToday(): TraceSpan[] {
    return this.readByDate(this.dateKey());
  }

  listDates(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""))
      .sort()
      .reverse();
  }

  cleanup(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const dateKey of this.listDates()) {
      if (new Date(dateKey).getTime() < cutoff) {
        fs.unlinkSync(this.filePath(dateKey));
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/tracing/src/storage-jsonl.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "feat(tracing): add JSONL storage writer with tests" extensions/tracing/src/storage-jsonl.ts extensions/tracing/src/storage-jsonl.test.ts
```

---

### Task 3: Span collector (hook handlers)

**Files:**

- Create: `extensions/tracing/src/collector.ts`
- Create: `extensions/tracing/src/collector.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { TraceCollector } from "./collector.js";
import type { TraceSpan } from "./types.js";

describe("TraceCollector", () => {
  let spans: TraceSpan[];
  let collector: TraceCollector;

  beforeEach(() => {
    spans = [];
    collector = new TraceCollector((span) => spans.push(span));
  });

  it("creates session root span on session_start", () => {
    collector.onSessionStart(
      { sessionId: "sid1", sessionKey: "sk1" },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: "session", agentId: "bot1" });
    expect(spans[0]!.traceId).toBeTruthy();
    expect(spans[0]!.endMs).toBeUndefined();
  });

  it("closes session span on session_end", () => {
    collector.onSessionStart(
      { sessionId: "sid1", sessionKey: "sk1" },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    collector.onSessionEnd(
      { sessionId: "sid1", sessionKey: "sk1", messageCount: 5, durationMs: 3000 },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    expect(spans).toHaveLength(2);
    expect(spans[1]).toMatchObject({
      kind: "session",
      endMs: expect.any(Number),
      durationMs: 3000,
    });
  });

  it("tracks llm_input → llm_output as llm_call span", () => {
    collector.onSessionStart(
      { sessionId: "sid1", sessionKey: "sk1" },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    collector.onLlmInput(
      {
        runId: "r1",
        sessionId: "sid1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        prompt: "hi",
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    collector.onLlmOutput(
      {
        runId: "r1",
        sessionId: "sid1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        assistantTexts: ["hello"],
        usage: { input: 100, output: 50 },
      },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    const llmSpans = spans.filter((s) => s.kind === "llm_call");
    expect(llmSpans).toHaveLength(1);
    expect(llmSpans[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      tokensIn: 100,
      tokensOut: 50,
      endMs: expect.any(Number),
    });
    expect(llmSpans[0]!.parentSpanId).toBeTruthy();
  });

  it("tracks before/after tool_call as tool_call span", () => {
    collector.onSessionStart(
      { sessionId: "sid1", sessionKey: "sk1" },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    collector.onLlmInput(
      {
        runId: "r1",
        sessionId: "sid1",
        provider: "anthropic",
        model: "sonnet",
        prompt: "hi",
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    collector.onBeforeToolCall(
      { toolName: "web_search", params: { query: "test" }, runId: "r1", toolCallId: "tc1" },
      {
        agentId: "bot1",
        sessionKey: "sk1",
        sessionId: "sid1",
        runId: "r1",
        toolName: "web_search",
      },
    );
    collector.onAfterToolCall(
      {
        toolName: "web_search",
        params: { query: "test" },
        runId: "r1",
        toolCallId: "tc1",
        durationMs: 500,
      },
      {
        agentId: "bot1",
        sessionKey: "sk1",
        sessionId: "sid1",
        runId: "r1",
        toolName: "web_search",
      },
    );
    const toolSpans = spans.filter((s) => s.kind === "tool_call");
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0]).toMatchObject({ toolName: "web_search", durationMs: 500 });
  });

  it("tracks subagent_spawning → subagent_ended", () => {
    collector.onSessionStart(
      { sessionId: "sid1", sessionKey: "sk1" },
      { agentId: "bot1", sessionId: "sid1", sessionKey: "sk1" },
    );
    collector.onSubagentSpawning(
      {
        childSessionKey: "sk2",
        agentId: "child-bot",
        label: "translator",
        mode: "run",
        threadRequested: false,
      },
      { runId: "r1", childSessionKey: "sk2", requesterSessionKey: "sk1" },
    );
    collector.onSubagentEnded(
      { targetSessionKey: "sk2", targetKind: "subagent", reason: "done", outcome: "ok" },
      { runId: "r1", childSessionKey: "sk2", requesterSessionKey: "sk1" },
    );
    const subSpans = spans.filter((s) => s.kind === "subagent");
    expect(subSpans).toHaveLength(1);
    expect(subSpans[0]).toMatchObject({ childAgentId: "child-bot", childSessionKey: "sk2" });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/tracing/src/collector.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
import crypto from "node:crypto";
import type { TraceSpan } from "./types.js";
import type {
  PluginHookSessionStartEvent,
  PluginHookSessionEndEvent,
  PluginHookSessionContext,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookAgentContext,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentContext,
} from "openclaw/plugin-sdk";

const id = () => crypto.randomUUID().slice(0, 16);

export class TraceCollector {
  // sessionKey → { traceId, sessionSpanId }
  private sessions = new Map<string, { traceId: string; spanId: string }>();
  // runId → llm spanId (for parent linking tool_call → llm_call)
  private activeRuns = new Map<string, string>();
  // toolCallId → spanId (for open tool spans)
  private activeTools = new Map<string, string>();
  // childSessionKey → spanId (for open subagent spans)
  private activeSubagents = new Map<string, string>();

  constructor(private emit: (span: TraceSpan) => void) {}

  private sessionCtx(sessionKey?: string) {
    return sessionKey ? this.sessions.get(sessionKey) : undefined;
  }

  onSessionStart(event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext): void {
    const sk = ctx.sessionKey ?? event.sessionKey;
    if (!sk) return;
    const spanId = id();
    const traceId = id();
    this.sessions.set(sk, { traceId, spanId });
    this.emit({
      traceId,
      spanId,
      kind: "session",
      name: `${ctx.agentId ?? "agent"} session`,
      agentId: ctx.agentId,
      sessionKey: sk,
      startMs: Date.now(),
      attributes: {},
    });
  }

  onSessionEnd(event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext): void {
    const sk = ctx.sessionKey ?? event.sessionKey;
    if (!sk) return;
    const session = this.sessions.get(sk);
    if (!session) return;
    this.emit({
      traceId: session.traceId,
      spanId: session.spanId,
      kind: "session",
      name: `${ctx.agentId ?? "agent"} session`,
      agentId: ctx.agentId,
      sessionKey: sk,
      startMs: Date.now() - (event.durationMs ?? 0),
      endMs: Date.now(),
      durationMs: event.durationMs,
      attributes: { messageCount: event.messageCount },
    });
    this.sessions.delete(sk);
  }

  onLlmInput(event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext): void {
    const session = this.sessionCtx(ctx.sessionKey);
    if (!session) return;
    const spanId = id();
    if (event.runId) this.activeRuns.set(event.runId, spanId);
    this.emit({
      traceId: session.traceId,
      spanId,
      parentSpanId: session.spanId,
      kind: "llm_call",
      name: "llm_call",
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      provider: event.provider,
      model: event.model,
      startMs: Date.now(),
      attributes: {},
    });
  }

  onLlmOutput(event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void {
    const session = this.sessionCtx(ctx.sessionKey);
    if (!session) return;
    const spanId = event.runId ? this.activeRuns.get(event.runId) : undefined;
    if (!spanId) return;
    this.emit({
      traceId: session.traceId,
      spanId,
      parentSpanId: session.spanId,
      kind: "llm_call",
      name: "llm_call",
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      provider: event.provider,
      model: event.model,
      tokensIn: event.usage?.input,
      tokensOut: event.usage?.output,
      startMs: Date.now(),
      endMs: Date.now(),
      attributes: {},
    });
  }

  onBeforeToolCall(event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): void {
    const session = this.sessionCtx(ctx.sessionKey);
    if (!session) return;
    const spanId = id();
    const parentLlm = ctx.runId ? this.activeRuns.get(ctx.runId) : undefined;
    if (event.toolCallId) this.activeTools.set(event.toolCallId, spanId);
    this.emit({
      traceId: session.traceId,
      spanId,
      parentSpanId: parentLlm ?? session.spanId,
      kind: "tool_call",
      name: event.toolName,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolName: event.toolName,
      toolParams: event.params,
      startMs: Date.now(),
      attributes: {},
    });
  }

  onAfterToolCall(event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void {
    const session = this.sessionCtx(ctx.sessionKey);
    if (!session) return;
    const spanId = event.toolCallId ? this.activeTools.get(event.toolCallId) : undefined;
    if (!spanId) return;
    const parentLlm = ctx.runId ? this.activeRuns.get(ctx.runId) : undefined;
    this.emit({
      traceId: session.traceId,
      spanId,
      parentSpanId: parentLlm ?? session.spanId,
      kind: "tool_call",
      name: event.toolName,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolName: event.toolName,
      toolParams: event.params,
      startMs: Date.now() - (event.durationMs ?? 0),
      endMs: Date.now(),
      durationMs: event.durationMs,
      attributes: event.error ? { error: event.error } : {},
    });
    if (event.toolCallId) this.activeTools.delete(event.toolCallId);
  }

  onSubagentSpawning(event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext): void {
    const session = this.sessionCtx(ctx.requesterSessionKey);
    if (!session) return;
    const spanId = id();
    this.activeSubagents.set(event.childSessionKey, spanId);
    this.emit({
      traceId: session.traceId,
      spanId,
      parentSpanId: session.spanId,
      kind: "subagent",
      name: `spawn:${event.agentId}`,
      agentId: undefined,
      sessionKey: ctx.requesterSessionKey,
      childSessionKey: event.childSessionKey,
      childAgentId: event.agentId,
      startMs: Date.now(),
      attributes: { mode: event.mode },
    });
  }

  onSubagentEnded(event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext): void {
    const childSk = event.targetSessionKey ?? ctx.childSessionKey;
    if (!childSk) return;
    const spanId = this.activeSubagents.get(childSk);
    if (!spanId) return;
    const session = this.sessionCtx(ctx.requesterSessionKey);
    const traceId = session?.traceId ?? "unknown";
    this.emit({
      traceId,
      spanId,
      parentSpanId: session?.spanId,
      kind: "subagent",
      name: `spawn:ended`,
      childSessionKey: childSk,
      startMs: Date.now(),
      endMs: Date.now(),
      durationMs: undefined,
      attributes: { outcome: event.outcome ?? "unknown", reason: event.reason },
    });
    this.activeSubagents.delete(childSk);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/tracing/src/collector.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "feat(tracing): add span collector with hook handlers" extensions/tracing/src/collector.ts extensions/tracing/src/collector.test.ts
```

---

### Task 4: CLI tree viewer

**Files:**

- Create: `extensions/tracing/src/viewer-cli.ts`
- Create: `extensions/tracing/src/viewer-cli.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { renderCallTree, renderEntityTree } from "./viewer-cli.js";
import type { TraceSpan } from "./types.js";

const spans: TraceSpan[] = [
  {
    traceId: "t1",
    spanId: "s1",
    kind: "session",
    name: "bot session",
    agentId: "bot",
    sessionKey: "sk1",
    startMs: 0,
    endMs: 5000,
    durationMs: 5000,
    attributes: {},
  },
  {
    traceId: "t1",
    spanId: "s2",
    parentSpanId: "s1",
    kind: "llm_call",
    name: "llm_call",
    agentId: "bot",
    sessionKey: "sk1",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    startMs: 100,
    endMs: 1500,
    durationMs: 1400,
    tokensIn: 200,
    tokensOut: 50,
    attributes: {},
  },
  {
    traceId: "t1",
    spanId: "s3",
    parentSpanId: "s2",
    kind: "tool_call",
    name: "web_search",
    agentId: "bot",
    sessionKey: "sk1",
    toolName: "web_search",
    startMs: 1500,
    endMs: 2500,
    durationMs: 1000,
    attributes: {},
  },
];

describe("renderCallTree", () => {
  it("returns lines with tree connectors", () => {
    const lines = renderCallTree(spans);
    expect(lines.length).toBeGreaterThan(0);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("bot");
    expect(plain).toContain("llm");
    expect(plain).toContain("web_search");
  });
});

describe("renderEntityTree", () => {
  it("returns agent summary lines", () => {
    const lines = renderEntityTree(spans);
    expect(lines.length).toBeGreaterThan(0);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("bot");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/tracing/src/viewer-cli.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Port the rendering logic from `demo-tracing/viewer.ts` into two pure functions that return `string[]` lines (testable, no direct `console.log`). Keep ANSI colors, icons, duration formatting.

Key functions:

- `renderCallTree(spans: TraceSpan[]): string[]`
- `renderEntityTree(spans: TraceSpan[]): string[]`
- `renderWaterfall(spans: TraceSpan[]): string[]`

Each returns an array of formatted lines. The CLI command joins and prints them.

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
scripts/committer "feat(tracing): add CLI tree viewer" extensions/tracing/src/viewer-cli.ts extensions/tracing/src/viewer-cli.test.ts
```

---

### Task 5: Plugin entry point + CLI registration

**Files:**

- Create: `extensions/tracing/index.ts`

**Step 1: Write plugin entry point**

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { TraceCollector } from "./src/collector.js";
import { JsonlTraceWriter } from "./src/storage-jsonl.js";
import { renderCallTree, renderEntityTree, renderWaterfall } from "./src/viewer-cli.js";
import path from "node:path";
import os from "node:os";

const plugin = {
  id: "tracing",
  name: "Agent Tracing",
  description: "Trace tool calls, LLM invocations, and sub-agent relationships",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const traceDir = path.join(os.homedir(), ".openclaw", "traces");
    const writer = new JsonlTraceWriter(traceDir);
    const collector = new TraceCollector((span) => writer.write(span));

    // Register hooks
    api.on("session_start", (event, ctx) => collector.onSessionStart(event, ctx));
    api.on("session_end", (event, ctx) => collector.onSessionEnd(event, ctx));
    api.on("llm_input", (event, ctx) => collector.onLlmInput(event, ctx));
    api.on("llm_output", (event, ctx) => collector.onLlmOutput(event, ctx));
    api.on("before_tool_call", (event, ctx) => collector.onBeforeToolCall(event, ctx));
    api.on("after_tool_call", (event, ctx) => collector.onAfterToolCall(event, ctx));
    api.on("subagent_spawning", (event, ctx) => {
      collector.onSubagentSpawning(event, ctx);
    });
    api.on("subagent_ended", (event, ctx) => collector.onSubagentEnded(event, ctx));

    // Register CLI command
    api.registerCli(
      (program) => {
        program
          .command("traces")
          .description("View agent execution traces")
          .option("--mode <mode>", "View mode: call, entity, waterfall, both", "both")
          .option("--date <date>", "Date to view (YYYY-MM-DD), defaults to today")
          .option("--list", "List available trace dates")
          .action((opts) => {
            if (opts.list) {
              const dates = writer.listDates();
              if (!dates.length) {
                console.log("No traces found.");
                return;
              }
              for (const d of dates) console.log(d);
              return;
            }
            const dateKey = opts.date ?? new Date().toISOString().slice(0, 10);
            const spans = writer.readByDate(dateKey);
            if (!spans.length) {
              console.log(`No traces for ${dateKey}.`);
              return;
            }
            const mode = opts.mode as string;
            if (mode === "call" || mode === "both") {
              for (const line of renderCallTree(spans)) console.log(line);
            }
            if (mode === "entity" || mode === "both") {
              for (const line of renderEntityTree(spans)) console.log(line);
            }
            if (mode === "waterfall" || mode === "both") {
              for (const line of renderWaterfall(spans)) console.log(line);
            }
          });
      },
      { commands: ["traces"] },
    );
  },
};

export default plugin;
```

**Step 2: Commit**

```bash
scripts/committer "feat(tracing): add plugin entry point with hook + CLI wiring" extensions/tracing/index.ts
```

---

### Task 6: Integration test with fake data

**Files:**

- Create: `extensions/tracing/src/integration.test.ts`

**Step 1: Write end-to-end test**

Test the full flow: collector → JSONL writer → reader → viewer rendering. Use the same fake scenario from `demo-tracing/generate-fake-data.ts` but driven programmatically through the collector's hook methods.

**Step 2: Run all tests**

Run: `npx vitest run extensions/tracing/`
Expected: All PASS

**Step 3: Commit**

```bash
scripts/committer "test(tracing): add integration test" extensions/tracing/src/integration.test.ts
```

---

### Task 7: Cleanup demo, final verification

**Step 1: Verify the full plugin works**

Run: `npx vitest run extensions/tracing/`

**Step 2: Remove demo-tracing directory** (it was just a prototype)

**Step 3: Final commit**

```bash
scripts/committer "chore: remove demo-tracing prototype" -d demo-tracing/
```
