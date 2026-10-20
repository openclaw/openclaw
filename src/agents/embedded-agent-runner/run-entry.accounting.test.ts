import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReplyUsageState } from "../../auto-reply/reply/reply-usage-state.js";
import { prepareSessionUsageUpdate } from "../../auto-reply/reply/session-usage.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

function pricedProvider(name: string, input: number, output: number) {
  return {
    baseUrl: `https://${name}.invalid`,
    models: [
      {
        id: `${name}-model`,
        name,
        reasoning: false,
        input: ["text" as const],
        maxTokens: 128,
        cost: { input, output, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

const cfg: OpenClawConfig = {
  models: {
    providers: {
      "primary-provider": pricedProvider("primary", 1, 2),
      "fallback-provider": pricedProvider("fallback", 10, 20),
    },
  },
};

const entryDefaults = {
  selection: { cfg, provider: "primary-provider", model: "primary-model" },
  identity: { runId: "run-accounting", agentId: "main", sessionId: "session-1" },
  harness: createDirectHarness(),
  behavior: { kind: "command-rpc" as const, hasCommittedSideEffect: () => false },
  sessionOverride: { kind: "preserve" as const },
};

function usageConsumers(
  meta: Pick<EmbeddedAgentMeta, "usage" | "lastCallUsage" | "diagnosticUsage"> &
    Partial<Pick<EmbeddedAgentMeta, "provider" | "model">>,
) {
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
  diagnostics?: [NormalizedUsage, NormalizedUsage],
  lastCallUsage: NormalizedUsage | null = { input: 20, output: 2 },
) {
  return runEmbeddedAgentEntry({
    ...entryDefaults,
    selection: { cfg: config, provider: "primary-provider", model: "primary-model" },
    runCandidate: async (provider, model, options) => {
      const usage = options.isFallbackRetry ? fallback : primary;
      const result = makeResult({
        provider,
        model,
        classification: options.isFallbackRetry ? undefined : "empty",
        meta: {
          agentMeta: {
            sessionId: "session-1",
            provider,
            model,
            usage,
            diagnosticUsage: diagnostics?.[options.isFallbackRetry ? 1 : 0],
            lastCallUsage: options.isFallbackRetry
              ? (lastCallUsage ?? undefined)
              : { input: 90, output: 2 },
            assistantTurns: options.isFallbackRetry ? 2 : 1,
            bridgeCalls: { search: 1, describe: 0, call: options.isFallbackRetry ? 3 : 1 },
          },
        },
      });
      // Producers and the fallback runner can both ask for classification.
      options.classifyResult?.(result);
      options.classifyResult?.(result);
      return result;
    },
  });
}

describe("fallback candidate accounting", () => {
  it.each([null, { input: 0, output: 0, usageReport: { state: "available" as const } }])(
    "does not treat discarded usage as the winner's context (%j)",
    async (lastCallUsage) => {
      const { result } = await runAccountedEntry(
        { input: 100, cost: { total: 0.2 } },
        { input: 200, cost: { total: 0.7 } },
        cfg,
        undefined,
        lastCallUsage,
      );
      const meta = result.meta.agentMeta!;
      const { reply } = usageConsumers({ usage: meta.usage, lastCallUsage: meta.lastCallUsage });
      expect(meta.usage?.input).toBe(300);
      expect(reply.contextUsedTokens).toBeUndefined();
      expect(meta.lastCallUsage).toEqual(lastCallUsage ?? undefined);
    },
  );
  it.each([
    { name: "recorded costs", primary: { total: 0.2 }, fallback: { total: 0.7 }, expected: 0.9 },
    {
      name: "different configured prices",
      primary: undefined,
      fallback: undefined,
      expected: 0.00252,
    },
    {
      name: "provider-billed zero",
      primary: { total: 0, totalOrigin: "provider-billed" as const },
      fallback: { total: 0, totalOrigin: "provider-billed" as const },
      expected: 0,
    },
  ])(
    "retains discarded work and $name across reply and session accounting",
    async ({ primary, fallback, expected }) => {
      const { result } = await runAccountedEntry(
        { input: 100, output: 10, cost: primary },
        { input: 200, output: 20, cost: fallback },
      );
      const meta = result.meta.agentMeta!;
      expect(meta.usage).toMatchObject({ input: 300, output: 30, total: 330 });
      expect(meta).toMatchObject({
        provider: "fallback-provider",
        model: "fallback-model",
        lastCallUsage: { input: 20, output: 2 },
        assistantTurns: 3,
        bridgeCalls: { search: 2, describe: 0, call: 4 },
      });
      const { reply, session, diagnosticCost } = usageConsumers(meta);
      expect(reply.usage).toMatchObject({ input: 300, output: 30 });
      expect(reply.contextUsedTokens).toBe(20);
      expect(reply.turnUsd).toBeCloseTo(expected, 9);
      expect(session?.estimateCost()).toBeCloseTo(expected, 9);
      expect(diagnosticCost).toBeCloseTo(expected, 9);
    },
  );

  it.each([true, false])(
    "keeps unknown candidate pricing unknown (unknown first: %s)",
    async (unknownFirst) => {
      const known = { input: 200, output: 20, cost: { total: 0.7 } };
      const unknown = { input: 100, output: 10, cost: { total: 0 } };
      const { result } = await runAccountedEntry(
        unknownFirst ? unknown : known,
        unknownFirst ? known : unknown,
        {},
      );
      const meta = result.meta.agentMeta!;
      expect(meta.usage).toMatchObject({ input: 300, output: 30 });
      // Even a consumer with a known winner price cannot reprice a mixed total.
      const { session, diagnosticCost } = usageConsumers({ ...meta, lastCallUsage: undefined });
      expect(session?.estimateCost()).toBeUndefined();
      expect(diagnosticCost).toBeUndefined();
    },
  );

  it("accounts cumulative diagnostics separately from latest-call CLI billing", async () => {
    const { result } = await runAccountedEntry(
      { input: 100, cost: { total: 0.2 } },
      { input: 200, cost: { total: 0.7 } },
      cfg,
      [
        { input: 150, cost: { total: 0.3 } },
        { input: 250, cost: { total: 1.1 } },
      ],
    );
    expect(result.meta.agentMeta?.usage?.input).toBe(300);
    expect(result.meta.agentMeta?.usage?.cost?.total).toBeCloseTo(0.9, 9);
    expect(result.meta.agentMeta?.diagnosticUsage).toMatchObject({ input: 400 });
    expect(result.meta.agentMeta?.diagnosticUsage?.cost?.total).toBeCloseTo(1.4, 9);
  });

  it("does not invent usage for an attempt that throws before returning", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params) => {
      await expect(
        params.run(params.provider, params.model, initialAttemptOptions(params)),
      ).rejects.toThrow("before result");
      const result = await params.run(
        "fallback-provider",
        "fallback-model",
        fallbackAttemptOptions(params, "unknown"),
      );
      return {
        outcome: "completed",
        result,
        provider: "fallback-provider",
        model: "fallback-model",
        attempts: [],
      };
    });
    const { result } = await runEmbeddedAgentEntry({
      ...entryDefaults,
      identity: { runId: "run-accounting-throw", agentId: "main", sessionId: "session-1" },
      runCandidate: async (provider, model) => {
        if (provider === "primary-provider") {
          throw new Error("before result");
        }
        return makeResult({
          provider,
          model,
          meta: {
            agentMeta: {
              sessionId: "session-1",
              provider,
              model,
              usage: { input: 7, cost: { total: 0.25 } },
            },
          },
        });
      },
    });
    expect(result.meta.agentMeta?.usage).toEqual({ input: 7, cost: { total: 0.25 } });
  });
});
