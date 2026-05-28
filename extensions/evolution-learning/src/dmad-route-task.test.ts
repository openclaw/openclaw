import { describe, expect, it } from "vitest";
import { routeTask } from "./dmad-debate.js";

describe("routeTask MasRouter v2", () => {
  it("routes technical tasks with high confidence when technical keywords dominate", () => {
    expect(routeTask("修 fix API schema migration bug，補 test 與 type interface")).toMatchObject({
      domain: "technical",
      confidence: "high",
    });
  });

  it("routes language and strategy tasks with high confidence when language keywords dominate", () => {
    expect(routeTask("分析策略與規劃，說明 why/how 並產出 review 報告")).toMatchObject({
      domain: "language",
      confidence: "high",
    });
  });

  it("keeps mixed tasks low confidence instead of forcing a single-agent route", () => {
    expect(routeTask("分析 API 架構與策略")).toMatchObject({
      domain: "mixed",
      confidence: "low",
    });
  });

  it("marks tasks without route keywords as unknown", () => {
    expect(routeTask("整理這段內容")).toMatchObject({
      domain: "unknown",
      confidence: "low",
    });
  });
});
