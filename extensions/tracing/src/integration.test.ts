import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceCollector } from "./collector.js";
import { JsonlTraceWriter } from "./storage-jsonl.js";
import { renderCallTree, renderEntityTree, renderWaterfall } from "./viewer-cli.js";

/**
 * Integration test: collector → JSONL writer → reader → viewer.
 * Simulates a multi-agent scenario: main bot → LLM → tool → spawn sub-agent → sub-agent LLM → tool.
 */
describe("tracing integration", () => {
  let tmpDir: string;
  let writer: JsonlTraceWriter;
  let collector: TraceCollector;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-integration-"));
    writer = new JsonlTraceWriter(tmpDir);
    collector = new TraceCollector((span) => writer.write(span));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runScenario() {
    // Main session starts
    collector.onSessionStart(
      { sessionId: "sid1", sessionKey: "sk-main" },
      { agentId: "research-bot", sessionId: "sid1", sessionKey: "sk-main" },
    );

    // Main: LLM call
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
      { agentId: "research-bot", sessionId: "sid1", sessionKey: "sk-main" },
    );

    // Main: tool call during LLM
    collector.onBeforeToolCall(
      { toolName: "web_search", params: { query: "test" }, runId: "r1", toolCallId: "tc1" },
      {
        agentId: "research-bot",
        sessionKey: "sk-main",
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
        durationMs: 800,
      },
      {
        agentId: "research-bot",
        sessionKey: "sk-main",
        sessionId: "sid1",
        runId: "r1",
        toolName: "web_search",
      },
    );

    // Main: LLM output
    collector.onLlmOutput(
      {
        runId: "r1",
        sessionId: "sid1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        assistantTexts: ["result"],
        usage: { input: 500, output: 100 },
      },
      { agentId: "research-bot", sessionId: "sid1", sessionKey: "sk-main" },
    );

    // Main: spawn sub-agent
    collector.onSubagentSpawning(
      {
        childSessionKey: "sk-child",
        agentId: "translator-bot",
        mode: "run",
        threadRequested: false,
      },
      { runId: "r1", childSessionKey: "sk-child", requesterSessionKey: "sk-main" },
    );

    // Child session starts
    collector.onSessionStart(
      { sessionId: "sid2", sessionKey: "sk-child" },
      { agentId: "translator-bot", sessionId: "sid2", sessionKey: "sk-child" },
    );

    // Child: LLM call
    collector.onLlmInput(
      {
        runId: "r2",
        sessionId: "sid2",
        provider: "openai",
        model: "gpt-4o",
        prompt: "translate",
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "translator-bot", sessionId: "sid2", sessionKey: "sk-child" },
    );
    collector.onLlmOutput(
      {
        runId: "r2",
        sessionId: "sid2",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["done"],
        usage: { input: 200, output: 80 },
      },
      { agentId: "translator-bot", sessionId: "sid2", sessionKey: "sk-child" },
    );

    // Child session ends
    collector.onSessionEnd(
      { sessionId: "sid2", sessionKey: "sk-child", messageCount: 3, durationMs: 2000 },
      { agentId: "translator-bot", sessionId: "sid2", sessionKey: "sk-child" },
    );

    // Sub-agent ends
    collector.onSubagentEnded(
      { targetSessionKey: "sk-child", targetKind: "subagent", reason: "done", outcome: "ok" },
      { runId: "r1", childSessionKey: "sk-child", requesterSessionKey: "sk-main" },
    );

    // Main session ends
    collector.onSessionEnd(
      { sessionId: "sid1", sessionKey: "sk-main", messageCount: 5, durationMs: 5000 },
      { agentId: "research-bot", sessionId: "sid1", sessionKey: "sk-main" },
    );
  }

  it("writes spans to JSONL and reads them back", () => {
    runScenario();
    const today = new Date().toISOString().slice(0, 10);
    const spans = writer.readByDate(today);
    expect(spans.length).toBeGreaterThanOrEqual(8);
  });

  it("all spans share the same traceId for main session", () => {
    runScenario();
    const spans = writer.readToday();
    const mainSpans = spans.filter((s) => s.sessionKey === "sk-main");
    const traceIds = new Set(mainSpans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
  });

  it("renderCallTree produces tree output from stored spans", () => {
    runScenario();
    const spans = writer.readToday();
    const lines = renderCallTree(spans);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("research-bot");
    expect(plain).toContain("web_search");
  });

  it("renderEntityTree shows both agents", () => {
    runScenario();
    const spans = writer.readToday();
    const lines = renderEntityTree(spans);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("research-bot");
    expect(plain).toContain("translator-bot");
  });

  it("renderWaterfall produces timeline output", () => {
    runScenario();
    const spans = writer.readToday();
    const lines = renderWaterfall(spans);
    expect(lines.length).toBeGreaterThan(0);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("█");
  });

  it("tool_call span has llm_call as parent", () => {
    runScenario();
    const spans = writer.readToday();
    // Find closed tool span (has endMs set)
    const toolSpan = spans.find((s) => s.kind === "tool_call" && s.endMs !== undefined);
    expect(toolSpan).toBeDefined();
    // Its parent should be an llm_call span
    const parent = spans.find((s) => s.spanId === toolSpan!.parentSpanId);
    expect(parent).toBeDefined();
    expect(parent!.kind).toBe("llm_call");
  });
});
