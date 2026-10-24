import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { expect, it, vi } from "vitest";
import { createOpenRouterSystemCacheWrapper } from "../../llm/providers/stream-wrappers/proxy.js";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { makeEmptyPluginMetadataOwners } from "../../plugins/current-plugin-metadata.test-support.js";
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

const modelDefaults = {
  provider: "fixture-provider",
  api: "fixture-api",
  baseUrl: "https://fixture.invalid/v1",
};
const pluginDefaults = { id: modelDefaults.provider, label: "Fixture", auth: [] };

function prepareAgent(
  streamFn: StreamFn,
  handle: ProviderRuntimePluginHandle,
  model: Model,
  thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5],
  agentId?: string,
  options?: Parameters<typeof applyExtraParamsToAgent>[11],
) {
  const agent = { streamFn };
  const preparedModel = attachModelProviderRuntimePluginHandle(model, handle);
  applyExtraParamsToAgent(
    agent,
    handle.config,
    model.provider,
    model.id,
    undefined,
    thinkingLevel,
    agentId,
    undefined,
    preparedModel,
    undefined,
    undefined,
    options,
  );
  return { agent, preparedModel };
}

it("keeps shared MiMo request and output policy when a provider decorates the stream", async () => {
  const model = makeProviderModelFixture({
    ...modelDefaults,
    id: "mimo-v2-pro",
    api: "openai-completions",
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
    ...pluginDefaults,
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
  const payload = { messages: [{ role: "assistant", content: "Earlier answer" }] };
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
  const { agent, preparedModel } = prepareAgent(
    baseStreamFn,
    { provider: model.provider, modelId: model.id, config: cfg, plugin },
    model,
    "high",
    "worker",
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

it("uses each prepared owner for params and stream wrapping with shared config", async () => {
  const cfg = { agents: { defaults: { params: { temperature: 0.1 } } } };
  const model = makeProviderModelFixture({ ...modelDefaults, id: "fixture-model" });
  const base = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
  for (const owner of ["first", "replacement", "updated"]) {
    if (owner === "updated") {
      cfg.agents.defaults.params.temperature = 0.7;
    }
    const providerRuntimeHandle: ProviderRuntimePluginHandle = {
      provider: model.provider,
      modelId: model.id,
      config: cfg,
      plugin: {
        ...pluginDefaults,
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
      },
    };
    const preparedExtraParams = resolvePreparedExtraParams({
      cfg,
      provider: model.provider,
      modelId: model.id,
      providerRuntimeHandle,
    });
    const { agent } = prepareAgent(base, providerRuntimeHandle, model, undefined, undefined, {
      preparedExtraParams,
    });
    await agent.streamFn(model, { messages: [] });
  }
  expect(base).toHaveBeenCalledTimes(3);
  expect(base.mock.calls.map((args) => [args[2]?.temperature, args[2]?.headers])).toEqual([
    [0.1, { owner: "first", preparedBy: "first" }],
    [0.1, { owner: "replacement", preparedBy: "replacement" }],
    [0.7, { owner: "updated", preparedBy: "updated" }],
  ]);
});

const providerMetadataOwners: PluginMetadataSnapshotOwnerMaps = {
  ...makeEmptyPluginMetadataOwners(),
  providerEndpoints: [],
  providerRequests: new Map([["openrouter", { family: "openrouter" }]]),
};

type StreamPayload = { messages: Array<{ role: string; content: unknown }> };

const thinking = { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" };
const cache_control = { type: "ephemeral" };
const text = { type: "text", text: "Part 1" };
const system = { role: "system", content: "You are a helpful assistant." };
it.each<[SimpleStreamOptions, StreamPayload["messages"], StreamPayload["messages"]]>([
  [
    { cacheRetention: "none" },
    [{ ...system }, { role: "assistant", content: [{ ...thinking, cache_control }] }],
    [system, { role: "assistant", content: [thinking] }],
  ],
  [
    {},
    [{ role: "system", content: [{ ...text }, { ...thinking }] }],
    [{ role: "system", content: [{ ...text, cache_control }, thinking] }],
  ],
])("OpenRouter preserves thinking blocks with cache options %j", (options, messages, expected) => {
  const payload = { messages };
  const baseStreamFn: StreamFn = (model, _context, streamOptions) => {
    streamOptions?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const streamFn = createOpenRouterSystemCacheWrapper(baseStreamFn);
  const model = attachModelProviderRequestRouteFacts(
    makeProviderModelFixture<"openai-completions">({
      api: "openai-completions",
      provider: "openrouter",
      id: "anthropic/claude-opus-4-6",
      baseUrl: "",
    }),
    providerMetadataOwners,
  );
  void streamFn(model, { messages: [] }, options);
  expect(payload.messages).toEqual(expected);
});
