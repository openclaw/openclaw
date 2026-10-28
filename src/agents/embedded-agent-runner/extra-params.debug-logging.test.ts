import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { attachModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { StreamFn } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import * as retention from "./prompt-cache-retention.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("skips diagnostic work for 1000 disabled-debug wrappers while resolving every stream", async () => {
  const responseFormat = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`field_${index}`, { type: "string" }]),
    ),
  };
  const originalSchema = JSON.stringify(responseFormat);
  const cfg = {};
  const model = attachModelProviderRuntimePluginHandle(
    makeProviderModelFixture({
      provider: "fixture-provider",
      id: "fixture-model",
      api: "anthropic-messages",
      baseUrl: "https://fixture.invalid",
    }),
    {
      provider: "fixture-provider",
      modelId: "fixture-model",
      config: cfg,
      plugin: { id: "fixture-provider", label: "Fixture", auth: [] },
    },
  );
  const base = vi.fn<StreamFn>(({ api, provider, id }) => {
    const stream = createAssistantMessageEventStream();
    stream.end(makeAgentAssistantMessage({ api, provider, model: id, content: [] }));
    return stream;
  });
  const preparedExtraParams = { temperature: 0.4, cacheRetention: "long" };
  const override = { responseFormat };
  const createAgent = () => {
    const agent = { streamFn: base };
    applyExtraParamsToAgent(
      agent,
      cfg,
      model.provider,
      model.id,
      override,
      undefined,
      undefined,
      undefined,
      model,
      undefined,
      undefined,
      { preparedExtraParams },
    );
    return agent;
  };
  const resolve = vi.spyOn(retention, "resolveCacheRetention");
  const stringify = JSON.stringify;
  let serializations = 0;
  const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    if (args[0]?.responseFormat === responseFormat) {
      serializations += 1;
    }
    return stringify(...args);
  });
  const agents = Array.from({ length: 1_000 }, createAgent);
  serialization.mockRestore();
  const preparationWork = { retentionResolutions: resolve.mock.calls.length, serializations };
  resolve.mockClear();
  const otherModel = makeProviderModelFixture({
    ...model,
    id: "uncached-model",
    api: "fixture-api",
  });
  const context: Context = { messages: [] };
  const options = { maxTokens: 2048, headers: { "x-fixture": "request" } };
  for (const [index, agent] of agents.entries()) {
    const requestModel = index % 2 === 0 ? model : otherModel;
    const stream = await agent.streamFn(requestModel, context, options);
    expect(stream).toBe(base.mock.results[index]?.value);
    expect(await stream.result()).toMatchObject({ model: requestModel.id, stopReason: "stop" });
    const [forwardedModel, forwardedContext, forwardedOptions] = base.mock.calls[index]!;
    expect(forwardedModel).toBe(requestModel);
    expect(forwardedContext).toBe(context);
    expect(forwardedOptions?.responseFormat).toBe(responseFormat);
    expect(forwardedOptions).toMatchObject({ temperature: 0.4, maxTokens: 2048 });
    expect(forwardedOptions?.headers).toBe(options.headers);
    expect(forwardedOptions?.cacheRetention).toBe(index % 2 === 0 ? "long" : undefined);
  }
  expect(base).toHaveBeenCalledTimes(1_000);
  expect(resolve).toHaveBeenCalledTimes(1_000);
  expect(preparedExtraParams).toEqual({ temperature: 0.4, cacheRetention: "long" });
  expect(override).toEqual({ responseFormat });
  expect(JSON.stringify(responseFormat)).toBe(originalSchema);
  expect(options).toEqual({ maxTokens: 2048, headers: { "x-fixture": "request" } });
  expect(preparationWork).toEqual({ retentionResolutions: 0, serializations: 0 });
});
