import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertSupportedTurn } from "../../gateway/worker-environments/worker-turn-payload.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import { runEmbeddedAgentEntry, setupRunEntryTestState } from "./run-entry.test-harness.js";
import { createDirectHarness, makeResult } from "./run-entry.test-support.js";

const state = setupRunEntryTestState();

describe("runEmbeddedAgentEntry worker placement", () => {
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
        resolveRuntimeOverride: vi.fn(() => "openclaw"),
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
