import { describe, expect, it, vi } from "vitest";
import type { PluginLogger, PluginRuntime } from "../api.js";
import { ReportGenerator } from "./generator.js";
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
