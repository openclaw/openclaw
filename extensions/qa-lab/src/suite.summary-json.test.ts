import { describe, expect, it } from "vitest";
import { buildQaSuiteSummaryJson } from "./suite.js";

describe("buildQaSuiteSummaryJson", () => {
  const baseParams = {
    scenarios: [
      { name: "Scenario A", status: "pass" as const },
      { name: "Scenario B", status: "fail" as const, details: "something broke" },
    ],
    startedAt: new Date("2026-04-11T00:00:00.000Z"),
    finishedAt: new Date("2026-04-11T00:05:00.000Z"),
    providerMode: "mock-openai" as const,
    primaryModel: "openai/gpt-5.4",
    alternateModel: "openai/gpt-5.4-alt",
    fastMode: true,
    concurrency: 2,
  };

  it("records provider/model/mode so parity gates can verify labels", () => {
    const json = buildQaSuiteSummaryJson(baseParams);
    expect(json.run).toMatchObject({
      startedAt: "2026-04-11T00:00:00.000Z",
      finishedAt: "2026-04-11T00:05:00.000Z",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.4",
      primaryProvider: "openai",
      primaryModelName: "gpt-5.4",
      alternateModel: "openai/gpt-5.4-alt",
      alternateProvider: "openai",
      alternateModelName: "gpt-5.4-alt",
      fastMode: true,
      concurrency: 2,
      scenarioIds: null,
    });
  });

  it("includes scenarioIds in run metadata when provided", () => {
    const scenarioIds = ["approval-turn-tool-followthrough", "subagent-handoff", "memory-recall"];
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      scenarioIds,
    });
    expect((json.run as { scenarioIds?: readonly string[] }).scenarioIds).toEqual(scenarioIds);
  });

  it("records an Anthropic baseline lane cleanly for parity runs", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      primaryModel: "anthropic/claude-opus-4-6",
      alternateModel: "anthropic/claude-sonnet-4-6",
    });
    expect(json.run).toMatchObject({
      primaryModel: "anthropic/claude-opus-4-6",
      primaryProvider: "anthropic",
      primaryModelName: "claude-opus-4-6",
      alternateModel: "anthropic/claude-sonnet-4-6",
      alternateProvider: "anthropic",
      alternateModelName: "claude-sonnet-4-6",
    });
  });

  it("leaves split fields null when a model ref is malformed", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      primaryModel: "not-a-real-ref",
      alternateModel: "",
    });
    expect(json.run).toMatchObject({
      primaryModel: "not-a-real-ref",
      primaryProvider: null,
      primaryModelName: null,
      alternateModel: "",
      alternateProvider: null,
      alternateModelName: null,
    });
  });

  it("keeps scenarios and counts alongside the run metadata", () => {
    const json = buildQaSuiteSummaryJson(baseParams);
    expect(json.scenarios).toHaveLength(2);
    expect(json.counts).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
    });
  });
});
