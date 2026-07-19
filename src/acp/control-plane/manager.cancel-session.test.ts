/** Tests ACP manager cancellation of active turns and idle sessions. */
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  mockCallArg,
} from "./manager.test-helpers.js";

describe("AcpSessionManager cancelSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("preempts an active turn on cancel and returns to idle state", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: "runtime-1",
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-1",
        parentSessionKey: "agent:main:main",
      });

      let enteredRun = false;
      runtimeState.runTurn.mockImplementation(async function* (input: { signal?: AbortSignal }) {
        enteredRun = true;
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done" as const, stopReason: "cancel" };
      });

      const manager = new AcpSessionManager();
      const runPromise = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "long task",
        mode: "prompt",
        requestId: "run-1",
      });
      await vi.waitFor(
        () => {
          expect(enteredRun).toBe(true);
        },
        { interval: 1 },
      );

      const resolution = manager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
      });
      if (resolution.kind !== "ready" || !resolution.entry?.sessionId) {
        throw new Error("expected active ACP session metadata");
      }
      const expectedTarget = {
        sessionId: resolution.entry.sessionId,
        backend: resolution.meta.backend,
        agent: resolution.meta.agent,
        runtimeSessionName: resolution.meta.runtimeSessionName,
        ...(resolution.meta.identity ? { identity: resolution.meta.identity } : {}),
      };
      await expect(
        manager.cancelSession({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-1",
          reason: "stale-cancel",
          expectedTarget: {
            ...expectedTarget,
            runtimeSessionName: "replacement-runtime",
          },
        }),
      ).resolves.toBe(false);
      expect(runtimeState.cancel).not.toHaveBeenCalled();

      await expect(
        manager.cancelSession({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-1",
          reason: "manual-cancel",
          expectedTarget,
        }),
      ).resolves.toBe(true);
      await runPromise;

      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(runtimeState.cancel), {
        reason: "manual-cancel",
      });
      expectRecordFields(requireTaskByRunId("run-1"), {
        ownerKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child-1",
        status: "cancelled",
      });
      const states = extractStatesFromUpserts();
      expect(states).toContain("running");
      expect(states).toContain("idle");
      expect(states).not.toContain("error");
    });
  });
});
