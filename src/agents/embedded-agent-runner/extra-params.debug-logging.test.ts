import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { attachModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { StreamFn } from "../runtime/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import * as retention from "./prompt-cache-retention.js";

function createFixture(responseFormat: Record<string, unknown>) {
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
  const observed: Parameters<StreamFn>[] = [];
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  const base: StreamFn = (...args) => {
    observed.push(args);
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      content: [],
      api: args[0].api,
      provider: args[0].provider,
      model: args[0].id,
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: 0,
    });
    streams.push(stream);
    return stream;
  };
  const preparedExtraParams = { temperature: 0.4, cacheRetention: "long" };
  const override = { responseFormat };
  return {
    model,
    observed,
    streams,
    preparedExtraParams,
    override,
    createAgent() {
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
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extra-param debug preparation", () => {
  it("skips diagnostic work for 1000 disabled-debug wrappers while resolving every stream", async () => {
    const responseFormat = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 256 }, (_, index) => [`field_${index}`, { type: "string" }]),
      ),
    };
    const originalSchema = JSON.stringify(responseFormat);
    const fixture = createFixture(responseFormat);
    const resolve = vi.spyOn(retention, "resolveCacheRetention");
    const stringify = JSON.stringify;
    let serializations = 0;
    const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      const [value] = args;
      if (
        value &&
        typeof value === "object" &&
        "responseFormat" in value &&
        value.responseFormat === responseFormat
      ) {
        serializations += 1;
      }
      return stringify(...args);
    });
    let agents: ReturnType<typeof fixture.createAgent>[];
    try {
      agents = Array.from({ length: 1_000 }, () => fixture.createAgent());
    } finally {
      serialization.mockRestore();
    }
    const preparationWork = { retentionResolutions: resolve.mock.calls.length, serializations };
    resolve.mockClear();
    const otherModel = makeProviderModelFixture({
      provider: fixture.model.provider,
      id: "uncached-model",
      api: "fixture-api",
      baseUrl: fixture.model.baseUrl,
    });
    const context: Context = { messages: [] };
    const options = { maxTokens: 2048, headers: { "x-fixture": "request" } };
    for (const [index, agent] of agents.entries()) {
      const model = index % 2 === 0 ? fixture.model : otherModel;
      const stream = await agent.streamFn(model, context, options);
      expect(stream).toBe(fixture.streams[index]);
      expect(await stream.result()).toMatchObject({ model: model.id, stopReason: "stop" });
      const [forwardedModel, forwardedContext, forwardedOptions] = fixture.observed[index]!;
      expect(forwardedModel).toBe(model);
      expect(forwardedContext).toBe(context);
      expect(forwardedOptions?.responseFormat).toBe(responseFormat);
      expect(forwardedOptions?.temperature).toBe(0.4);
      expect(forwardedOptions?.maxTokens).toBe(options.maxTokens);
      expect(forwardedOptions?.headers).toBe(options.headers);
      expect(forwardedOptions?.cacheRetention).toBe(index % 2 === 0 ? "long" : undefined);
    }
    expect(fixture.observed).toHaveLength(1_000);
    expect(resolve).toHaveBeenCalledTimes(1_000);
    expect(fixture.preparedExtraParams).toEqual({ temperature: 0.4, cacheRetention: "long" });
    expect(fixture.override).toEqual({ responseFormat });
    expect(JSON.stringify(responseFormat)).toBe(originalSchema);
    expect(options).toEqual({ maxTokens: 2048, headers: { "x-fixture": "request" } });
    expect(preparationWork).toEqual({ retentionResolutions: 0, serializations: 0 });
  });
});
