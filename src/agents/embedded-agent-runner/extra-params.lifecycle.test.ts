import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { createOpenRouterSystemCacheWrapper } from "../../llm/providers/stream-wrappers/proxy.js";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  attachModelProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { attachModelProviderRequestRouteFacts } from "../provider-request-config.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent, resolvePreparedExtraParams } from "./extra-params.js";

describe("prepared provider extra-param lifecycle", () => {
  it("keeps shared MiMo request and output policy when a provider decorates the stream", async () => {
    const model = makeProviderModelFixture({
      provider: "fixture-provider",
      id: "mimo-v2-pro",
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      reasoning: true,
    });
    const modelRef = `${model.provider}/${model.id}`;
    const cfg = {
      agents: {
        defaults: {
          params: { globalOnly: true },
          models: { [modelRef]: { params: { policy: "model", modelOnly: true } } },
        },
        entries: {
          worker: {
            params: { policy: "agent" },
            models: { [modelRef]: { params: { policy: "agent-model" } } },
          },
        },
      },
    };
    const plugin: ProviderPlugin = {
      id: model.provider,
      label: "Fixture",
      auth: [],
      wrapStreamFn: ({ streamFn, modelParams, modelCallUrgency }) => {
        expect(modelParams).toEqual({ policy: "agent-model", modelOnly: true });
        expect(modelCallUrgency).toBe("foreground");
        const underlying = expectDefined(streamFn, "prepared provider stream");
        const decorated: StreamFn = (requestModel, context, options) =>
          underlying(requestModel, context, {
            ...options,
            headers: { ...options?.headers, "x-fixture-policy": String(modelParams?.policy) },
          });
        return Object.assign(decorated, { preservesGenericCompatibility: true });
      },
    };
    const preparedModel = attachModelProviderRuntimePluginHandle(model, {
      provider: model.provider,
      modelId: model.id,
      config: cfg,
      plugin,
    });
    const payload: Record<string, unknown> = {
      messages: [{ role: "assistant", content: "Earlier answer" }],
    };
    const baseStreamFn: StreamFn = async (requestModel, _context, options) => {
      expect(options?.headers).toMatchObject({ "x-fixture-policy": "agent-model" });
      await options?.onPayload?.(payload, requestModel);
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: makeAgentAssistantMessage({
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "thinking", thinking: "Visible answer" }],
        }),
      });
      return stream;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      cfg,
      model.provider,
      model.id,
      undefined,
      "high",
      "worker",
      undefined,
      preparedModel,
      undefined,
      undefined,
      { modelCallUrgency: "foreground" },
    );
    const stream = await agent.streamFn(preparedModel, { messages: [] });
    expect(payload).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "assistant", content: "Earlier answer", reasoning_content: "" }],
    });
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "Visible answer" }],
    });
  });

  it("uses each prepared owner for params and stream wrapping with shared config", () => {
    const cfg = { agents: { defaults: { params: { temperature: 0.1 } } } };
    const model = makeProviderModelFixture({
      provider: "fixture-provider",
      id: "fixture-model",
      api: "fixture-api",
      baseUrl: "https://fixture.invalid",
    });
    const observed: Array<SimpleStreamOptions | undefined> = [];
    for (const owner of ["first", "replacement", "updated"]) {
      if (owner === "updated") {
        cfg.agents.defaults.params.temperature = 0.7;
      }
      const plugin: ProviderPlugin = {
        id: model.provider,
        label: "Fixture",
        auth: [],
        prepareExtraParams: ({ extraParams }) => ({ ...extraParams, owner }),
        extraParamsForTransport: ({ extraParams }) => ({
          patch: { preparedBy: extraParams.owner },
        }),
        wrapStreamFn:
          ({ streamFn, extraParams }) =>
          (requestModel, context, options) =>
            streamFn!(requestModel, context, {
              ...options,
              headers: { owner, preparedBy: String(extraParams?.preparedBy) },
            }),
      };
      const providerRuntimeHandle: ProviderRuntimePluginHandle = {
        provider: model.provider,
        modelId: model.id,
        config: cfg,
        plugin,
      };
      const preparedExtraParams = resolvePreparedExtraParams({
        cfg,
        provider: model.provider,
        modelId: model.id,
        providerRuntimeHandle,
      });
      const agent = {
        streamFn: (_model: Model, _context: unknown, options?: SimpleStreamOptions) => {
          observed.push(options);
          return createAssistantMessageEventStream();
        },
      };
      const preparedModel = attachModelProviderRuntimePluginHandle(model, providerRuntimeHandle);
      applyExtraParamsToAgent(
        agent,
        cfg,
        model.provider,
        model.id,
        undefined,
        undefined,
        undefined,
        undefined,
        preparedModel,
        undefined,
        undefined,
        { preparedExtraParams },
      );
      agent.streamFn(model, { messages: [] });
    }
    expect(
      observed.map((options) => ({ temperature: options?.temperature, headers: options?.headers })),
    ).toEqual([
      { temperature: 0.1, headers: { owner: "first", preparedBy: "first" } },
      { temperature: 0.1, headers: { owner: "replacement", preparedBy: "replacement" } },
      { temperature: 0.7, headers: { owner: "updated", preparedBy: "updated" } },
    ]);
  });
});

const providerMetadataOwners: PluginMetadataSnapshotOwnerMaps = {
  channels: new Map(),
  channelConfigs: new Map(),
  providers: new Map(),
  modelCatalogProviders: new Map(),
  cliBackends: new Map(),
  setupProviders: new Map(),
  commandAliases: new Map(),
  contracts: new Map(),
  modelIdNormalizationPolicies: new Map(),
  providerAuthContributions: [],
  providerEndpoints: [],
  providerRequests: new Map([["openrouter", { family: "openrouter" }]]),
};

type StreamPayload = {
  messages: Array<{
    role: string;
    content: unknown;
  }>;
};

function runOpenRouterPayload(
  payload: StreamPayload,
  modelId: string,
  streamOptions: Parameters<StreamFn>[2] = {},
) {
  // The wrapper mutates provider payloads via onPayload; capture the final body
  // directly so assertions match transport-facing JSON.
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const streamFn = createOpenRouterSystemCacheWrapper(baseStreamFn);
  // Payload tests consume prepared route facts without starting plugin discovery.
  const model = attachModelProviderRequestRouteFacts(
    makeProviderModelFixture<"openai-completions">({
      api: "openai-completions",
      provider: "openrouter",
      id: modelId,
      baseUrl: "",
    }),
    providerMetadataOwners,
  );
  void streamFn(model, { messages: [] }, streamOptions);
}

describe("extra-params: OpenRouter Anthropic cache_control", () => {
  it("skips new cache markers when OpenRouter Anthropic cache retention is none", () => {
    // Disabling retention must remove stale thinking-block cache markers too;
    // OpenRouter rejects those markers on reasoning content.
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "internal",
              thinkingSignature: "sig_1",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6", { cacheRetention: "none" });

    expect(expectDefined(payload.messages[0], "payload.messages[0] test invariant").content).toBe(
      "You are a helpful assistant.",
    );
    expect(
      expectDefined(payload.messages[1], "payload.messages[1] test invariant").content,
    ).toEqual([{ type: "thinking", thinking: "internal", thinkingSignature: "sig_1" }]);
  });

  it("does not inject cache_control into thinking blocks", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(
      expectDefined(payload.messages[0], "payload.messages[0] test invariant").content,
    ).toEqual([
      { type: "text", text: "Part 1", cache_control: { type: "ephemeral" } },
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
    ]);
  });
});
