import { describe, expect, it } from "vitest";
import { resolveOpenAIResponsesServerCompactionPlan } from "./openai-responses-payload-policy.js";

describe("OpenAI Responses compact threshold", () => {
  it.each([
    { params: { fastMode: "ultrafast" }, threshold: 260_000 },
    { params: { fast_mode: "ultrafast" }, threshold: 260_000 },
    { params: { fastMode: () => "ultrafast" }, threshold: 260_000 },
    { params: { serviceTier: "ultrafast", fastMode: false }, threshold: 260_000 },
    { params: { service_tier: "ultrafast" }, threshold: 260_000 },
    { params: { fastMode: true }, threshold: 700_000 },
    { params: { fastMode: false }, threshold: 700_000 },
    { params: { fastMode: "auto" }, threshold: 700_000 },
    { params: { fastMode: "ultrafast", serviceTier: "priority" }, threshold: 700_000 },
    { params: { fastMode: "ultrafast", serviceTier: "default" }, threshold: 700_000 },
    { params: { fastMode: "ultrafast", serviceTier: "flex" }, threshold: 700_000 },
    { params: { fastMode: "ultrafast", serviceTier: "auto" }, threshold: 700_000 },
    { params: { fastMode: "ultrafast", responsesCompactThreshold: 120_000 }, threshold: 120_000 },
  ])("resolves tier/config precedence for $params", ({ params, threshold }) => {
    expect(
      resolveOpenAIResponsesServerCompactionPlan(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 1_050_000,
          contextTokens: 922_000,
        },
        { responsesCompactThreshold: 700_000, ...params },
      ).threshold,
    ).toBe(threshold);
  });

  it("keeps disabled compaction disabled under Ultrafast", () => {
    expect(
      resolveOpenAIResponsesServerCompactionPlan(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
        { fastMode: "ultrafast", responsesServerCompaction: false },
      ),
    ).toEqual({ enabled: false, threshold: undefined });
  });

  it.each([
    {
      name: "uses the active runtime cap for the direct Sol route",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      expected: 190_400,
    },
    {
      name: "keeps window-only behavior",
      model: { contextWindow: 400_000 },
      expected: 280_000,
    },
    {
      name: "honors an explicit threshold",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      extraParams: { responsesCompactThreshold: 123_456 },
      expected: 123_456,
    },
    {
      name: "uses the fallback without a known budget",
      model: {},
      expected: 80_000,
    },
    {
      name: "floors a positive numeric threshold",
      model: {},
      extraParams: { responsesCompactThreshold: 123_456.9 },
      expected: 123_456,
    },
    {
      name: "accepts a strict positive integer string threshold",
      model: {},
      extraParams: { responsesCompactThreshold: "123456" },
      expected: 123_456,
    },
    {
      name: "rejects a fractional string threshold",
      model: {},
      extraParams: { responsesCompactThreshold: "123456.9" },
      expected: 80_000,
    },
    {
      name: "rejects a nonfinite threshold",
      model: {},
      extraParams: { responsesCompactThreshold: Number.POSITIVE_INFINITY },
      expected: 80_000,
    },
  ])("$name", ({ model, extraParams, expected }) => {
    expect(
      resolveOpenAIResponsesServerCompactionPlan(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...model,
        },
        extraParams,
      ).threshold,
    ).toBe(expected);
  });
});
