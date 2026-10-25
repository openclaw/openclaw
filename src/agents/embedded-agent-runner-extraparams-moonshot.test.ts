import { expectDefined } from "@openclaw/normalization-core";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runExtraParamsPayloadCase } from "./embedded-agent-runner-extraparams.test-support.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";

const readCall = {
  role: "assistant",
  tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
};
const pinned = { type: "tool", name: "read" };
const keepAll = { thinking: { type: "enabled", keep: "all" } };
const disabled = { type: "disabled" };
const sampling = { temperature: 0, top_p: 0.5, n: 2, presence_penalty: 1, frequency_penalty: 1 };
type PayloadCase = Parameters<typeof runExtraParamsPayloadCase>[0];
function run(
  modelId: string,
  payload: PayloadCase["payload"] = {},
  params?: Record<string, unknown>,
  thinkingLevel: PayloadCase["thinkingLevel"] = "low",
) {
  return runExtraParamsPayloadCase({
    provider: "moonshot",
    modelId,
    thinkingLevel,
    payload,
    ...(params
      ? { cfg: { agents: { defaults: { models: { [`moonshot/${modelId}`]: { params } } } } } }
      : {}),
  });
}
function messages(payload: ReturnType<typeof run>) {
  return payload.messages as Array<Record<string, unknown>>;
}
function expectFixedReasoning(payload: ReturnType<typeof run>) {
  for (const key of ["thinking", ...Object.keys(sampling)]) {
    expect(payload).not.toHaveProperty(key);
  }
  expect(expectDefined(messages(payload)[0], "assistant tool call").reasoning_content).toBe("");
}

beforeEach(() => {
  // Exercise the provider wrapper through the generic extra-params runtime seam.
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) =>
      params.provider === "moonshot"
        ? buildProviderStreamFamilyHooks("moonshot-thinking").wrapStreamFn?.(params.context)
        : params.context.streamFn,
  });
});
afterEach(() => extraParamsTesting.resetProviderRuntimeDepsForTest());

it.each<
  [
    string,
    string,
    PayloadCase["payload"],
    Record<string, unknown> | undefined,
    Record<string, unknown>,
    PayloadCase["thinkingLevel"]?,
  ]
>([
  [
    "required tool choice",
    "kimi-k2.5",
    { tool_choice: "required" },
    undefined,
    { thinking: { type: "enabled" }, tool_choice: "auto" },
  ],
  [
    "pinned tool choice",
    "kimi-k2.5",
    { tool_choice: pinned },
    undefined,
    { thinking: disabled, tool_choice: pinned },
  ],
  ["configured thinking", "kimi-k2.5", {}, { thinking: disabled }, { thinking: disabled }, "high"],
  ["k2.6 keep", "kimi-k2.6", { model: "kimi-k2.6" }, keepAll, keepAll],
  [
    "non-k2.6 keep",
    "kimi-k2.5",
    { model: "kimi-k2.5" },
    keepAll,
    { thinking: { type: "enabled" } },
  ],
  [
    "pinned choice drops keep",
    "kimi-k2.6",
    { model: "kimi-k2.6", tool_choice: pinned },
    keepAll,
    { thinking: disabled },
  ],
])("Moonshot %s", (_name, model, input, params, expected, level) => {
  const payload = run(model, input, params, level);
  expect(payload.thinking).toEqual(expected.thinking);
  if ("tool_choice" in expected) {
    expect(payload.tool_choice).toEqual(expected.tool_choice);
  }
});

it.each([
  ["kimi-k2.7-code", pinned, undefined],
  ["kimi-k2.7-code-highspeed", pinned, undefined],
  ["kimi-k3", { type: "function", function: { name: "read" } }, "max"],
] as const)("enforces fixed reasoning and sampling for %s", (modelId, toolChoice, effort) => {
  const payload = run(
    modelId,
    { model: modelId, messages: [structuredClone(readCall)] },
    {
      thinking: { ...disabled, keep: "all" },
      extra_body: {
        thinking: { ...disabled, keep: "all" },
        ...(effort ? { reasoningEffort: "low" } : {}),
        reasoning_effort: "low",
        tool_choice: toolChoice,
        ...sampling,
      },
    },
    "off",
  );
  expectFixedReasoning(payload);
  if (effort) {
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload.reasoning_effort).toBe(effort);
    expect(payload.tool_choice).toEqual(toolChoice);
  } else {
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload.tool_choice).toBe("auto");
  }
});

it("repairs only missing assistant tool-call reasoning_content when thinking is enabled", () => {
  const payload = run("kimi-k2.6", {
    model: "kimi-k2.6",
    messages: [
      { role: "user", content: "hello" },
      structuredClone(readCall),
      {
        role: "assistant",
        reasoning_content: "native reasoning",
        tool_calls: [
          { id: "call_2", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "assistant", content: "done" },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ],
  });
  expect(payload.thinking).toEqual({ type: "enabled" });
  const result = messages(payload);
  expect(expectDefined(result[1], "missing reasoning").reasoning_content).toBe("");
  expect(expectDefined(result[2], "native reasoning").reasoning_content).toBe("native reasoning");
  expect(result[3]).not.toHaveProperty("reasoning_content");
});

it("does not backfill reasoning_content when thinking is disabled", () => {
  const payload = run("kimi-k2.5", { messages: [structuredClone(readCall)] }, undefined, "off");
  expect(payload.thinking).toEqual(disabled);
  expect(
    expectDefined(messages(payload)[0], "assistant tool call").reasoning_content,
  ).toBeUndefined();
});
