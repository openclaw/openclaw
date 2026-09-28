import { expect, it, vi } from "vitest";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { initialAttemptOptions, type FallbackRunnerParams } from "./run-entry.test-support.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runFallback = vi.hoisted(() => vi.fn());
vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => runFallback(params),
}));

it.each(["uncertain", "confirmed", "released", "stop-reason"] as const)(
  "runEmbeddedAgentEntry rechecks %s delivery after result classification",
  async (settlement) => {
    const evidence = {
      hasDirectlySentBlockReply: false,
      hasBlockReplyPipelineOutput: false,
      hasRetryBlockedDelivery: false,
    };
    runFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      evidence.hasRetryBlockedDelivery = settlement === "uncertain" || settlement === "stop-reason";
      evidence.hasDirectlySentBlockReply = settlement === "confirmed";
      const classification = await params.classifyResult?.({
        result,
        provider: params.provider,
        model: params.model,
        attempt: 1,
        total: 2,
      });
      if (settlement === "released") {
        expect(classification).toMatchObject({ code: "empty_result" });
      } else if (settlement === "stop-reason") {
        expect(classification).toEqual({ stopReason: "agent_run_terminal_timeout" });
      } else {
        expect(classification).toBeUndefined();
      }
      return {
        outcome: "completed" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-delivery", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: process.cwd(),
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => "openclaw",
      },
      behavior: { kind: "channel-delivery", readDeliveryEvidence: () => evidence },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        const result: EmbeddedAgentRunResult = {
          payloads: [],
          meta: {
            durationMs: 1,
            providerStarted: true,
            agentHarnessResultClassification: "empty",
            agentMeta: { sessionId: "session-1", provider, model },
          },
        };
        evidence.hasRetryBlockedDelivery = true;
        expect(options.classifyResult(result)).toBeUndefined();
        evidence.hasRetryBlockedDelivery = false;
        expect(options.classifyResult(result)).toMatchObject({ code: "empty_result" });
        evidence.hasRetryBlockedDelivery = true;
        expect(options.classifyResult(result)).toBeUndefined();
        evidence.hasRetryBlockedDelivery = false;
        expect(options.classifyResult(result)).toMatchObject({ code: "empty_result" });
        if (settlement === "stop-reason") {
          result.meta.modelFallbackStopReason = "agent_run_terminal_timeout";
        }
        return result;
      },
    });
  },
);
