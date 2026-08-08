import { describe, expect, it } from "vitest";
import {
  bindAgentCommandRunAccounting,
  createRunAccountingAccumulator,
  resolveAgentCommandRunAccounting,
} from "./run-accounting.js";

describe("command run accounting coverage", () => {
  it("does not project legacy submissions keys", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.beginAgentSubmission().settle("completed");
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(snapshot).toHaveProperty("agentSubmissions");
    expect(snapshot.coverage).toHaveProperty("agentSubmissions");
    expect(snapshot).not.toHaveProperty("submissions");
    expect(snapshot.coverage).not.toHaveProperty("submissions");
  });

  it("isolates stored snapshots from producer and consumer mutation", () => {
    const target = {};
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.beginAgentSubmission().settle("completed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test-effective",
      usage: { input: 10, output: 2, total: 12 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 1, tools: ["read"] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.markOpaqueWork("post_turn_compaction");
    candidate.settle("returned");

    const projected = accounting.project();
    bindAgentCommandRunAccounting(target, projected);
    projected.candidates.entries[0]!.effectiveModels.entries[0]!.model = "mutated producer";
    projected.toolSummary!.tools.push("producer-tool");

    const firstResolved = resolveAgentCommandRunAccounting(target);
    expect(firstResolved?.candidates.entries[0]?.effectiveModels.entries[0]?.model).toBe(
      "gpt-test-effective",
    );
    firstResolved!.candidates.entries[0]!.effectiveModels.entries.push({
      provider: "mutated",
      model: "consumer",
    });
    firstResolved!.toolSummary!.tools.push("consumer-tool");
    if (firstResolved!.coverage.usage.state !== "partial") {
      throw new Error("expected partial usage coverage");
    }
    firstResolved!.coverage.usage.reasons.push("not_observed");

    const secondResolved = resolveAgentCommandRunAccounting(target);
    expect(secondResolved?.candidates.entries[0]?.effectiveModels.entries).toEqual([
      { provider: "openai", model: "gpt-test-effective" },
    ]);
    expect(secondResolved?.toolSummary?.tools).toEqual(["read"]);
    expect(secondResolved?.coverage.usage).toEqual({
      state: "partial",
      reasons: ["partial_usage", "post_turn_compaction"],
    });
  });

  it.each([
    "session_core_compaction",
    "session_extension_compaction",
    "context_engine_llm_complete",
    "deferred_context_engine_maintenance",
    "post_turn_compaction",
    "exec_auto_review_model_completion",
  ] as const)("%s taints only hidden model-work surfaces", (reason) => {
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
      toolSummary: { calls: 1, tools: ["read"] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.beginAgentSubmission().settle("completed");
    candidate.markOpaqueWork(reason);
    candidate.settle("returned");

    const coverage = accounting.project().coverage;
    expect(coverage.candidates).toEqual({ state: "complete" });
    expect(coverage.agentSubmissions).toEqual({ state: "partial", reasons: [reason] });
    expect(coverage.assistantTurns).toEqual({ state: "complete" });
    expect(coverage.tools).toEqual({ state: "complete" });
    expect(coverage.usage).toEqual({ state: "partial", reasons: [reason] });
    expect(coverage.usageBuckets.input).toEqual({ state: "partial", reasons: [reason] });
    expect(coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["missing_pricing", reason],
    });
    expect(coverage.providerTransport).toEqual({
      state: "unavailable",
      reasons: ["not_instrumented", reason],
    });
  });

  it("marks ACP model work unavailable without inventing candidates or submissions", () => {
    const accounting = createRunAccountingAccumulator();
    accounting.markOpaqueWork("acp_runtime");

    const snapshot = accounting.project();
    expect(snapshot.candidates.total).toBe(0);
    expect(snapshot.agentSubmissions).toBeUndefined();
    expect(snapshot.coverage.candidates).toEqual({
      state: "unavailable",
      reasons: ["not_observed"],
    });
    expect(snapshot.coverage.agentSubmissions).toEqual({
      state: "unavailable",
      reasons: ["not_observed", "acp_runtime"],
    });
    expect(snapshot.coverage.providerTransport).toEqual({
      state: "unavailable",
      reasons: ["not_instrumented", "acp_runtime"],
    });
  });
});
