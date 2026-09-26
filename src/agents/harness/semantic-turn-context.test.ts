import { describe, expect, it, vi } from "vitest";
import type { AssembleResult, ContextEngine } from "../../context-engine/types.js";
import type { DecisionRuntimeV1 } from "../../decisions/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { installDecisionFixture } from "../agent-hooks/compaction-safeguard-semantic.test-support.js";
import type { AgentMessage } from "../runtime/index.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { assembleHarnessContextEngine } from "./context-engine-lifecycle.js";
import { observeSemanticTurnContext } from "./semantic-turn-context.js";

function fixture(): AssembleResult {
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: "Only modify staging. Keep the unresolved deployment pending.",
      timestamp: 1,
    },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
      timestamp: 2,
    }),
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Old completed health check. ".repeat(30) }],
      isError: false,
      timestamp: 3,
    },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "I still owe you the deployment." }],
      timestamp: 4,
    }),
    { role: "user", content: "Continue the staging work.", timestamp: 5 },
  ];
  return { messages, estimatedTokens: 300 };
}
function options() {
  return {
    config: { mode: "shadow" as const, minEstimatedTokens: 1, recentMessages: 2 },
    signal: new AbortController().signal,
    assertActive: vi.fn(),
    isEligible: () => true,
  };
}
const unavailable: DecisionRuntimeV1 = {
  evaluate: vi.fn(async () => ({
    status: "unavailable" as const,
    reason: "not-configured" as const,
  })),
};

describe("semantic turn context", () => {
  it("uses the registered context-engine assembly and Decision provider without changing messages", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    const before = JSON.stringify(source.messages);
    const engine: ContextEngine = {
      info: { id: "legacy", name: "fixture" },
      ingest: async () => ({ ingested: false }),
      assemble: async () => source,
      compact: async () => ({ ok: true, compacted: false }),
    };
    const result = await assembleHarnessContextEngine({
      contextEngine: engine,
      messages: source.messages,
      sessionId: "synthetic",
      modelId: "synthetic-model",
      agentId: "specialist",
      semanticCuration: options(),
    });
    expect(requests).toEqual([{ agentId: "specialist", model: "owner-v1" }]);
    expect(result?.messages).toBe(source.messages);
    expect(JSON.stringify(source.messages)).toBe(before);
    expect(result?.semanticCurationObservation).toMatchObject({
      mode: "shadow",
      reason: "shadow",
      evaluatedSegments: 1,
      protectedSegments: 3,
    });
    expect(result?.semanticCurationObservation?.reductionRatio).toBeGreaterThan(0);
  });
  it("makes no Decision call when off or below threshold", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    expect(
      await observeSemanticTurnContext(source, { ...options(), config: { mode: "off" } }),
    ).toBe(source);
    const result = await observeSemanticTurnContext(source, {
      ...options(),
      config: { mode: "shadow", minEstimatedTokens: 16000 },
    });
    expect(result.semanticCurationObservation?.reason).toBe("below-size-threshold");
    expect(requests).toHaveLength(0);
  });
  it("preserves append-only and persistent-thread hosts without inference", async () => {
    const { requests } = installDecisionFixture();
    for (const result of [
      await observeSemanticTurnContext(fixture(), { ...options(), appendOnly: true }),
      await observeSemanticTurnContext(
        { ...fixture(), contextProjection: { mode: "thread_bootstrap", epoch: "one" } },
        options(),
      ),
    ]) {
      expect(result.semanticCurationObservation?.reason).toBe("persistent-or-append-only-context");
    }
    expect(requests).toHaveLength(0);
  });
  it("protects active errors with their tool-call frame", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    const tool = source.messages[2];
    if (tool?.role === "toolResult") {
      tool.isError = true;
    }
    const result = await observeSemanticTurnContext(source, options());
    expect(result.messages).toBe(source.messages);
    expect(requests).toHaveLength(0);
    expect(result.semanticCurationObservation?.reason).toBe("no-discretionary-segments");
  });
  it("retains original context on unexpected provider failures", async () => {
    const source = fixture();
    const result = await observeSemanticTurnContext(source, options(), {
      evaluate: async () => {
        throw new Error("provider transport failed");
      },
    });
    expect(result.messages).toBe(source.messages);
    expect(result.semanticCurationObservation?.reason).toBe("decision-error");
  });
  it("does not observe a host without a captured lifecycle binding", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    const result = await assembleHarnessContextEngine({
      contextEngine: {
        info: { id: "legacy", name: "unbound fixture" },
        ingest: async () => ({ ingested: false }),
        assemble: async () => source,
        compact: async () => ({ ok: true, compacted: false }),
      },
      messages: source.messages,
      sessionId: "unbound",
      modelId: "synthetic-unbound",
    });
    expect(result).toBe(source);
    expect(requests).toHaveLength(0);
  });
  it("records unavailable without fabricating token usage", async () => {
    const source = fixture();
    const result = await observeSemanticTurnContext(source, options(), unavailable);
    expect(result.messages).toBe(source.messages);
    expect(result.semanticCurationObservation?.reason).toBe("not-configured");
    expect(result.semanticCurationObservation?.decisionInputTokens).toBeUndefined();
  });
  it("rejects stale source observations", async () => {
    const source = fixture();
    installDecisionFixture("preserved", () => {
      source.messages.push({ role: "user", content: "New required constraint", timestamp: 6 });
    });
    const result = await observeSemanticTurnContext(source, options());
    expect(result.semanticCurationObservation?.reason).toBe("stale-source");
  });
  it.each(["branchSummary", "compactionSummary"])(
    "rejects a summary-only mutation during selection (%s)",
    async (role) => {
      const source = fixture();
      const summary = { role, summary: "Keep staging isolated", timestamp: 0 };
      source.messages.unshift(castAgentMessage(summary));
      installDecisionFixture("preserved", () => {
        summary.summary = "New unresolved requirement: do not deploy";
      });
      const result = await observeSemanticTurnContext(source, options());
      expect(result.messages).toBe(source.messages);
      expect(result.semanticCurationObservation?.reason).toBe("stale-source");
    },
  );
  it("caller cancellation and replaced authority win after evaluation", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    installDecisionFixture("preserved", () => {
      controller.abort(reason);
    });
    await expect(
      observeSemanticTurnContext(fixture(), { ...options(), signal: controller.signal }),
    ).rejects.toBe(reason);
  });
  it("revalidates owner authority after awaited Decision work", async () => {
    installDecisionFixture();
    const opts = options();
    const error = new Error("closed admission");
    opts.assertActive
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw error;
      });
    await expect(observeSemanticTurnContext(fixture(), opts)).rejects.toBe(error);
  });
});

describe("semantic turn context apply", () => {
  function applyOptions() {
    return {
      ...options(),
      modelId: "measured-model",
      config: {
        mode: "apply" as const,
        minEstimatedTokens: 1,
        recentMessages: 2,
        economics: {
          modelId: "measured-model",
          savedMsPerEstimatedToken: 100,
          decisionOverheadMs: 1,
          cachePenaltyMs: 1,
        },
      },
    };
  }
  function candidate(): AssembleResult {
    return {
      ...fixture(),
      semanticCurationCandidates: {
        discretionaryMessageIndexes: [1, 2],
        requiredIdentifiers: [],
      },
    };
  }
  it.each(["off", "revoked"])(
    "preserves the original apply view with eligibility %s",
    async (consent) => {
      let eligible = consent !== "off";
      const { requests } = installDecisionFixture("preserved", async () => {
        eligible = false;
      });
      const source = candidate();
      const original = structuredClone(source);
      const result = await observeSemanticTurnContext(source, {
        ...applyOptions(),
        isEligible: () => eligible,
      });
      expect(result).toBe(source);
      expect(source).toEqual(original);
      expect(requests).toHaveLength(consent === "off" ? 0 : 1);
    },
  );

  it("preserves the model view without dispatch after eligibility changes during preparation", async () => {
    const { requests } = installDecisionFixture();
    const source = candidate();
    let eligible = true;
    let revocations = 0;
    const result = await withPluginRuntimeGatewayRequestScope(
      {
        resolveGatewayContext: () => {
          queueMicrotask(() => {
            revocations++;
            eligible = false;
          });
          return undefined;
        },
      },
      () => observeSemanticTurnContext(source, { ...applyOptions(), isEligible: () => eligible }),
    );
    expect(revocations).toBeGreaterThan(0);
    expect(requests).toHaveLength(0);
    expect(result).toBe(source);
  });

  it("does not dispatch after run authority closes during provider preparation", async () => {
    const { requests } = installDecisionFixture();
    const source = candidate();
    const original = structuredClone(source);
    const closed = new Error("closed admission");
    let active = true;
    let revocations = 0;
    await expect(
      withPluginRuntimeGatewayRequestScope(
        {
          resolveGatewayContext: () => {
            queueMicrotask(() => {
              revocations++;
              active = false;
            });
            return undefined;
          },
        },
        () =>
          observeSemanticTurnContext(source, {
            ...applyOptions(),
            assertActive: () => {
              if (!active) {
                throw closed;
              }
            },
          }),
      ),
    ).rejects.toBe(closed);
    expect(revocations).toBeGreaterThan(0);
    expect(requests).toHaveLength(0);
    expect(source).toEqual(original);
  });

  it("keeps the most recent assembled tool result when a synthetic prompt is appended", async () => {
    installDecisionFixture();
    const source = candidate();
    source.messages = source.messages.slice(0, 4);
    const original = structuredClone(source.messages);
    const result = await observeSemanticTurnContext(source, {
      ...applyOptions(),
      prompt: "Continue the pending work.",
    });
    expect(result.messages).toEqual(original);
    expect(source.messages).toEqual(original);
    expect(result.semanticCurationObservation?.applied).not.toBe(true);
  });

  it("applies only owner-attested complete tool frames through the registered host", async () => {
    const { requests } = installDecisionFixture();
    const source = candidate();
    const before = JSON.stringify(source);
    const result = await assembleHarnessContextEngine({
      contextEngine: {
        info: { id: "attested-engine", name: "Owner-attested fixture" },
        ingest: async () => ({ ingested: false }),
        assemble: async () => source,
        compact: async () => ({ ok: true, compacted: false }),
      },
      messages: source.messages,
      sessionId: "synthetic",
      agentId: "specialist",
      modelId: "measured-model",
      semanticCuration: applyOptions(),
    });
    expect(result?.messages).toEqual([source.messages[0], source.messages[3], source.messages[4]]);
    expect(result?.estimatedTokens).toBe(source.estimatedTokens);
    expect(result?.semanticCurationObservation).toMatchObject({ reason: "applied", applied: true });
    expect(JSON.stringify(source)).toBe(before);
    expect(requests).toHaveLength(1);
  });
  it("makes no call without attestation or model-specific calibration", async () => {
    const { requests } = installDecisionFixture();
    for (const [source, opts] of [
      [fixture(), applyOptions()],
      [candidate(), { ...applyOptions(), modelId: "unmeasured-model" }],
      [
        candidate(),
        { ...applyOptions(), config: { mode: "apply" as const, minEstimatedTokens: 1 } },
      ],
    ] as const) {
      const result = await observeSemanticTurnContext(source, opts);
      expect(result.messages).toBe(source.messages);
      expect(result.semanticCurationObservation?.reason).toBe("missing-owner-or-economics");
    }
    expect(requests).toHaveLength(0);
  });
  it("never splits frames or drops owner-declared required identifiers", async () => {
    const { requests } = installDecisionFixture();
    const partial = candidate();
    partial.semanticCurationCandidates!.discretionaryMessageIndexes = [2];
    const identifier = candidate();
    identifier.semanticCurationCandidates!.requiredIdentifiers = ["health check"];
    for (const source of [partial, identifier]) {
      const result = await observeSemanticTurnContext(source, applyOptions());
      expect(result.messages).toBe(source.messages);
      expect(result.semanticCurationObservation?.applied).toBe(false);
    }
    expect(requests).toHaveLength(0);
  });
  it("protects unfinished, synthetic-result, and failed tool frames despite owner hints", async () => {
    const { requests } = installDecisionFixture();
    const missing = candidate();
    missing.messages.splice(2, 1);
    missing.semanticCurationCandidates!.discretionaryMessageIndexes = [1];
    const failed = candidate();
    const assistant = failed.messages[1];
    if (assistant?.role === "assistant") {
      assistant.stopReason = "aborted";
    }
    const synthetic = candidate();
    const tool = synthetic.messages[2];
    if (tool?.role === "toolResult") {
      tool.isError = true;
      tool.details = { openclawSyntheticMissingToolResult: true };
    }
    for (const source of [missing, failed, synthetic]) {
      const result = await observeSemanticTurnContext(source, applyOptions());
      expect(result.messages).toBe(source.messages);
      expect(result.semanticCurationObservation?.applied).toBe(false);
    }
    expect(requests).toHaveLength(0);
  });
  it("skips inference when cache losses outweigh even maximal savings", async () => {
    const { requests } = installDecisionFixture();
    const opts = applyOptions();
    opts.config.economics.cachePenaltyMs = 1e9;
    const source = candidate();
    const result = await observeSemanticTurnContext(source, opts);
    expect(result.messages).toBe(source.messages);
    expect(result.semanticCurationObservation?.reason).toBe("uneconomic-before-decision");
    expect(requests).toHaveLength(0);
  });
  it("retains original context when confidence is below the configured floor", async () => {
    const source = candidate();
    const runtime: DecisionRuntimeV1 = {
      evaluate: async (batch) => ({
        status: "ok",
        provenance: {
          providerId: "fixture",
          rubricVersion: "fixture",
          runtimeGeneration: "fixture",
        },
        result: {
          model: "fixture",
          answers: Object.fromEntries(
            Object.keys(batch.questions).map((id) => [
              id,
              {
                type: "choice",
                choice: "drop",
                probabilities: { drop: 0.8, keep: 0.1, uncertain: 0.1 },
              },
            ]),
          ),
        },
      }),
    };
    const result = await observeSemanticTurnContext(source, applyOptions(), runtime);
    expect(result.messages).toBe(source.messages);
    expect(result.semanticCurationObservation?.reason).toBe("incomplete-selection");
  });
  it.each(["withdrawn", "aborted"] as const)(
    "retains the custom assembled view after %s input changes",
    async (change) => {
      const source = candidate();
      installDecisionFixture("preserved", () => {
        if (change === "withdrawn") {
          delete source.semanticCurationCandidates;
        } else {
          const assistant = source.messages[1];
          if (assistant?.role === "assistant") {
            assistant.stopReason = "aborted";
          }
        }
      });
      const result = await observeSemanticTurnContext(source, applyOptions());
      expect(result.messages).toBe(source.messages);
      expect(result.semanticCurationObservation?.reason).toBe("stale-source");
    },
  );
  it("rejects owner metadata that changed while the Decision was in flight", async () => {
    const source = candidate();
    installDecisionFixture("preserved", () => {
      source.semanticCurationCandidates!.requiredIdentifiers.push("health");
    });
    const result = await observeSemanticTurnContext(source, applyOptions());
    expect(result.messages).toBe(source.messages);
    expect(result.semanticCurationObservation?.reason).toBe("stale-source");
  });
  it("retains unavailable context and propagates caller cancellation", async () => {
    const source = candidate();
    const result = await observeSemanticTurnContext(source, applyOptions(), unavailable);
    expect(result.messages).toBe(source.messages);
    const controller = new AbortController();
    installDecisionFixture("preserved", () => controller.abort(new Error("stop apply")));
    await expect(
      observeSemanticTurnContext(source, { ...applyOptions(), signal: controller.signal }),
    ).rejects.toThrow("stop apply");
  });
});
