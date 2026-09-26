// Covers OpenAI safety_identifier injection through the extra-params stream wrapper seam.

import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenAISafetyIdentifierWrapper,
  resolveOpenAISafetyIdentifier,
} from "../llm/providers/stream-wrappers/openai-safety-identifier.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";

beforeEach(() => {
  // The safety-identifier wrapper lives in the OpenAI provider's stream family,
  // wired through the generic extra-params provider-runtime seam here. The
  // wrapper gates on the model route itself, so it is attached for every
  // provider and the non-native cases below exercise that gate directly.
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => {
      const safetyIdentifier = resolveOpenAISafetyIdentifier(params.context.extraParams);
      return safetyIdentifier
        ? createOpenAISafetyIdentifierWrapper(params.context.streamFn, safetyIdentifier)
        : params.context.streamFn;
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent OpenAI safety identifier", () => {
  function buildModelConfig(modelKey: string, params: Record<string, unknown>) {
    return {
      agents: {
        defaults: {
          models: {
            [modelKey]: { params },
          },
        },
      },
    };
  }

  function runResponsesPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-responses">
      | Model<"azure-openai-responses">
      | Model<"openai-chatgpt-responses">
      | Model<"openai-completions">;
    cfg?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    // Mutates a caller-owned payload through onPayload, matching how the runtime
    // finalizes provider request bodies.
    const payload = params.payload ?? { store: false };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
    return payload;
  }

  it.each([
    {
      name: "injects configured OpenAI safety_identifier into Responses payloads",
      params: { safetyIdentifier: "clipo-a1b2c3" },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: undefined,
      expected: "clipo-a1b2c3",
    },
    {
      name: "trims whitespace around the configured safetyIdentifier",
      params: { safetyIdentifier: "  clipo-a1b2c3  " },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: undefined,
      expected: "clipo-a1b2c3",
    },
    {
      name: "injects configured OpenAI safety_identifier into native Chat Completions payloads",
      params: { safetyIdentifier: "clipo-a1b2c3" },
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-completions">,
      payload: undefined,
      expected: "clipo-a1b2c3",
    },
    {
      name: "preserves caller-provided safety_identifier values",
      params: { safetyIdentifier: "clipo-a1b2c3" },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { store: false, safety_identifier: "caller-owned" },
      expected: "caller-owned",
    },
  ])("$name", ({ params, model, payload: initialPayload, expected }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: buildModelConfig("openai/gpt-5.4", params),
      model,
      payload: initialPayload,
    });

    expect(payload.safety_identifier).toBe(expected);
  });

  it.each([
    {
      name: "does not inject safety_identifier for the ChatGPT/Codex backend",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      safetyIdentifier: "clipo-a1b2c3",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-chatgpt-responses">,
    },
    {
      name: "does not inject safety_identifier for non-openai providers",
      applyProvider: "azure-openai-responses",
      configKey: "azure-openai-responses/gpt-5.4",
      safetyIdentifier: "clipo-a1b2c3",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
    },
    {
      name: "does not inject safety_identifier for proxied openai base URLs",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      safetyIdentifier: "clipo-a1b2c3",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "skips safety_identifier injection for empty values",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      safetyIdentifier: "   ",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "does not accept a snake_case safety_identifier alias (single canonical spelling)",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      safetyIdentifier: undefined,
      extraParams: { safety_identifier: "clipo-a1b2c3" },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "skips safety_identifier injection for values over OpenAI's 64-character limit",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      safetyIdentifier: "x".repeat(65),
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "skips safety_identifier injection for non-string values",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      safetyIdentifier: 42,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
  ])("$name", ({ applyProvider, configKey, safetyIdentifier, extraParams, model }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider,
      applyModelId: "gpt-5.4",
      cfg: buildModelConfig(configKey, extraParams ?? { safetyIdentifier }),
      model,
    });

    expect(payload).not.toHaveProperty("safety_identifier");
  });
});
