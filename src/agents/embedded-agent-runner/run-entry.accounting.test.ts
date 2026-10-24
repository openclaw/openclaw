import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReplyUsageState } from "../../auto-reply/reply/reply-usage-state.js";
import { prepareSessionUsageUpdate } from "../../auto-reply/reply/session-usage.js";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";
import type { NormalizedUsage } from "../usage.js";
import { runEmbeddedAgentEntry, setupRunEntryTestState } from "./run-entry.test-harness.js";
import {
  createDirectHarness,
  makeResult,
  initialAttemptOptions,
  fallbackAttemptOptions,
} from "./run-entry.test-support.js";
import type { EmbeddedAgentMeta } from "./types.js";

const state = setupRunEntryTestState();
beforeEach(() => runtimeConfig.setRuntimeConfigSnapshot({}));
afterEach(runtimeConfig.clearRuntimeConfigSnapshot);

function pricedProvider(name: string, input: number, output: number) {
  const model = {
    id: `${name}-model`,
    name,
    reasoning: false,
    input: ["text" as const],
    maxTokens: 128,
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
  };
  return { baseUrl: `https://${name}.invalid`, models: [model] };
}

const providers = {
  "primary-provider": pricedProvider("primary", 1, 2),
  "fallback-provider": pricedProvider("fallback", 10, 20),
};
const cfg: OpenClawConfig = { models: { providers } };
const fallbackRoute = { provider: "fallback-provider", model: "fallback-model" };

const entryDefaults = {
  selection: { cfg, provider: "primary-provider", model: "primary-model" },
  identity: { runId: "run-accounting", agentId: "main", sessionId: "session-1" },
  harness: createDirectHarness(),
  behavior: { kind: "command-rpc" as const, hasCommittedSideEffect: () => false },
  sessionOverride: { kind: "preserve" as const },
};
const billedZero = { total: 0, totalOrigin: "provider-billed" as const };

function usageConsumers(meta: Partial<EmbeddedAgentMeta>) {
  const { provider, model, usage, lastCallUsage } = meta;
  return {
    reply: buildReplyUsageState({
      config: cfg,
      agentDir: "/nonexistent-fallback-accounting",
      agentId: "main",
      sessionId: "session-1",
      provider,
      model,
      winnerProvider: provider,
      winnerModel: model,
      usage,
      lastCallUsage,
    }),
    session: prepareSessionUsageUpdate({
      cfg,
      usage,
      lastCallUsage,
      providerUsed: provider,
      modelUsed: model,
    }),
    diagnosticCost: estimateAggregateUsageCost({
      config: cfg,
      provider,
      model,
      usage: meta.diagnosticUsage,
    }),
  };
}

async function runAccountedEntry(
  primary: NormalizedUsage,
  fallback: NormalizedUsage,
  config = cfg,
  diagnostics?: readonly [NormalizedUsage, NormalizedUsage],
  lastCallUsage: NormalizedUsage | null = { input: 20, output: 2 },
) {
  const { result } = await runEmbeddedAgentEntry({
    ...entryDefaults,
    selection: { cfg: config, provider: "primary-provider", model: "primary-model" },
    runCandidate: async (provider, model, options) => {
      const usage = options.isFallbackRetry ? fallback : primary;
      const candidate = makeResult({
        provider,
        model,
        classification: options.isFallbackRetry ? undefined : "empty",
      });
      candidate.meta.agentMeta = {
        ...candidate.meta.agentMeta!,
        usage,
        diagnosticUsage: diagnostics?.[options.isFallbackRetry ? 1 : 0],
        lastCallUsage: options.isFallbackRetry
          ? (lastCallUsage ?? undefined)
          : { input: 90, output: 2 },
        assistantTurns: options.isFallbackRetry ? 2 : 1,
        bridgeCalls: { search: 1, describe: 0, call: options.isFallbackRetry ? 3 : 1 },
      };
      // Producers and the fallback runner can both ask for classification.
      options.classifyResult?.(candidate);
      options.classifyResult?.(candidate);
      return candidate;
    },
  });
  return result.meta.agentMeta!;
}

describe("fallback candidate accounting", () => {
  it.each([null, { input: 0, output: 0, usageReport: { state: "available" as const } }])(
    "does not treat discarded usage as the winner's context (%j)",
    async (lastCallUsage) => {
      const meta = await runAccountedEntry(
        { input: 100, cost: { total: 0.2 } },
        { input: 200, cost: { total: 0.7 } },
        cfg,
        undefined,
        lastCallUsage,
      );
      const { reply } = usageConsumers({ usage: meta.usage, lastCallUsage: meta.lastCallUsage });
      expect(meta.usage?.input).toBe(300);
      expect(reply.contextUsedTokens).toBeUndefined();
      expect(meta.lastCallUsage).toEqual(lastCallUsage ?? undefined);
    },
  );
  it.each([
    ["recorded costs", { total: 0.2 }, { total: 0.7 }, 0.9, undefined],
    ["different configured prices", undefined, undefined, 0.00252, undefined],
    ["provider-billed zero", billedZero, billedZero, 0, undefined],
    ["unknown price before known price", { total: 0 }, { total: 0.7 }, undefined, undefined],
    ["unknown price after known price", { total: 0.7 }, { total: 0 }, undefined, undefined],
    [
      "cumulative diagnostics separate from CLI billing",
      { total: 0.2 },
      { total: 0.7 },
      0.9,
      [
        { input: 150, cost: { total: 0.3 } },
        { input: 250, cost: { total: 1.1 } },
      ],
    ],
  ] as const)(
    "retains discarded work and %s across reply and session accounting",
    async (_name, primary, fallback, expected, diagnostics) => {
      const unknown = expected === undefined;
      const meta = await runAccountedEntry(
        { input: 100, output: diagnostics ? undefined : 10, cost: primary },
        { input: 200, output: diagnostics ? undefined : 20, cost: fallback },
        unknown ? {} : cfg,
        diagnostics,
      );
      const output = diagnostics ? {} : { output: 30, total: 330 };
      expect(meta).toMatchObject({
        usage: { input: 300, ...output },
        ...fallbackRoute,
        lastCallUsage: { input: 20, output: 2 },
        assistantTurns: 3,
        bridgeCalls: { search: 2, describe: 0, call: 4 },
      });
      const consumerMeta = unknown ? { ...meta, lastCallUsage: undefined } : meta;
      const { reply, session, diagnosticCost } = usageConsumers(consumerMeta);
      expect(reply.usage).toMatchObject({ input: 300, ...(diagnostics ? {} : { output: 30 }) });
      expect(reply.contextUsedTokens).toBe(unknown ? undefined : 20);
      const cost = unknown ? undefined : expect.closeTo(expected, 9);
      const costs = [reply.turnUsd, session?.estimateCost(), diagnosticCost];
      expect(costs).toEqual([cost, cost, diagnostics ? expect.closeTo(1.4, 9) : cost]);
      if (diagnostics) {
        expect(meta).toMatchObject({
          usage: { cost: { total: expect.closeTo(0.9, 9) } },
          diagnosticUsage: { input: 400, cost: { total: expect.closeTo(1.4, 9) } },
        });
      }
    },
  );

  it("does not invent usage for an attempt that throws before returning", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params) => {
      await expect(
        params.run(params.provider, params.model, initialAttemptOptions(params)),
      ).rejects.toThrow("before result");
      const { provider, model } = fallbackRoute;
      const result = await params.run(provider, model, fallbackAttemptOptions(params, "unknown"));
      return { outcome: "completed", result, provider, model, attempts: [] };
    });
    const { result } = await runEmbeddedAgentEntry({
      ...entryDefaults,
      identity: { runId: "run-accounting-throw", agentId: "main", sessionId: "session-1" },
      runCandidate: async (provider, model) => {
        if (provider === "primary-provider") {
          throw new Error("before result");
        }
        const candidate = makeResult({ provider, model });
        candidate.meta.agentMeta!.usage = { input: 7, cost: { total: 0.25 } };
        return candidate;
      },
    });
    expect(result.meta.agentMeta?.usage).toEqual({ input: 7, cost: { total: 0.25 } });
  });
});
