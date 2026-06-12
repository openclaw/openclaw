import { describe, expect, it, vi } from "vitest";
import type { PluginLogger, PluginRuntime } from "../api.js";
import { ReportGenerator, salvageStreamedReport } from "./generator.js";
import type { CollectedStats } from "./query-plan.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as PluginLogger;

const emptyStats: CollectedStats = {
  total: 0,
  aggregations: [],
  topN: { metric: "", records: [] },
  details: [],
};

/**
 * Runtime whose report session returns `reportMessages`; the planning session
 * (sessionKey contains "report-plan") returns a non-plan so generation uses
 * the default query plan.
 */
function runtimeWith(reportMessages: unknown[]): PluginRuntime {
  return {
    events: { onAgentEvent: () => () => {} },
    subagent: {
      run: async () => ({ runId: "r1" }),
      waitForRun: async () => ({ status: "ok" as const }),
      getSessionMessages: async ({ sessionKey }: { sessionKey: string }) =>
        sessionKey.includes("report-plan")
          ? { messages: [{ role: "assistant", content: "{}" }] }
          : { messages: reportMessages },
    },
  } as unknown as PluginRuntime;
}

const baseOptions = {
  period: "Weekly" as const,
  requirement: "本周舆情",
  dateScope: "2026-06-01 00:00:00 ~ 2026-06-08 00:00:00",
  collectStats: async () => emptyStats,
  template: "# 周报模板\n{summary}",
  userId: "42",
  topicId: 585,
  slaveTopicId: 0,
};

describe("ReportGenerator.generate report extraction", () => {
  it("stores the report body even when a newer closing remark follows it", async () => {
    // Regression: download.content used to receive the agent's trailing
    // conversational remark instead of the report, because the report opened
    // with `## ` (not the `# ` the old selector required) and the newest
    // non-empty assistant message won.
    const report = "## 概述\n本周舆情整体平稳。\n\n## 风险提示\n暂无重大风险。";
    const runtime = runtimeWith([
      { role: "user", content: "生成周报" },
      { role: "assistant", content: report },
      { role: "assistant", content: "报告已生成，请查收。" },
    ]);

    const result = await new ReportGenerator(runtime).generate(baseOptions, logger);

    expect(result.content).toBe(report);
    expect(result.content).not.toContain("报告已生成");
  });

  it("extracts the title from an h1 report heading", async () => {
    const report = "# 2026年第23周舆情周报\n\n## 概述\n平稳。";
    const runtime = runtimeWith([{ role: "assistant", content: report }]);

    const result = await new ReportGenerator(runtime).generate(baseOptions, logger);

    expect(result.content).toBe(report);
    expect(result.title).toBe("2026年第23周舆情周报");
  });

  it("prefers the longest heading-bearing message over a short one", async () => {
    const longReport = `## 概述\n${"舆情数据。".repeat(40)}\n\n## 建议\n持续监测。`;
    const runtime = runtimeWith([
      { role: "assistant", content: "## 提示\n正在生成…" },
      { role: "assistant", content: longReport },
    ]);

    const result = await new ReportGenerator(runtime).generate(baseOptions, logger);

    expect(result.content).toBe(longReport);
  });
});

type AgentEvent = { sessionKey: string; stream: string; data: Record<string, unknown> };

/**
 * Runtime whose report run streams `deltas` through the agent-event listener
 * and then resolves waitForRun with `reportWaitStatus`; the planning run
 * always resolves ok with a non-plan reply (default query plan is used).
 */
function runtimeStreaming(
  deltas: string[],
  reportWaitStatus: "ok" | "timeout",
  runSpy?: (params: Record<string, unknown>) => void,
): PluginRuntime {
  let listener: ((evt: AgentEvent) => void) | undefined;
  return {
    events: {
      onAgentEvent: (cb: (evt: AgentEvent) => void) => {
        listener = cb;
        return () => {};
      },
    },
    subagent: {
      run: async (params: { sessionKey: string }) => {
        runSpy?.(params as unknown as Record<string, unknown>);
        const isPlan = params.sessionKey.includes("report-plan");
        if (!isPlan) {
          for (const delta of deltas) {
            listener?.({ sessionKey: params.sessionKey, stream: "assistant", data: { delta } });
          }
        }
        return { runId: isPlan ? "plan-run" : "report-run" };
      },
      waitForRun: async ({ runId }: { runId: string }) => ({
        status: runId === "report-run" ? reportWaitStatus : ("ok" as const),
      }),
      getSessionMessages: async () => ({ messages: [{ role: "assistant", content: "{}" }] }),
    },
  } as unknown as PluginRuntime;
}

describe("ReportGenerator.generate timeout salvage", () => {
  const reportBody = `# 周报\n\n## 概述\n${"本周舆情整体平稳，无重大风险事件。".repeat(15)}`;

  it("salvages the streamed report body when the run times out", async () => {
    const runtime = runtimeStreaming(["好的，我开始撰写报告。\n\n", reportBody], "timeout");

    const result = await new ReportGenerator(runtime).generate(baseOptions, logger);

    expect(result.content).toBe(reportBody);
    expect(result.title).toBe("周报");
  });

  it("still fails on timeout when no report body was streamed", async () => {
    const runtime = runtimeStreaming(["稍等，正在处理…"], "timeout");

    await expect(new ReportGenerator(runtime).generate(baseOptions, logger)).rejects.toThrow(
      /timed out/,
    );
  });
});

describe("ReportGenerator no-tools system prompt", () => {
  it("sends a tool-ban extraSystemPrompt with the report-writing run", async () => {
    const runs: Record<string, unknown>[] = [];
    const runtime = runtimeStreaming(["# 周报\n内容"], "ok", (params) => runs.push(params));
    // Report extraction comes from getSessionMessages ("{}" has no heading),
    // so the streamed-text fallback supplies the content; assertion targets
    // the run params, not the content.
    await new ReportGenerator(runtime).generate(baseOptions, logger);

    const reportRun = runs.find(
      (p) => typeof p.sessionKey === "string" && !p.sessionKey.includes("report-plan"),
    );
    expect(reportRun).toBeDefined();
    expect(String(reportRun?.extraSystemPrompt)).toContain("禁止调用任何工具");

    const planRun = runs.find(
      (p) => typeof p.sessionKey === "string" && p.sessionKey.includes("report-plan"),
    );
    expect(planRun).toBeDefined();
    expect(String(planRun?.extraSystemPrompt)).toContain("禁止调用任何工具");
  });
});

describe("salvageStreamedReport", () => {
  it("drops narration before the first heading", () => {
    const body = `# 标题\n${"正文内容。".repeat(50)}`;
    expect(salvageStreamedReport(`我先整理一下思路…\n${body}`)).toBe(body);
  });

  it("returns empty for headingless or too-short text", () => {
    expect(salvageStreamedReport("没有标题的长文本".repeat(50))).toBe("");
    expect(salvageStreamedReport("# 短\n太短了")).toBe("");
  });
});
