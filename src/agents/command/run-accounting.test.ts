import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createCodeModeStats } from "../code-mode-stats.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../embedded-agent-runner/usage-accumulator.js";
import {
  bindAgentCommandRunAccounting,
  createRunAccountingAccumulator,
  resolveAgentCommandRunAccounting,
  runWithAgentCommandAccounting,
} from "./run-accounting.js";

const EXPECTED_CANDIDATE_DETAIL_LIMIT = 32;
const EXPECTED_EFFECTIVE_MODEL_DETAIL_LIMIT = 8;
const EXPECTED_IDENTITY_CHARACTER_LIMIT = 256;
const EXPECTED_TOOL_NAME_LIMIT = 64;

describe("command run accounting", () => {
  it("accumulates embedded candidates, agent submissions, usage, tools, and lifecycle samples", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const accounting = createRunAccountingAccumulator(1_000);
    const first = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    first.selectRuntime("embedded");
    first.beginAgentSubmission().settle("failed");
    const firstStats = createCodeModeStats();
    firstStats.controlCalls.exec = 1;
    firstStats.bridgeLifecycle.registered = 2;
    firstStats.bridgeLifecycle.unresolvedAtExtraction = 2;
    first.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { input: 10, output: 2, total: 12 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 2, tools: ["read", "write"], failures: 1 },
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: firstStats,
      codeModeLifecycleObserved: true,
    });
    first.settle("returned");

    const second = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    second.selectRuntime("embedded");
    second.beginAgentSubmission().settle("completed");
    const secondStats = createCodeModeStats();
    secondStats.controlCalls.exec = 1;
    secondStats.controlCalls.wait = 1;
    secondStats.bridgeLifecycle.registered = 1;
    secondStats.bridgeLifecycle.unresolvedAtExtraction = 1;
    second.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { input: 20, output: 3, cacheRead: 4, total: 27 },
      assistantTurns: 2,
      assistantTurnsObserved: true,
      toolSummary: { calls: 2, tools: ["write", "search"] },
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: secondStats,
      codeModeLifecycleObserved: true,
    });
    accounting.observeCodeModeFinalQuiescence("quiescent");
    second.settle("returned");
    vi.setSystemTime(1_025);

    expect(accounting.project()).toMatchObject({
      candidates: {
        total: 2,
        returned: 2,
        threw: 0,
        runtimes: { embedded: 2, cli: 0, native: 0, cloud: 0, unknown: 0 },
        entries: [
          { provider: "openai", model: "gpt-test", runtime: "embedded", outcome: "returned" },
          { provider: "openai", model: "gpt-test", runtime: "embedded", outcome: "returned" },
        ],
        truncated: 0,
      },
      agentSubmissions: { total: 2, completed: 1, failed: 1 },
      assistantTurns: 3,
      usage: {
        input: 30,
        output: 5,
        cacheRead: 4,
        total: 39,
      },
      toolSummary: {
        calls: 4,
        tools: ["read", "write", "search"],
        failures: 1,
      },
      commandExecutionDurationMs: 25,
      coverage: {
        candidates: { state: "complete" },
        agentSubmissions: { state: "complete" },
        assistantTurns: { state: "complete" },
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "complete" },
          cacheRead: { state: "partial", reasons: ["partial_usage"] },
          cacheWrite: { state: "unavailable", reasons: ["partial_usage"] },
          reasoningTokens: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
        tools: { state: "complete" },
        agentTime: { state: "unavailable", reasons: ["not_instrumented"] },
        commandExecutionDuration: { state: "complete" },
        wallLatency: { state: "unavailable", reasons: ["not_instrumented"] },
        providerTransport: { state: "unavailable", reasons: ["not_observed"] },
      },
      codeMode: {
        engaged: true,
        stats: {
          controlCalls: { exec: 2, wait: 1 },
          bridgeLifecycle: { registered: 3 },
        },
        lifecycle: {
          maxUnresolvedAtExtraction: 2,
          attemptsWithUnresolved: 2,
          finalQuiescence: { state: "quiescent" },
        },
      },
    });
    expect(
      accounting.project().codeMode?.stats?.bridgeLifecycle.unresolvedAtExtraction,
    ).toBeUndefined();
    vi.useRealTimers();
  });

  it("marks opaque CLI work unavailable instead of projecting zero as known", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "claude-cli", model: "opus" });
    candidate.selectRuntime("cli");
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      candidates: {
        total: 1,
        returned: 1,
        runtimes: { cli: 1 },
        entries: [{ provider: "claude-cli", model: "opus", runtime: "cli", outcome: "returned" }],
      },
      coverage: {
        candidates: { state: "complete" },
        agentSubmissions: { state: "unavailable", reasons: ["cli_runtime"] },
        assistantTurns: { state: "unavailable", reasons: ["cli_runtime"] },
        usage: { state: "unavailable", reasons: ["cli_runtime"] },
        tools: { state: "unavailable", reasons: ["cli_runtime"] },
        cost: { state: "unavailable", reasons: ["cli_runtime"] },
        providerTransport: {
          state: "unavailable",
          reasons: ["not_observed", "cli_runtime"],
        },
      },
    });
    expect(accounting.project()).not.toHaveProperty("agentSubmissions");
    expect(accounting.project()).not.toHaveProperty("usage");
    expect(accounting.project()).not.toHaveProperty("assistantTurns");
    expect(accounting.project()).not.toHaveProperty("toolSummary");
  });

  it("marks every observed usage bucket partial when another runtime is opaque", () => {
    const accounting = createRunAccountingAccumulator();
    const embedded = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    embedded.selectRuntime("embedded");
    embedded.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { input: 10, output: 2, total: 12 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    embedded.settle("returned");
    const cli = accounting.beginCandidate({ provider: "claude-cli", model: "opus" });
    cli.selectRuntime("cli");
    cli.settle("returned");

    expect(accounting.project().coverage.usageBuckets).toMatchObject({
      input: { state: "partial", reasons: expect.arrayContaining(["cli_runtime"]) },
      output: { state: "partial", reasons: expect.arrayContaining(["cli_runtime"]) },
      total: { state: "partial", reasons: expect.arrayContaining(["cli_runtime"]) },
    });
  });

  it("labels observed cost as a partial subtotal when another attempt lacks usage", () => {
    const accounting = createRunAccountingAccumulator();
    const observed = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    observed.selectRuntime("embedded");
    observed.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-test",
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    observed.settle("returned");
    const missing = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    missing.selectRuntime("embedded");
    missing.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurns: 0,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    missing.settle("returned");

    expect(accounting.project()).toMatchObject({
      costUsd: 3,
      coverage: {
        usage: { state: "partial", reasons: ["missing_usage", "partial_usage"] },
        cost: { state: "partial", reasons: ["missing_usage", "partial_usage"] },
      },
    });
  });

  it("prices usage against the effective observed model, not the candidate identity", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "base-model" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "anthropic",
      model: "effective-model",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "base-model",
                  cost: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
            anthropic: {
              models: [
                {
                  id: "effective-model",
                  cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      costUsd: 5,
      candidates: {
        entries: [
          {
            provider: "openai",
            model: "base-model",
            runtime: "embedded",
            outcome: "returned",
            effectiveModels: {
              entries: [{ provider: "anthropic", model: "effective-model" }],
              truncated: 0,
            },
          },
        ],
      },
    });
  });

  it("marks usage and cost unavailable when no attempt exposes either metric", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurns: 0,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      coverage: {
        usage: { state: "unavailable", reasons: ["missing_usage"] },
        cost: { state: "unavailable", reasons: ["missing_usage"] },
      },
    });
    expect(accounting.project()).not.toHaveProperty("usage");
    expect(accounting.project()).not.toHaveProperty("costUsd");
  });

  it("treats all-zero placeholder pricing as unknown", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "unpriced" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "unpriced",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "unpriced",
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 100, output: 50, total: 150 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).not.toHaveProperty("costUsd");
    expect(accounting.project().coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["partial_usage", "missing_pricing"],
    });
  });

  it("treats all-zero tiered pricing as unknown", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "unpriced" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "unpriced",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "unpriced",
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        range: [0],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 100, output: 50, total: 150 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).not.toHaveProperty("costUsd");
    expect(accounting.project().coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["partial_usage", "missing_pricing"],
    });
  });

  it("does not price aggregated multi-call usage with request-tiered rates", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "tiered" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "tiered",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "tiered",
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      {
                        input: 2,
                        output: 3,
                        cacheRead: 0,
                        cacheWrite: 0,
                        range: [0],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).not.toHaveProperty("costUsd");
    expect(accounting.project().coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["partial_usage", "tiered_pricing_aggregate"],
    });
  });

  it("keeps input-only and total-only usage sparse with per-bucket coverage", () => {
    const inputOnly = createRunAccountingAccumulator();
    const inputCandidate = inputOnly.beginCandidate({ provider: "openai", model: "gpt-test" });
    inputCandidate.selectRuntime("embedded");
    inputCandidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-test",
                  cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 1 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    inputCandidate.settle("returned");

    expect(inputOnly.project()).toMatchObject({
      usage: { input: 1_000_000 },
      costUsd: 2,
      coverage: {
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "unavailable", reasons: ["partial_usage"] },
        },
        cost: { state: "partial", reasons: ["partial_usage"] },
      },
    });
    expect(inputOnly.project().usage).toEqual({ input: 1_000_000 });

    const totalOnly = createRunAccountingAccumulator();
    const totalCandidate = totalOnly.beginCandidate({ provider: "openai", model: "gpt-test" });
    totalCandidate.selectRuntime("embedded");
    totalCandidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { total: 7 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    totalCandidate.settle("returned");

    expect(totalOnly.project().usage).toEqual({ total: 7 });
    expect(totalOnly.project()).not.toHaveProperty("costUsd");
    expect(totalOnly.project()).toMatchObject({
      coverage: {
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
        cost: { state: "unavailable", reasons: ["partial_usage"] },
      },
    });
  });

  it("preserves producer-observed zero buckets without zero-filling absent buckets", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      total: 120,
    });
    const usage = toNormalizedUsage(usageAccumulator);
    if (!usage) {
      throw new Error("expected aggregated usage");
    }
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage,
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
      coverage: {
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "complete" },
          cacheRead: { state: "complete" },
          cacheWrite: { state: "complete" },
          reasoningTokens: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
      },
    });
  });

  it("does not mark a bucket complete when a later provider call omits it", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 100,
      output: 20,
      cacheRead: 0,
      total: 120,
    });
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 80,
      output: 10,
      total: 90,
    });
    const usage = toNormalizedUsage(usageAccumulator);
    if (!usage) {
      throw new Error("expected aggregated usage");
    }
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage,
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      usage: { input: 180, output: 30, total: 210 },
      coverage: {
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "complete" },
          cacheRead: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
      },
    });
    expect(accounting.project().usage).not.toHaveProperty("cacheRead");
  });

  it("degrades observed model metrics when command-owned work is opaque", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        total: 12,
      },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.markOpaqueWork("settled_finalization_failed");
    candidate.markOpaqueWork("session_core_compaction");
    accounting.markOpaqueWork("context_engine_llm_complete");
    candidate.settle("returned");

    expect(accounting.project().coverage).toMatchObject({
      candidates: { state: "complete" },
      agentSubmissions: {
        state: "unavailable",
        reasons: ["session_core_compaction", "context_engine_llm_complete"],
      },
      assistantTurns: {
        state: "partial",
        reasons: ["settled_finalization_failed"],
      },
      usage: {
        state: "partial",
        reasons: [
          "settled_finalization_failed",
          "session_core_compaction",
          "context_engine_llm_complete",
        ],
      },
      tools: {
        state: "partial",
        reasons: ["settled_finalization_failed"],
      },
      cost: {
        state: "unavailable",
        reasons: [
          "missing_pricing",
          "settled_finalization_failed",
          "session_core_compaction",
          "context_engine_llm_complete",
        ],
      },
      providerTransport: {
        state: "unavailable",
        reasons: ["not_observed", "session_core_compaction", "context_engine_llm_complete"],
      },
    });
  });

  it("caps ordered cumulative tool names without losing aggregate counts", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    const tools = Array.from(
      { length: EXPECTED_TOOL_NAME_LIMIT + 2 },
      (_, index) => `tool-${index}`,
    );
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurnsObserved: true,
      toolSummary: {
        calls: tools.length + 1,
        tools: [...tools, tools[0]!],
        failures: 2,
        totalToolTimeMs: 50,
      },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(snapshot.toolSummary).toMatchObject({
      calls: EXPECTED_TOOL_NAME_LIMIT + 3,
      failures: 2,
      totalToolTimeMs: 50,
    });
    expect(snapshot.toolSummary?.tools).toEqual(tools.slice(0, EXPECTED_TOOL_NAME_LIMIT));
    expect(snapshot.toolNamesTruncated).toBe(true);
    expect(snapshot.coverage.tools).toEqual({
      state: "partial",
      reasons: ["tool_details_truncated"],
    });
  });

  it("bounds each cumulative tool name", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurnsObserved: true,
      toolSummary: { calls: 1, tools: [`tool-${"x".repeat(300)}`] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(Array.from(snapshot.toolSummary?.tools[0] ?? "")).toHaveLength(
      EXPECTED_IDENTITY_CHARACTER_LIMIT,
    );
    expect(snapshot.toolNamesTruncated).toBe(true);
    expect(snapshot.coverage.tools).toEqual({
      state: "partial",
      reasons: ["tool_details_truncated"],
    });
  });

  it("settles candidate and submission handles at most once", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    const submission = candidate.beginAgentSubmission();

    submission.settle("failed");
    submission.settle("completed");
    candidate.settle("threw");
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      candidates: { total: 1, returned: 0, threw: 1 },
      agentSubmissions: { total: 1, completed: 0, failed: 1 },
    });
  });

  it("retains authoritative zeros and omits unobserved embedded fields", () => {
    const accounting = createRunAccountingAccumulator();
    const observed = accounting.beginCandidate({ provider: "openai", model: "observed" });
    observed.selectRuntime("embedded");
    observed.observeEmbeddedAttempt({
      provider: "openai",
      model: "observed",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    observed.settle("returned");

    expect(accounting.project()).toMatchObject({
      assistantTurns: 0,
      toolSummary: { calls: 0, tools: [] },
      coverage: {
        assistantTurns: { state: "complete" },
        tools: { state: "complete" },
      },
    });

    const opaque = createRunAccountingAccumulator();
    const missing = opaque.beginCandidate({ provider: "openai", model: "opaque" });
    missing.selectRuntime("embedded");
    missing.observeEmbeddedAttempt({
      provider: "openai",
      model: "opaque",
      assistantTurnsObserved: false,
      toolsObserved: false,
      codeModeLifecycleObserved: false,
    });
    missing.settle("returned");

    expect(opaque.project()).not.toHaveProperty("assistantTurns");
    expect(opaque.project()).not.toHaveProperty("toolSummary");
    expect(opaque.project()).toMatchObject({
      coverage: {
        assistantTurns: { state: "unavailable", reasons: ["not_observed"] },
        tools: { state: "unavailable", reasons: ["not_observed"] },
      },
    });
  });

  it("omits unobserved Code Mode lifecycle counts", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const lifecycle = accounting.project().codeMode?.lifecycle;
    expect(lifecycle).toEqual({
      finalQuiescence: { state: "unavailable", reasons: ["not_observed"] },
    });
  });

  it("omits whole-run Code Mode lifecycle counts when any relevant attempt is unobserved", () => {
    const accounting = createRunAccountingAccumulator();
    const observed = accounting.beginCandidate({ provider: "openai", model: "observed" });
    observed.selectRuntime("embedded");
    const stats = createCodeModeStats();
    stats.bridgeLifecycle.unresolvedAtExtraction = 0;
    observed.observeEmbeddedAttempt({
      provider: "openai",
      model: "observed",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: stats,
      codeModeLifecycleObserved: true,
    });
    observed.settle("returned");
    const missing = accounting.beginCandidate({ provider: "openai", model: "missing" });
    missing.selectRuntime("embedded");
    missing.observeEmbeddedAttempt({
      provider: "openai",
      model: "missing",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeLifecycleObserved: false,
    });
    missing.settle("returned");

    expect(accounting.project().codeMode?.lifecycle).toEqual({
      finalQuiescence: { state: "unavailable", reasons: ["not_observed"] },
    });
  });

  it("bounds ordered candidate details while preserving exact totals", () => {
    const accounting = createRunAccountingAccumulator();
    for (let index = 0; index < EXPECTED_CANDIDATE_DETAIL_LIMIT + 2; index += 1) {
      const candidate = accounting.beginCandidate({
        provider: "openai",
        model: `model-${index}`,
      });
      candidate.selectRuntime("embedded");
      candidate.settle(index % 2 === 0 ? "returned" : "threw");
    }

    const snapshot = accounting.project();
    expect(snapshot.candidates.total).toBe(EXPECTED_CANDIDATE_DETAIL_LIMIT + 2);
    expect(snapshot.candidates.entries).toHaveLength(EXPECTED_CANDIDATE_DETAIL_LIMIT);
    expect(snapshot.candidates.entries[0]?.model).toBe("model-0");
    expect(snapshot.candidates.entries.at(-1)?.model).toBe(
      `model-${EXPECTED_CANDIDATE_DETAIL_LIMIT - 1}`,
    );
    expect(snapshot.candidates.truncated).toBe(2);
    expect(snapshot.coverage.candidates).toEqual({
      state: "partial",
      reasons: ["candidate_details_truncated"],
    });
  });

  it("bounds ordered effective model identities per candidate", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "base" });
    candidate.selectRuntime("embedded");
    for (let index = 0; index < EXPECTED_EFFECTIVE_MODEL_DETAIL_LIMIT + 2; index += 1) {
      candidate.observeEmbeddedAttempt({
        provider: "openai",
        model: `effective-${index}`,
        assistantTurnsObserved: true,
        toolsObserved: true,
        codeModeLifecycleObserved: false,
      });
    }
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(snapshot.candidates.entries[0]?.effectiveModels.entries).toHaveLength(
      EXPECTED_EFFECTIVE_MODEL_DETAIL_LIMIT,
    );
    expect(snapshot.candidates.entries[0]?.effectiveModels.truncated).toBe(2);
    expect(snapshot.coverage.candidates).toEqual({
      state: "partial",
      reasons: ["effective_model_details_truncated"],
    });
  });

  it("bounds candidate and effective model identity strings", () => {
    const oversizedProvider = `provider-${"p".repeat(EXPECTED_IDENTITY_CHARACTER_LIMIT + 10)}`;
    const oversizedModel = `model-${"m".repeat(EXPECTED_IDENTITY_CHARACTER_LIMIT + 10)}`;
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({
      provider: oversizedProvider,
      model: oversizedModel,
    });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: oversizedProvider,
      model: oversizedModel,
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(Array.from(snapshot.candidates.entries[0]?.provider ?? "")).toHaveLength(
      EXPECTED_IDENTITY_CHARACTER_LIMIT,
    );
    expect(Array.from(snapshot.candidates.entries[0]?.model ?? "")).toHaveLength(
      EXPECTED_IDENTITY_CHARACTER_LIMIT,
    );
    expect(
      Array.from(snapshot.candidates.entries[0]?.effectiveModels.entries[0]?.provider ?? ""),
    ).toHaveLength(EXPECTED_IDENTITY_CHARACTER_LIMIT);
    expect(snapshot.coverage.candidates).toEqual({
      state: "partial",
      reasons: ["candidate_identity_truncated"],
    });
  });

  it("ignores primitive snapshot targets", () => {
    expect(() =>
      bindAgentCommandRunAccounting("provider exploded", {
        candidates: {
          total: 0,
          returned: 0,
          threw: 0,
          runtimes: { embedded: 0, cli: 0, native: 0, cloud: 0, unknown: 0 },
          entries: [],
          truncated: 0,
        },
        agentSubmissions: { total: 0, completed: 0, failed: 0 },
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoningTokens: 0,
          total: 0,
        },
        commandExecutionDurationMs: 0,
        coverage: {
          candidates: { state: "unavailable", reasons: ["not_observed"] },
          agentSubmissions: { state: "unavailable", reasons: ["not_observed"] },
          assistantTurns: { state: "unavailable", reasons: ["not_observed"] },
          usage: { state: "unavailable", reasons: ["not_observed"] },
          usageBuckets: {
            input: { state: "unavailable", reasons: ["not_observed"] },
            output: { state: "unavailable", reasons: ["not_observed"] },
            cacheRead: { state: "unavailable", reasons: ["not_observed"] },
            cacheWrite: { state: "unavailable", reasons: ["not_observed"] },
            reasoningTokens: { state: "unavailable", reasons: ["not_observed"] },
            total: { state: "unavailable", reasons: ["not_observed"] },
          },
          tools: { state: "unavailable", reasons: ["not_observed"] },
          cost: { state: "unavailable", reasons: ["not_observed"] },
          agentTime: { state: "unavailable", reasons: ["not_instrumented"] },
          commandExecutionDuration: { state: "complete" },
          wallLatency: { state: "unavailable", reasons: ["not_instrumented"] },
          providerTransport: { state: "unavailable", reasons: ["not_observed"] },
        },
      }),
    ).not.toThrow();
    expect(resolveAgentCommandRunAccounting("provider exploded")).toBeUndefined();
  });

  it("retains snapshots on thrown Error objects", () => {
    const error = new Error("provider exploded");
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.settle("threw");

    bindAgentCommandRunAccounting(error, accounting.project());

    expect(resolveAgentCommandRunAccounting(error)).toMatchObject({
      candidates: {
        total: 1,
        returned: 0,
        threw: 1,
        entries: [
          {
            provider: "openai",
            model: "gpt-test",
            runtime: "embedded",
            outcome: "threw",
          },
        ],
      },
    });
  });

  it("attaches accounting to early object failures without rewriting primitives", async () => {
    const failure = new Error("startup failed");
    let caughtError: unknown;
    try {
      await runWithAgentCommandAccounting(async () => {
        throw failure;
      });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBe(failure);
    expect(resolveAgentCommandRunAccounting(failure)?.coverage.candidates).toEqual({
      state: "unavailable",
      reasons: ["not_observed"],
    });

    let caughtPrimitive: unknown;
    const rejectPrimitive = vi.fn().mockRejectedValue("provider exploded");
    try {
      await runWithAgentCommandAccounting(async () => await rejectPrimitive());
    } catch (error) {
      caughtPrimitive = error;
    }
    expect(caughtPrimitive).toBe("provider exploded");
    expect(resolveAgentCommandRunAccounting(caughtPrimitive)).toBeUndefined();
  });
});
