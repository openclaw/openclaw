import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { registerContextEngineForOwner } from "../../context-engine/registry.js";
import { captureContextEngineRegistryStateForTests } from "../../context-engine/registry.test-support.js";
import { createAgentCleanupScope } from "../run-cleanup-timeout.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { createDirectHarness, makeResult } from "./run-entry.test-support.js";

afterEach(() => clearRuntimeConfigSnapshot());

it.each([
  { kind: "command-rpc", settlement: "success" },
  { kind: "channel-delivery", settlement: "failure" },
  { kind: "command-rpc", settlement: "late-success" },
  { kind: "channel-delivery", settlement: "late-failure" },
] as const)(
  "settles $kind replies and cleanup ownership for $settlement",
  async ({ kind, settlement }) => {
    const cfg = { plugins: { slots: { contextEngine: "cleanup-probe" } } };
    setRuntimeConfigSnapshot(cfg);
    const restoreRegistry = captureContextEngineRegistryStateForTests();
    const disposal = createDeferred();
    const disposalStarted = createDeferred();
    const dispose = vi.fn(async () => {
      disposalStarted.resolve();
      await disposal.promise;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "25");
    await registerContextEngineForOwner(
      "cleanup-probe",
      () => ({
        info: { id: "cleanup-probe", name: "Cleanup probe" },
        ingest: async () => ({ ingested: false }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        dispose,
      }),
      "test:cleanup-probe",
    );
    const cleanupScope = createAgentCleanupScope();
    let completed: Awaited<ReturnType<typeof runEmbeddedAgentEntry>> | undefined;
    const entry = cleanupScope
      .run(() =>
        runEmbeddedAgentEntry({
          selection: {
            cfg,
            provider: "synthetic",
            model: "synthetic-model",
            fallbacksOverride: [],
          },
          identity: { runId: "cleanup-run", agentId: "main", sessionId: "cleanup-session" },
          harness: createDirectHarness(process.cwd(), "openclaw"),
          behavior:
            kind === "command-rpc"
              ? { kind, hasCommittedSideEffect: () => false }
              : {
                  kind,
                  readDeliveryEvidence: () => ({
                    hasDirectlySentBlockReply: false,
                    hasBlockReplyPipelineOutput: false,
                    hasRetryBlockedDelivery: false,
                  }),
                },
          sessionOverride: { kind: "preserve" },
          runCandidate: async (provider, model) =>
            makeResult({
              provider,
              model,
              sessionId: "cleanup-session",
              text: "Completed answer",
            }),
        }),
      )
      .then((result) => (completed = result));
    try {
      await awaitGateBeforeSettlement(
        disposalStarted.promise,
        entry,
        "Agent entry settled before context engine disposal started",
      );
      if (settlement === "success") {
        disposal.resolve();
      } else if (settlement === "failure") {
        disposal.reject(new Error("Context engine disposal failed"));
      }
      await vi.advanceTimersByTimeAsync(25);
      expect(completed?.result.payloads).toEqual([{ text: "Completed answer" }]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(cleanupScope.outcome).toBe(settlement === "success" ? "closed" : "uncertain");
      if (settlement.startsWith("late-")) {
        expect(warn).toHaveBeenCalledWith(
          "agent cleanup timed out: runId=cleanup-run sessionId=cleanup-session step=context-engine-dispose timeoutMs=25",
        );
        if (settlement === "late-failure") {
          disposal.reject(new Error("Context engine disposal failed after timeout"));
        } else {
          disposal.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(cleanupScope.outcome).toBe("uncertain");
      }
    } finally {
      disposal.resolve();
      await entry.catch(() => {});
      vi.useRealTimers();
      vi.unstubAllEnvs();
      warn.mockRestore();
      await restoreRegistry();
    }
  },
);
