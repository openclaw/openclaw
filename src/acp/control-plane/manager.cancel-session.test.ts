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

      await manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        reason: "manual-cancel",
      });
      await runPromise;

      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
      expect(runtimeState.close).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(runtimeState.cancel), {
        reason: "manual-cancel",
      });
      expect(manager.getObservabilitySnapshot(baseCfg).runtimeCache.activeSessions).toBe(0);
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

  it("closes the runtime handle when protocol cancellation fails", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.cancel.mockRejectedValueOnce(new Error("protocol cancel failed"));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-cancel-failure",
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
        sessionKey: "agent:codex:acp:child-cancel-failure",
        text: "long task",
        mode: "prompt",
        requestId: "run-cancel-failure",
      });
      await vi.waitFor(() => expect(enteredRun).toBe(true), { interval: 1 });

      await manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-cancel-failure",
        reason: "manual-cancel",
      });
      await runPromise;

      expect(runtimeState.close).toHaveBeenCalledTimes(1);
      expect(manager.getObservabilitySnapshot(baseCfg).runtimeCache.activeSessions).toBe(0);
    });
  });

  it("does not let a never-settling protocol cancel block runtime close", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.cancel.mockImplementationOnce(async () => await new Promise<void>(() => {}));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-hanging-cancel",
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
        sessionKey: "agent:codex:acp:child-hanging-cancel",
        text: "long task",
        mode: "prompt",
        requestId: "run-hanging-cancel",
      });
      await vi.waitFor(() => expect(enteredRun).toBe(true), { interval: 1 });

      const cancelOutcome = await Promise.race([
        manager
          .cancelSession({
            cfg: baseCfg,
            sessionKey: "agent:codex:acp:child-hanging-cancel",
            reason: "manual-cancel",
          })
          .then(() => "closed"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      await runPromise;

      expect(cancelOutcome).toBe("closed");
      expect(runtimeState.close).toHaveBeenCalledTimes(1);
      expect(manager.getObservabilitySnapshot(baseCfg).runtimeCache.activeSessions).toBe(0);
    });
  });

  it("surfaces runtime close failures and clears the cached handle", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.close.mockRejectedValueOnce(new Error("lease drain failed"));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-close-failure",
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
        sessionKey: "agent:codex:acp:child-close-failure",
        text: "long task",
        mode: "prompt",
        requestId: "run-close-failure",
      });
      await vi.waitFor(() => expect(enteredRun).toBe(true), { interval: 1 });

      await expect(
        manager.cancelSession({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-close-failure",
          reason: "manual-cancel",
        }),
      ).rejects.toThrow("lease drain failed");
      await runPromise;

      expect(manager.getObservabilitySnapshot(baseCfg).runtimeCache.activeSessions).toBe(0);
    });
  });
});
