import { describe, expect, it, vi } from "vitest";
import { ToolActivityNarrator, resolveToolLabel } from "./tool-activity.js";

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

describe("ToolActivityNarrator", () => {
  function createNarrator(minIntervalMs = 2000) {
    let nowMs = 0;
    const pushed: string[] = [];
    const narrator = new ToolActivityNarrator({
      push: (message) => pushed.push(message),
      minIntervalMs,
      now: () => nowMs,
    });
    return { narrator, pushed, advance: (ms: number) => (nowMs += ms) };
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
});
