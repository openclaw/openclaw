// Coverage for provider-runtime extra parameter handoff and transport filtering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import { createKilocodeWrapper } from "../../llm/providers/stream-wrappers/proxy.js";
import type { Context, Model, SimpleStreamOptions } from "../../llm/types.js";
import { captureEnv } from "../../test-utils/env.js";
import type { StreamFn } from "../runtime/index.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
} from "./extra-params.js";
import { testing as extraParamsTesting } from "./extra-params.test-support.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: ({ context }) => context.streamFn,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("extra-params: provider runtime handoff", () => {
  it.each([
    { label: "default", runtimeToolAllowlist: undefined, expectedHostedSearch: true },
    {
      label: "disabled tools",
      runtimeToolAllowlist: undefined,
      webSearchEnabled: false,
      expectedHostedSearch: false,
    },
    { label: "no tools", runtimeToolAllowlist: [], expectedHostedSearch: false },
    { label: "explicit search", runtimeToolAllowlist: ["web_search"], expectedHostedSearch: true },
    {
      label: "intersected wildcard",
      runtimeToolAllowlist: attachToolAllowlistIntersection(["*", "message"], [["*"], ["message"]]),
      expectedHostedSearch: false,
    },
  ])(
    "keeps $label authority on the actual provider payload",
    ({ runtimeToolAllowlist, webSearchEnabled, expectedHostedSearch }) => {
      const payload: { tools: Array<Record<string, unknown>> } = {
        tools: [{ type: "function", name: "message" }],
      };
      const baseStreamFn: StreamFn = (model, _context, options) => {
        options?.onPayload?.(payload, model);
        return {} as ReturnType<StreamFn>;
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
      const agent = { streamFn: baseStreamFn };
      const model = {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">;

      applyExtraParamsToAgent(
        agent,
        undefined,
        "openai",
        "gpt-5.4",
        undefined,
        undefined,
        "main",
        undefined,
        model,
        undefined,
        undefined,
        { nativeWebSearchPolicyContext: { runtimeToolAllowlist, webSearchEnabled } },
      );
      void agent.streamFn?.(model, { messages: [] }, {});

      expect(payload.tools.some((tool) => tool.type === "web_search")).toBe(expectedHostedSearch);
    },
  );

  it("supports cached WebSockets and filters unknown upstream transport values", () => {
    // Upstream transports can name modes OpenClaw does not own; unresolved values
    // must be filtered before plugin runtime hooks receive them.
    const settingsManager = {
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    };

    expect(
      resolveAgentTransportOverride({
        settingsManager,
        effectiveExtraParams: { transport: "websocket-cached" },
      }),
    ).toBe("websocket-cached");
    expect(
      resolveAgentTransportOverride({
        settingsManager,
        effectiveExtraParams: { transport: "webtransport" },
      }),
    ).toBeUndefined();
    expect(
      resolveExplicitSettingsTransport({
        settingsManager: {
          getGlobalSettings: () => ({ transport: "auto" }),
          getProjectSettings: () => ({}),
        },
        sessionTransport: "websocket-cached",
      }),
    ).toBe("websocket-cached");
  });
});

type ExtraParamsCapture<TPayload extends Record<string, unknown>> = {
  headers?: Record<string, string>;
  payload: TPayload;
};

function applyAndCapture(params: {
  provider: string;
  modelId: string;
  callerHeaders?: Record<string, string>;
}) {
  // Capture headers after wrapper composition so caller-provided headers and
  // environment defaults can be compared against the final transport options.
  const captured: ExtraParamsCapture<Record<string, unknown>> = { payload: {} };
  const baseStreamFn: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    options?.onPayload?.(captured.payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const streamFn =
    params.provider === "kilocode"
      ? createKilocodeWrapper(
          baseStreamFn,
          params.modelId === "kilo-auto/balanced" ? undefined : "high",
        )
      : baseStreamFn;

  const context: Context = { messages: [] };
  void streamFn(
    {
      api: "openai-completions",
      provider: params.provider,
      id: params.modelId,
    } as Model<"openai-completions">,
    context,
    {
      headers: params.callerHeaders,
    } as SimpleStreamOptions,
  );

  return captured;
}

describe("extra-params: Kilocode wrapper", () => {
  const envSnapshot = captureEnv(["KILOCODE_FEATURE"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("cannot be overridden by caller headers", () => {
    delete process.env.KILOCODE_FEATURE;

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
      callerHeaders: { "X-KILOCODE-FEATURE": "should-be-overwritten" },
    });

    expect(headers?.["X-KILOCODE-FEATURE"]).toBe("openclaw");
  });
});
