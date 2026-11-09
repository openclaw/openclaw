import { describe, expect, it } from "vitest";
import {
  resolveOpenAIResponsesRequestContextTokens,
  resolveOpenAIResponsesServerCompactionPlan as compactionPlan,
} from "./openai-responses-payload-policy.js";

const nativeModel = {
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
const plan = (model: Record<string, unknown> = {}, params?: Record<string, unknown>) =>
  compactionPlan({ ...nativeModel, ...model }, params);

describe("OpenAI Responses request context", () => {
  it.each([
    { fastMode: undefined, expected: 260_000 },
    { fastMode: () => undefined, expected: 260_000 },
    { fastMode: "auto", expected: 260_000 },
    { fastMode: false, expected: undefined },
    { fastMode: true, expected: undefined },
    { fastMode: "ultrafast", expected: undefined },
  ])(
    "preserves authored tiers but restricts explicit speed: $fastMode",
    ({ fastMode, expected }) => {
      expect(
        resolveOpenAIResponsesRequestContextTokens(
          { provider: "openai", api: "openai-responses" },
          { serviceTier: "ultrafast", fastMode },
          ["default", "priority"],
        ),
      ).toBe(expected);
    },
  );
});

describe("OpenAI Responses compact threshold", () => {
  it.each([
    { params: { fastMode: "ultrafast" }, threshold: 260_000 },
    { params: { fast_mode: "ultrafast" }, threshold: 260_000 },
    { params: { fastMode: () => "ultrafast" }, threshold: 260_000 },
    { params: { serviceTier: "ultrafast", fastMode: false }, threshold: 700_000 },
    { params: { service_tier: "ultrafast" }, threshold: 260_000 },
    { params: { fastMode: true }, threshold: 700_000 },
    { params: { fastMode: false }, threshold: 700_000 },
    { params: { fastMode: "auto" }, threshold: 700_000 },
    { params: { fastMode: "ultrafast", serviceTier: "priority" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", serviceTier: "default" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", serviceTier: "flex" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", serviceTier: "auto" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", responsesCompactThreshold: 120_000 }, threshold: 120_000 },
  ])("resolves tier/config precedence for $params", ({ params, threshold }) => {
    const model = { contextWindow: 1_050_000, contextTokens: 922_000 };
    expect(plan(model, { responsesCompactThreshold: 700_000, ...params }).threshold).toBe(
      threshold,
    );
  });

  it("keeps disabled compaction disabled under Ultrafast", () => {
    expect(
      plan(
        {},
        {
          fastMode: "ultrafast",
          responsesServerCompaction: false,
        },
      ),
    ).toEqual({ enabled: false, threshold: undefined });
  });

  it.each([
    [
      "active runtime cap",
      { contextWindow: 1_050_000, contextTokens: 272_000 },
      undefined,
      190_400,
    ],
    ["window-only", { contextWindow: 400_000 }, undefined, 280_000],
    ["explicit threshold", { contextWindow: 1_050_000, contextTokens: 272_000 }, 123_456, 123_456],
    ["unknown budget", {}, undefined, 80_000],
    ["floor numeric threshold", {}, 123_456.9, 123_456],
    ["integer string", {}, "123456", 123_456],
    ["fractional string", {}, "123456.9", 80_000],
    ["nonfinite threshold", {}, Number.POSITIVE_INFINITY, 80_000],
  ] as const)("resolves %s", (_name, model, responsesCompactThreshold, expected) => {
    expect(
      plan(
        model,
        responsesCompactThreshold === undefined ? undefined : { responsesCompactThreshold },
      ).threshold,
    ).toBe(expected);
  });
});
