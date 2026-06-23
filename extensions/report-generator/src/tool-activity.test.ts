import { describe, expect, it, vi } from "vitest";
import {
  ToolActivityNarrator,
  resolveToolCategory,
  resolveToolLabel,
  type ActivityStep,
} from "./tool-activity.js";

describe("resolveToolLabel", () => {
  it("maps known tools to user-facing labels", () => {
    expect(resolveToolLabel("exec")).toBe("正在查询分析数据");
    expect(resolveToolLabel("Read")).toBe("正在查阅资料");
    expect(resolveToolLabel("web_search")).toBe("正在检索网络信息");
  });

  it("falls back to a generic label for unknown tools", () => {
    expect(resolveToolLabel("some_plugin_tool")).toBe("正在执行处理步骤");
    expect(resolveToolLabel("")).toBe("正在执行处理步骤");
  });
});

describe("resolveToolCategory", () => {
  it("maps known tools to sanitized categories", () => {
    expect(resolveToolCategory("exec")).toBe("query");
    expect(resolveToolCategory("Read")).toBe("read");
    expect(resolveToolCategory("edit")).toBe("write");
    expect(resolveToolCategory("web_fetch")).toBe("search");
    expect(resolveToolCategory("memory_search")).toBe("memory");
  });

  it("falls back to the default category for unknown tools", () => {
    expect(resolveToolCategory("some_plugin_tool")).toBe("default");
    expect(resolveToolCategory("")).toBe("default");
  });
});

describe("ToolActivityNarrator", () => {
  function createNarrator(minIntervalMs = 2000) {
    let nowMs = 0;
    const pushed: string[] = [];
    const steps: ActivityStep[] = [];
    const narrator = new ToolActivityNarrator({
      push: (message) => pushed.push(message),
      onStep: (step) => steps.push(step),
      minIntervalMs,
      now: () => nowMs,
    });
    return { narrator, pushed, steps, advance: (ms: number) => (nowMs += ms) };
  }

  it("pushes a sanitized status line on tool start, never leaking args", () => {
    const { narrator, pushed } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "exec",
        args: { command: "mysql -uroot -pSECRET -e 'SELECT * FROM feed_monitor_item'" },
      },
    });
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…"]);
    expect(pushed[0]).not.toContain("SECRET");
    expect(pushed[0]).not.toContain("SELECT");
  });

  it("ignores non-tool streams and non-start phases", () => {
    const { narrator, pushed } = createNarrator();
    narrator.handleAgentEvent({ stream: "assistant", data: { delta: "hi" } });
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "update", name: "exec" } });
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "end", name: "exec" } });
    narrator.handleAgentEvent({ stream: "tool" });
    expect(pushed).toEqual([]);
  });

  it("collapses same-label bursts within minIntervalMs", () => {
    const { narrator, pushed, advance } = createNarrator(2000);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    advance(500);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    advance(2000);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    // Collapsed events do not consume step numbers — they stay contiguous.
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…", "正在查询分析数据（第 2 步）…"]);
  });

  it("pushes immediately when the tool kind changes", () => {
    const { narrator, pushed, advance } = createNarrator(2000);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    advance(100);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "read" } });
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…", "正在查阅资料（第 2 步）…"]);
  });

  it("uses Date.now by default without throwing", () => {
    const push = vi.fn();
    const narrator = new ToolActivityNarrator({ push });
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("emits a structured start step with sanitized label and category", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tc-1",
        args: { command: "SELECT secret FROM users" },
      },
    });
    expect(steps).toEqual([
      { phase: "start", stepId: "tc-1", index: 1, label: "正在查询分析数据", category: "query", status: "running" },
    ]);
    expect(JSON.stringify(steps)).not.toContain("secret");
  });

  it("pairs start/end by stepId and computes duration", () => {
    const { narrator, steps, advance } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tc-9" },
    });
    advance(1500);
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "read", toolCallId: "tc-9", status: "completed" },
    });
    expect(steps).toEqual([
      { phase: "start", stepId: "tc-9", index: 1, label: "正在查阅资料", category: "read", status: "running" },
      {
        phase: "end",
        stepId: "tc-9",
        index: 1,
        label: "正在查阅资料",
        category: "read",
        status: "completed",
        durationMs: 1500,
      },
    ]);
  });

  it("uses explicit startedAt/endedAt timestamps for duration when present", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "tc-2", startedAt: 1000 },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "exec", toolCallId: "tc-2", startedAt: 1000, endedAt: 3200 },
    });
    expect(steps[1]).toMatchObject({ phase: "end", durationMs: 2200, status: "completed" });
  });

  it("maps a failed end status to a failed step", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "tc-3" },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "exec", toolCallId: "tc-3", status: "failed" },
    });
    expect(steps[1]).toMatchObject({ phase: "end", status: "failed" });
  });

  it("does not collapse structured steps even when the string line is collapsed", () => {
    const { narrator, pushed, steps } = createNarrator(2000);
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "a" },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "b" },
    });
    // String push collapses the same-label burst into one line...
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…"]);
    // ...but each tool call still gets its own structured start step.
    expect(steps.map((s) => s.stepId)).toEqual(["a", "b"]);
  });

  it("ignores an end with no matching start (no phantom step)", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "exec", toolCallId: "ghost", status: "completed" },
    });
    expect(steps).toEqual([]);
  });
});
