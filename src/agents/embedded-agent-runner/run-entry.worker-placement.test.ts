import { describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertSupportedTurn } from "../../gateway/worker-environments/worker-turn-payload.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import { runEmbeddedAgentEntry, setupRunEntryTestState } from "./run-entry.test-harness.js";
import { createDirectHarness, makeResult } from "./run-entry.test-support.js";

const state = setupRunEntryTestState();

describe("runEmbeddedAgentEntry worker placement", () => {
  it.each(["provider replacement", "cancellation", "lifecycle rotation"] as const)(
    "rejects %s while preparing the placement runtime",
    async (change) => {
      const started = createDeferred();
      const runtime = createDeferred<string | undefined>();
      const provider = {
        assertCompactionSuccessorAllowed: () => {},
        resolveRuntimeOverride: async () => {
          started.resolve();
          return runtime.promise;
        },
        executeLocalTurn: async <T>(_claim: unknown, run: () => Promise<T>) => run(),
        executeTurn: vi.fn(),
      };
      onTestFinished(installSessionPlacementAdmissionProvider(provider));
      const abort = new AbortController();
      const runCandidate = vi.fn(async () => makeResult({ provider: "primary", model: "model" }));
      const entry = runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "primary", model: "model" },
        identity: {
          runId: "run-placement-preparation",
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:chat",
        },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        abortSignal: abort.signal,
        runCandidate,
      });
      const settled = entry.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          started.promise,
          entry,
          "entry bypassed placement selection",
        );
        if (change === "provider replacement") {
          onTestFinished(installSessionPlacementAdmissionProvider({ ...provider }));
        } else if (change === "cancellation") {
          abort.abort(new Error("runtime preparation cancelled"));
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        runtime.resolve("openclaw");
        await expect(entry).rejects.toThrow();
        expect(runCandidate).not.toHaveBeenCalled();
        expect(state.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
      } finally {
        runtime.resolve(undefined);
        await settled;
      }
    },
  );

  it.each(["implicit", "session", "configured"] as const)(
    "keeps worker fallback preparation and execution on its placement runtime (%s selection)",
    async (selection) => {
      const requestedRuntime = selection === "session" ? "codex" : undefined;
      const cfg: OpenClawConfig =
        selection === "configured"
          ? {
              agents: {
                defaults: {
                  models: { "primary-provider/primary-model": { agentRuntime: { id: "codex" } } },
                },
              },
            }
          : {};
      const placement = {
        assertCompactionSuccessorAllowed: () => {},
        resolveRuntimeOverride: vi.fn(async () => "openclaw"),
        executeLocalTurn: async <T>(_claim: unknown, run: () => Promise<T>) => run(),
        executeTurn: vi.fn(),
      };
      onTestFinished(installSessionPlacementAdmissionProvider(placement));
      const entry = runEmbeddedAgentEntry({
        selection: { cfg, provider: "primary-provider", model: "primary-model" },
        identity: {
          runId: "run-worker-fallback",
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:chat",
        },
        harness: { ...createDirectHarness(), resolveRuntimeOverride: () => requestedRuntime },
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          assertSupportedTurn({
            sessionId: "session-1",
            sessionFile: "/tmp/worker-fallback.sqlite",
            workspaceDir: "/tmp/workspace",
            runId: "run-worker-fallback",
            prompt: "Continue",
            timeoutMs: 1_000,
            provider,
            model,
            agentHarnessRuntimeOverride:
              options.agentHarnessRuntimeOverride ??
              (selection === "implicit"
                ? options.isFallbackRetry
                  ? "codex"
                  : "openclaw"
                : undefined),
            config: cfg,
          });
          return makeResult({
            provider,
            model,
            ...(options.isFallbackRetry ? {} : { classification: "empty" as const }),
          });
        },
      });
      if (selection !== "implicit") {
        await expect(entry).rejects.toThrow(
          "Cloud worker turns require the OpenClaw runtime, not codex",
        );
      } else {
        await expect(entry).resolves.toMatchObject({
          outcome: "completed",
          model: "fallback-model",
        });
        expect(placement.resolveRuntimeOverride).toHaveBeenCalledOnce();
      }
      for (const [prepared] of state.ensureSelectedAgentHarnessPlugin.mock.calls) {
        if (selection !== "configured") {
          expect(prepared).toMatchObject({
            agentHarnessRuntimeOverride: requestedRuntime ?? "openclaw",
          });
        }
      }
    },
  );
});
