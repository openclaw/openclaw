import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isVerbose, setVerbose } from "../../global-state.js";
import type { Context } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { setConsoleSubsystemFilter } from "../../logging/console.js";
import { createSuiteLogPathTracker } from "../../logging/log-test-helpers.js";
import { applyLoggingConfig, flushLogger, resetLogger } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { attachModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { StreamFn } from "../runtime/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { log } from "./logger.js";
import * as retention from "./prompt-cache-retention.js";

const logPaths = createSuiteLogPathTracker("openclaw-extra-params-debug-");
const diagnosticPrefix = "creating streamFn wrapper with params: ";
let previousVerbose = false;

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
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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

beforeAll(async () => {
  await logPaths.setup();
});

beforeEach(() => {
  previousVerbose = isVerbose();
  // Exercise managed runtime settings instead of Vitest's default silent sinks.
  vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
  setVerbose(false);
  setConsoleSubsystemFilter(null);
  resetLogger();
  applyLoggingConfig({ level: "silent", consoleLevel: "silent" });
});

afterEach(async () => {
  setVerbose(previousVerbose);
  await flushLogger();
  loggingState.rawConsole = null;
  setConsoleSubsystemFilter(null);
  resetLogger();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await logPaths.cleanup();
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

  it("keeps diagnostic output for either sink across applied logging changes", async () => {
    const responseFormat = { type: "object", properties: { answer: { type: "string" } } };
    const fixture = createFixture(responseFormat);
    const file = logPaths.nextPath();
    const sink = vi.fn();
    loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
    const debug = vi.spyOn(log, "debug");
    const diagnostic = `${diagnosticPrefix}${JSON.stringify({
      temperature: 0.4,
      responseFormat,
      cacheRetention: "long",
    })}`;
    for (const [level, consoleLevel, enabled] of [
      ["silent", "silent", false],
      ["silent", "debug", true],
      ["debug", "silent", true],
      ["silent", "silent", false],
    ] as const) {
      applyLoggingConfig({ level, consoleLevel, consoleStyle: "json", file });
      debug.mockClear();
      const agent = fixture.createAgent();
      expect(
        debug.mock.calls
          .map(([message]) => message)
          .filter((message) => message.startsWith(diagnosticPrefix)),
      ).toEqual(enabled ? [diagnostic] : []);
      const stream = await agent.streamFn(
        fixture.model,
        { messages: [] },
        { cacheRetention: "none" },
      );
      expect(await stream.result()).toMatchObject({ stopReason: "stop" });
      expect(fixture.observed.at(-1)?.[2]?.cacheRetention).toBe("none");
    }
    await flushLogger();
    const fileMessages = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message: string }).message);
    const consoleMessages = sink.mock.calls.map(
      ([line]) => (JSON.parse(String(line)) as { message: string }).message,
    );
    expect(fileMessages.filter((message) => message.startsWith(diagnosticPrefix))).toEqual([
      diagnostic,
    ]);
    expect(consoleMessages.filter((message) => message.startsWith(diagnosticPrefix))).toEqual([
      diagnostic,
    ]);
  });
});
