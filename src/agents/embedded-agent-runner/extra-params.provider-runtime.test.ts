import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import { createKilocodeWrapper } from "../../llm/providers/stream-wrappers/proxy.js";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import { captureEnv } from "../../test-utils/env.js";
import type { StreamFn } from "../runtime/index.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import { resolveAgentTransportOverride, resolveExplicitSettingsTransport } from "./extra-params.js";
import { runExtraParamsCase, testing as extraParamsTesting } from "./extra-params.test-support.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

describe("extra-params: provider runtime handoff", () => {
  afterEach(() => extraParamsTesting.resetProviderRuntimeDepsForTest());
  it.each([
    { label: "default", allowlist: undefined, expected: true },
    { label: "disabled tools", allowlist: undefined, webSearchEnabled: false, expected: false },
    { label: "no tools", allowlist: [], expected: false },
    { label: "explicit search", allowlist: ["web_search"], expected: true },
    {
      label: "intersected wildcard",
      allowlist: attachToolAllowlistIntersection(["*", "message"], [["*"], ["message"]]),
      expected: false,
    },
  ])(
    "keeps $label authority on the actual provider payload",
    ({ allowlist: runtimeToolAllowlist, webSearchEnabled, expected }) => {
      const payload: { tools: Array<Record<string, unknown>> } = {
        tools: [{ type: "function", name: "message" }],
      };
      extraParamsTesting.setProviderRuntimeDepsForTest({
        prepareProviderExtraParams: ({ context }) => context.extraParams,
        resolveProviderExtraParamsForTransport: () => undefined,
        wrapProviderStreamFn: ({ context }) => {
          const underlying = context.streamFn;
          if (!underlying || context.nativeWebSearchAllowedByToolPolicy === false) {
            return underlying;
          }
          return (model, streamContext, options) =>
            underlying(model, streamContext, {
              ...options,
              onPayload: (request, requestModel) => {
                (request as typeof payload).tools.push({ type: "web_search" });
                return options?.onPayload?.(request, requestModel);
              },
            });
        },
      });
      const model = {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">;

      runExtraParamsCase({
        agentId: "main",
        model,
        runtimeModel: model,
        payload,
        policyOptions: {
          nativeWebSearchPolicyContext: { runtimeToolAllowlist, webSearchEnabled },
        },
      });

      expect(payload.tools.some((tool) => tool.type === "web_search")).toBe(expected);
    },
  );
});

it("supports cached WebSockets and filters unknown upstream transport values", () => {
  const settingsManager = { getGlobalSettings: () => ({}) };
  const override = (transport: string) =>
    resolveAgentTransportOverride({
      settingsManager,
      effectiveExtraParams: { transport },
    });
  expect(override("websocket-cached")).toBe("websocket-cached");
  expect(override("webtransport")).toBeUndefined();
  expect(
    resolveExplicitSettingsTransport({
      settingsManager: { getGlobalSettings: () => ({ transport: "auto" }) },
      sessionTransport: "websocket-cached",
    }),
  ).toBe("websocket-cached");
});

describe("extra-params: Kilocode wrapper", () => {
  const envSnapshot = captureEnv(["KILOCODE_FEATURE"]);

  afterEach(() => envSnapshot.restore());

  it("cannot be overridden by caller headers", () => {
    delete process.env.KILOCODE_FEATURE;

    let headers: SimpleStreamOptions["headers"];
    const stream = createKilocodeWrapper((_model, _context, options) => {
      headers = options?.headers;
      options?.onPayload?.({}, _model);
      return {} as ReturnType<StreamFn>;
    }, "high");
    void stream(
      {
        api: "openai-completions",
        provider: "kilocode",
        id: "anthropic/claude-sonnet-4",
      } as Model<"openai-completions">,
      { messages: [] },
      { headers: { "X-KILOCODE-FEATURE": "should-be-overwritten" } },
    );

    expect(headers?.["X-KILOCODE-FEATURE"]).toBe("openclaw");
  });
});
