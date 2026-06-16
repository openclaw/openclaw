// Coverage for provider-runtime extra parameter handoff and transport filtering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { Model } from "../../llm/types.js";
import {
  testing as extraParamsTesting,
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
} from "./extra-params.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: ({ provider, context }) => {
      if (provider === "openai" && context.extraParams?.nativeWebSearch !== undefined) {
        const baseStreamFn = context.streamFn;
        return baseStreamFn
          ? (model, streamContext, options) => baseStreamFn(model, streamContext, options)
          : undefined;
      }
      if (provider !== "local-provider" || context.thinkingLevel !== "off") {
        return context.streamFn;
      }
      // Local-provider plugin owns the exact payload spelling for thinking-off;
      // core only hands the intent through this wrapper seam.
      const baseStreamFn = context.streamFn;
      if (!baseStreamFn) {
        return undefined;
      }
      return (model, streamContext, options) =>
        baseStreamFn(model, streamContext, {
          ...options,
          onPayload: (payload, payloadModel) => {
            if (payload && typeof payload === "object") {
              (payload as Record<string, unknown>).think = false;
            }
            return options?.onPayload?.(payload, payloadModel);
          },
        });
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("extra-params: provider runtime handoff", () => {
  it("keeps unsupported upstream transport values out of OpenClaw runtime hooks", () => {
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
    ).toBeUndefined();
    expect(
      resolveExplicitSettingsTransport({
        settingsManager: {
          getGlobalSettings: () => ({ transport: "auto" }),
          getProjectSettings: () => ({}),
        },
        sessionTransport: "websocket-cached",
      }),
    ).toBeUndefined();
  });

  it("passes thinking-off intent through the provider runtime wrapper seam", () => {
    const payload = runExtraParamsCase({
      applyProvider: "local-provider",
      applyModelId: "local-model:9b",
      model: {
        api: "openai-completions",
        provider: "local-provider",
        id: "local-model:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "off",
      payload: {
        model: "local-model:9b",
        messages: [],
        stream: true,
        options: {
          num_ctx: 65536,
        },
      },
    }).payload as Record<string, unknown>;

    // think must be top-level, not nested under options; provider runtimes own
    // this wire-format distinction.
    expect(payload.think).toBe(false);
    expect((payload.options as Record<string, unknown>).think).toBeUndefined();
  });

  it("does not apply the plugin wrapper for other providers", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "off",
      payload: {
        model: "gpt-5.4",
        messages: [],
      },
    }).payload as Record<string, unknown>;

    expect(payload.think).toBeUndefined();
  });

  it("does not apply the plugin wrapper when thinkingLevel is not off", () => {
    const payload = runExtraParamsCase({
      applyProvider: "local-provider",
      applyModelId: "local-model:9b",
      model: {
        api: "openai-completions",
        provider: "local-provider",
        id: "local-model:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "high",
      payload: {
        model: "local-model:9b",
        messages: [],
        stream: true,
        options: {
          num_ctx: 65536,
        },
      },
    }).payload as Record<string, unknown>;

    expect(payload.think).toBeUndefined();
  });

  it("rejects request-scoped native web search for unsupported model transports", () => {
    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: undefined },
        undefined,
        "anthropic",
        "claude-sonnet-4.6",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "anthropic",
          provider: "anthropic",
          id: "claude-sonnet-4.6",
        } as never,
      ),
    ).toThrow(/web_search_options require native OpenAI\/Codex web_search/);
  });

  it("allows request-scoped native web search on direct OpenAI Responses models", () => {
    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: vi.fn() as never },
        undefined,
        "openai",
        "gpt-5.4",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as never,
      ),
    ).not.toThrow();
  });

  it("allows request-scoped native web search on OpenAI ChatGPT Responses models", () => {
    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: vi.fn() as never },
        undefined,
        "openai",
        "gpt-5.4",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "openai-chatgpt-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      ),
    ).not.toThrow();
  });

  it("rejects request-scoped native web search on unowned ChatGPT Responses models", () => {
    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: vi.fn() as never },
        undefined,
        "gateway",
        "gpt-5.4",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "openai-chatgpt-responses",
          provider: "gateway",
          id: "gpt-5.4",
        } as never,
      ),
    ).toThrow(/web_search_options require native OpenAI\/Codex web_search/);
  });

  it("allows request-scoped native web search on API-compatible providers with a wrapper", () => {
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: ({ context }) => context.extraParams,
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: ({ context }) => {
        const baseStreamFn = context.streamFn;
        return baseStreamFn
          ? (model, streamContext, options) => baseStreamFn(model, streamContext, options)
          : undefined;
      },
    });

    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: vi.fn() as never },
        undefined,
        "gateway",
        "gpt-5.4",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "openai-chatgpt-responses",
          provider: "gateway",
          id: "gpt-5.4",
        } as never,
      ),
    ).not.toThrow();
  });

  it("allows request-scoped native web search on OpenAI Responses HTTP base URLs", () => {
    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: vi.fn() as never },
        undefined,
        "openai",
        "gpt-5.4",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "http://api.openai.com/v1",
        } as never,
      ),
    ).not.toThrow();
  });

  it("rejects request-scoped native web search when global web search is disabled", () => {
    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: undefined },
        {
          tools: { web: { search: { enabled: false } } },
        } as never,
        "openai",
        "gpt-5.4",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as never,
      ),
    ).toThrow(/web_search_options require native OpenAI\/Codex web_search/);
  });

  it("rejects request-scoped native web search when OpenAI native search provider is disabled", () => {
    expect(() =>
      applyExtraParamsToAgent(
        { streamFn: undefined },
        {
          tools: { web: { search: { provider: "brave" } } },
        } as never,
        "openai",
        "gpt-5.4",
        { nativeWebSearch: {} },
        undefined,
        undefined,
        undefined,
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as never,
      ),
    ).toThrow(/web_search_options require native OpenAI\/Codex web_search/);
  });

  it("passes request-scoped native web search to provider runtime wrappers", () => {
    const wrapProviderStreamFn = vi.fn();
    let wrapperExtraParams: Record<string, unknown> | undefined;
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: ({ context }) => context.extraParams,
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: ({ context }) => {
        wrapperExtraParams = context.extraParams;
        wrapProviderStreamFn();
        const baseStreamFn = context.streamFn;
        return baseStreamFn
          ? (model, streamContext, options) => baseStreamFn(model, streamContext, options)
          : undefined;
      },
    });

    applyExtraParamsToAgent(
      { streamFn: vi.fn() as never },
      undefined,
      "openai",
      "gpt-5.4",
      {
        temperature: 0.4,
        nativeWebSearch: {
          searchContextSize: "high",
          userLocation: { type: "approximate", country: "US" },
        },
      },
      undefined,
      undefined,
      undefined,
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as never,
    );

    expect(wrapProviderStreamFn).toHaveBeenCalledOnce();
    expect(wrapperExtraParams).toMatchObject({
      temperature: 0.4,
      nativeWebSearch: {
        searchContextSize: "high",
        userLocation: { type: "approximate", country: "US" },
      },
    });
  });
});
