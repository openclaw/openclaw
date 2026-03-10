import { describe, expect, it } from "vitest";
import type { TraceSpan } from "./types.js";
import { renderCallTree, renderEntityTree, renderWaterfall } from "./viewer-cli.js";

/** Strip ANSI escape codes for content assertions. */
function strip(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeSpan(
  overrides: Partial<TraceSpan> & Pick<TraceSpan, "spanId" | "kind" | "name" | "startMs">,
): TraceSpan {
  return {
    traceId: "trace-1",
    attributes: {},
    ...overrides,
  };
}

const sessionSpan = makeSpan({
  spanId: "s1",
  kind: "session",
  name: "root-session",
  agentId: "orchestrator",
  sessionKey: "sess-abc",
  startMs: 0,
  endMs: 5000,
  durationMs: 5000,
});

const llmSpan = makeSpan({
  spanId: "s2",
  parentSpanId: "s1",
  kind: "llm_call",
  name: "llm",
  agentId: "orchestrator",
  startMs: 100,
  endMs: 2000,
  durationMs: 1900,
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  tokensIn: 500,
  tokensOut: 200,
});

const toolSpan = makeSpan({
  spanId: "s3",
  parentSpanId: "s1",
  kind: "tool_call",
  name: "bash",
  agentId: "orchestrator",
  toolName: "bash",
  toolParams: { command: "ls -la" },
  startMs: 2100,
  endMs: 2500,
  durationMs: 400,
});

const subagentSpan = makeSpan({
  spanId: "s4",
  parentSpanId: "s1",
  kind: "subagent",
  name: "spawn-researcher",
  agentId: "orchestrator",
  childAgentId: "researcher",
  childSessionKey: "sess-xyz",
  startMs: 2600,
  endMs: 4500,
  durationMs: 1900,
});

const childSessionSpan = makeSpan({
  spanId: "s5",
  kind: "session",
  name: "researcher-session",
  agentId: "researcher",
  sessionKey: "sess-xyz",
  startMs: 2600,
  endMs: 4500,
  durationMs: 1900,
});

const childLlmSpan = makeSpan({
  spanId: "s6",
  parentSpanId: "s5",
  kind: "llm_call",
  name: "llm",
  agentId: "researcher",
  startMs: 2700,
  endMs: 4000,
  durationMs: 1300,
  provider: "openai",
  model: "gpt-4o",
  tokensIn: 300,
  tokensOut: 150,
});

const allSpans: TraceSpan[] = [
  sessionSpan,
  llmSpan,
  toolSpan,
  subagentSpan,
  childSessionSpan,
  childLlmSpan,
];

describe("renderCallTree", () => {
  it("returns empty array for empty spans", () => {
    expect(renderCallTree([])).toEqual([]);
  });

  it("returns lines containing tree connectors and span names", () => {
    const lines = renderCallTree(allSpans);
    expect(lines.length).toBeGreaterThan(0);

    const plain = lines.map(strip);
    const joined = plain.join("\n");

    // Should contain tree connectors
    expect(joined).toContain("├─");

    // Should contain the root agent name
    expect(plain.some((l) => l.includes("orchestrator"))).toBe(true);

    // Should contain the tool name
    expect(plain.some((l) => l.includes("bash"))).toBe(true);

    // Should contain llm label
    expect(plain.some((l) => l.includes("llm"))).toBe(true);

    // Should contain subagent child reference
    expect(plain.some((l) => l.includes("researcher"))).toBe(true);
  });

  it("includes duration information", () => {
    const lines = renderCallTree(allSpans);
    const plain = lines.map(strip);
    // 5000ms = 5.0s
    expect(plain.some((l) => l.includes("5.0s"))).toBe(true);
    // 400ms stays as ms
    expect(plain.some((l) => l.includes("400ms"))).toBe(true);
  });

  it("includes token info for llm spans", () => {
    const lines = renderCallTree(allSpans);
    const plain = lines.map(strip);
    expect(plain.some((l) => l.includes("in:500") && l.includes("out:200"))).toBe(true);
  });

  it("sorts children by startMs", () => {
    const lines = renderCallTree(allSpans);
    const plain = lines.map(strip);
    const llmIdx = plain.findIndex((l) => l.includes("llm") && l.includes("anthropic"));
    const toolIdx = plain.findIndex((l) => l.includes("bash"));
    const subagentIdx = plain.findIndex((l) => l.includes("researcher"));
    expect(llmIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(subagentIdx);
  });
});

describe("renderEntityTree", () => {
  it("returns empty array for empty spans", () => {
    expect(renderEntityTree([])).toEqual([]);
  });

  it("returns agent summary lines with stats", () => {
    const lines = renderEntityTree(allSpans);
    expect(lines.length).toBeGreaterThan(0);

    const plain = lines.map(strip);
    const joined = plain.join("\n");

    // Should contain agent names
    expect(joined).toContain("orchestrator");
    expect(joined).toContain("researcher");

    // Should contain LLM call counts
    expect(plain.some((l) => l.includes("LLM calls"))).toBe(true);

    // Should contain tool call counts
    expect(plain.some((l) => l.includes("tool calls"))).toBe(true);

    // Should contain model info
    expect(plain.some((l) => l.includes("claude-sonnet-4-20250514"))).toBe(true);

    // Should contain tool names
    expect(plain.some((l) => l.includes("tools:") && l.includes("bash"))).toBe(true);
  });

  it("includes summary section", () => {
    const lines = renderEntityTree(allSpans);
    const plain = lines.map(strip);
    const joined = plain.join("\n");
    expect(joined).toContain("Summary");
    expect(joined).toContain("Agents:");
  });

  it("includes token stats", () => {
    const lines = renderEntityTree(allSpans);
    const plain = lines.map(strip);
    expect(plain.some((l) => l.includes("tokens:"))).toBe(true);
  });
});

describe("renderWaterfall", () => {
  it("returns empty array for empty spans", () => {
    expect(renderWaterfall([])).toEqual([]);
  });

  it("returns timeline bars", () => {
    const lines = renderWaterfall(allSpans);
    expect(lines.length).toBeGreaterThan(0);

    const plain = lines.map(strip);

    // Should contain bar characters
    expect(plain.some((l) => l.includes("█"))).toBe(true);

    // Should contain bar delimiters
    expect(plain.some((l) => l.includes("│"))).toBe(true);
  });

  it("includes span labels", () => {
    const lines = renderWaterfall(allSpans);
    const plain = lines.map(strip);
    // Session label = agentId
    expect(plain.some((l) => l.includes("orchestrator"))).toBe(true);
    // Tool label = toolName
    expect(plain.some((l) => l.includes("bash"))).toBe(true);
  });

  it("includes duration for each span", () => {
    const lines = renderWaterfall(allSpans);
    const plain = lines.map(strip);
    // Should show durations
    expect(plain.some((l) => l.includes("5.0s"))).toBe(true);
    expect(plain.some((l) => l.includes("400ms"))).toBe(true);
  });

  it("includes a footer with total duration", () => {
    const lines = renderWaterfall(allSpans);
    const plain = lines.map(strip);
    // Last line should show total duration
    const lastLine = plain[plain.length - 1]!;
    expect(lastLine).toContain("5.0s");
    expect(lastLine).toContain("0");
  });
});
