import { expectDefined } from "@openclaw/normalization-core";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runExtraParamsPayloadCase } from "./embedded-agent-runner-extraparams.test-support.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";

const readCall = () => ({
  role: "assistant",
  tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
});
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
    payload,
    thinkingLevel,
    cfg: params
      ? { agents: { defaults: { models: { [`moonshot/${modelId}`]: { params } } } } }
      : undefined,
  });
}
const messages = (payload: ReturnType<typeof run>) =>
  payload.messages as Array<Record<string, unknown>>;

beforeEach(() => {
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

it("keeps configured thinking authoritative over the agent thinking level", () => {
  const payload = run("kimi-k2.5", {}, { thinking: { type: "disabled" } }, "high");
  expect(payload.thinking).toEqual({ type: "disabled" });
});

it("repairs replay history after fixed-reasoning payload normalization", () => {
  const sampling = { temperature: 0, top_p: 0.5, n: 2, presence_penalty: 1, frequency_penalty: 1 };
  const thinking = { type: "disabled", keep: "all" };
  const payload = run(
    "kimi-k2.7-code",
    { messages: [readCall()] },
    {
      thinking,
      extra_body: {
        thinking,
        reasoningEffort: "low",
        reasoning_effort: "low",
        tool_choice: { type: "tool", name: "read" },
        ...sampling,
      },
    },
    "off",
  );
  for (const key of ["thinking", "reasoningEffort", "reasoning_effort", ...Object.keys(sampling)]) {
    expect(payload).not.toHaveProperty(key);
  }
  expect(payload.tool_choice).toBe("auto");
  expect(expectDefined(messages(payload)[0], "assistant tool call").reasoning_content).toBe("");
});

it.each(["low", "off"] as const)(
  "normalizes required tool choice and repairs only missing assistant reasoning when thinking=%s",
  (level) => {
    const payload = run(
      "kimi-k2.6",
      {
        model: "kimi-k2.6",
        tool_choice: "required",
        messages: [
          { role: "user", content: "hello" },
          readCall(),
          { ...readCall(), reasoning_content: "native reasoning" },
          { role: "assistant", content: "done" },
          { role: "tool", tool_call_id: "call_1", content: "file contents" },
        ],
      },
      undefined,
      level,
    );
    const enabled = level === "low";
    expect(payload.thinking).toEqual({ type: enabled ? "enabled" : "disabled" });
    expect(payload.tool_choice).toBe(enabled ? "auto" : "required");
    const result = messages(payload);
    expect(expectDefined(result[1], "missing reasoning").reasoning_content).toBe(
      enabled ? "" : undefined,
    );
    expect(expectDefined(result[2], "native reasoning").reasoning_content).toBe("native reasoning");
    expect(result[3]).not.toHaveProperty("reasoning_content");
  },
);
