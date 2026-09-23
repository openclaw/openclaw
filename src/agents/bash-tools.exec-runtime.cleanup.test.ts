import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedRun, SpawnInput } from "../process/supervisor/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { markBackgrounded, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";
import type { SandboxBackendHandle } from "./sandbox/backend-handle.types.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
beforeAll(async () => {
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});
beforeEach(() => {
  resetProcessRegistryForTests();
  supervisorMock.spawn.mockReset();
});
afterEach(() => {
  resetProcessRegistryForTests();
});

it.each([
  { reason: "manual-cancel" as const, cleanupFails: false, duringFinalize: false },
  { reason: "overall-timeout" as const, cleanupFails: true, duringFinalize: false },
  { reason: "manual-cancel" as const, cleanupFails: false, duringFinalize: true },
])(
  "starts and joins targeted sandbox cleanup for $reason (duringFinalize=$duringFinalize)",
  async ({ reason, cleanupFails, duringFinalize }) => {
    const termination = createDeferred();
    const artifactFinalization = createDeferred();
    const artifactsEntered = createDeferred();
    const guestExit = createDeferred<ReturnType<typeof createRunExit>>();
    const otherExit = createDeferred<ReturnType<typeof createRunExit>>();
    const releaseSource = vi.fn();
    const cleanupError = new Error("targeted process cleanup failed");
    const makeSandbox = (marker: string) => {
      const terminate = vi.fn(async () => {
        await termination.promise;
        if (cleanupFails && marker === "guest") {
          throw cleanupError;
        }
      });
      return {
        containerName: "shared-fixture",
        workspaceDir: "/workspace",
        containerWorkdir: "/workspace",
        prepareProcessCleanup: (env: Record<string, string>) => ({
          env: { ...env, CODEX_SANDBOX_EXEC_ID: marker },
          terminate,
          interrupt: async () => false,
        }),
        buildExecSpec: vi.fn(
          async ({ env }: Parameters<SandboxBackendHandle["buildExecSpec"]>[0]) => ({
            argv: ["sandbox-fixture"],
            env,
            stdinMode: "pipe-closed" as const,
            finalizeToken: marker,
          }),
        ),
        finalizeExec: vi.fn(async () => {
          if (marker === "guest" && duringFinalize) {
            artifactsEntered.resolve();
            await artifactFinalization.promise;
          }
        }),
        terminate,
      };
    };
    const sandbox = makeSandbox("guest");
    const otherSandbox = makeSandbox("independent");
    let guestInput: SpawnInput | undefined;
    const cancelOther = vi.fn();
    supervisorMock.spawn
      .mockImplementationOnce(async (input: SpawnInput) => {
        guestInput = input;
        return {
          ...runtimeManagedRun(input),
          cancel: () => input.onCancel?.("manual-cancel"),
          wait: () => guestExit.promise,
        };
      })
      .mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input),
        cancel: cancelOther,
        wait: () => otherExit.promise,
      }));
    const options = {
      command: "sandbox-fixture",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
    };
    const originalSource = new AbortController();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      signal: originalSource.signal,
      assertCurrent: () => originalSource.signal.throwIfAborted(),
      retain: () => releaseSource,
    });
    const guest = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:targeted-cleanup", operatorAuthority: authority },
      () => runExecProcess({ ...options, scopeKey: "targeted-cleanup:guest", sandbox }),
    );
    const other = await runExecProcess({ ...options, sandbox: otherSandbox });
    markBackgrounded(guest.session);
    markBackgrounded(other.session);
    try {
      expect(sandbox.buildExecSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ CODEX_SANDBOX_EXEC_ID: "guest" }),
        }),
      );
      if (duringFinalize) {
        guestExit.resolve(createRunExit());
        await artifactsEntered.promise;
        originalSource.abort(new Error("original invitation revoked during artifact finalization"));
      } else if (reason === "manual-cancel") {
        guest.kill();
      } else {
        guestInput?.onCancel?.(reason);
      }
      await Promise.resolve();
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(otherSandbox.terminate).not.toHaveBeenCalled();
      expect(cancelOther).not.toHaveBeenCalled();
      guestExit.resolve(
        createRunExit({ reason, exitCode: null, timedOut: reason === "overall-timeout" }),
      );
      let settled = false;
      const joined = guest.promise.then((outcome) => {
        settled = true;
        return outcome;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(guest.session.exited).toBe(false);
      expect(sandbox.finalizeExec).toHaveBeenCalledTimes(duringFinalize ? 1 : 0);
      expect(releaseSource).not.toHaveBeenCalled();
      if (duringFinalize) {
        artifactFinalization.resolve();
        otherExit.resolve(createRunExit());
        await other.promise;
        expect(settled).toBe(false);
        expect(guest.session.exited).toBe(false);
        expect(releaseSource).not.toHaveBeenCalled();
      }
      termination.resolve();
      const outcome = await joined;
      expect(outcome.status).toBe(duringFinalize ? "completed" : "failed");
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(sandbox.finalizeExec).toHaveBeenCalledOnce();
      expect(releaseSource).toHaveBeenCalledOnce();
      if (cleanupFails) {
        expect(guest.session.finalizationFailed).toBe(true);
        expect(outcome.aggregated).toContain(cleanupError.message);
      }
      expect(other.session.exited).toBe(duringFinalize);
      otherExit.resolve(createRunExit());
      await expect(other.promise).resolves.toMatchObject({ status: "completed" });
      expect(otherSandbox.terminate).not.toHaveBeenCalled();
      expect(otherSandbox.finalizeExec).toHaveBeenCalledOnce();
    } finally {
      artifactFinalization.resolve();
      termination.resolve();
      guestExit.resolve(createRunExit());
      otherExit.resolve(createRunExit());
      await Promise.all([guest.promise, other.promise]);
    }
  },
);

it("joins targeted sandbox cleanup on startup failure and still finalizes artifacts", async () => {
  const termination = createDeferred();
  const terminate = vi.fn(() => termination.promise);
  const finalizeExec = vi.fn(async () => {});
  supervisorMock.spawn.mockRejectedValueOnce(new Error("transport construction failed"));
  const sandbox = {
    containerName: "startup-fixture",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
    prepareProcessCleanup: (env: Record<string, string>) => ({
      env,
      terminate,
      interrupt: async () => false,
    }),
    buildExecSpec: async () => ({
      argv: ["sandbox-fixture"],
      env: {},
      stdinMode: "pipe-closed" as const,
    }),
    finalizeExec,
  };
  const pending = runExecProcess({
    command: "sandbox-fixture",
    workdir: "/tmp",
    env: {},
    sandbox,
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: null,
  });
  const rejected = expect(pending).rejects.toThrow("transport construction failed");
  try {
    termination.resolve();
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledOnce();
  } finally {
    termination.resolve();
    await pending.catch(() => {});
  }
});

it.each([
  { fails: false, beforeJoin: false, commandCode: 0 },
  { fails: true, beforeJoin: false, commandCode: 0 },
  { fails: true, beforeJoin: true, commandCode: 0 },
  { fails: true, beforeJoin: false, commandCode: 127 },
])(
  "joins sandbox artifacts and retains cleanup failure (fails=$fails, beforeJoin=$beforeJoin, commandCode=$commandCode)",
  async ({ fails, beforeJoin, commandCode }) => {
    const finalization = createDeferred();
    const entered = createDeferred();
    const cleanupScope = createAgentCleanupScope();
    const scopeKey = "scope:sandbox-artifact-cleanup";
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput): Promise<ManagedRun> => ({
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      runId: input.runId ?? "test-run",
      pid: 1234,
      startedAtMs: Date.now(),
      stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
      cancel: vi.fn(),
      wait: async () => ({
        reason: "exit",
        exitCode: commandCode,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    }));
    let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
    const finalizeExec = vi.fn(async () => {
      entered.resolve();
      await finalization.promise;
      if (fails) {
        throw new Error("sandbox artifact cleanup failed");
      }
    });
    try {
      await cleanupScope.run(async () => {
        run = await runExecProcess({
          command: "sandbox-fixture",
          workdir: "/tmp",
          env: {},
          scopeKey,
          sandbox: {
            containerName: "fixture",
            workspaceDir: "/workspace",
            containerWorkdir: "/workspace",
            buildExecSpec: async () => ({
              argv: ["sandbox-fixture"],
              env: {},
              stdinMode: "pipe-closed",
            }),
            finalizeExec,
          },
          usePty: false,
          warnings: [],
          maxOutput: 1000,
          pendingMaxOutput: 1000,
          notifyOnExit: false,
          timeoutSec: null,
        });
        markBackgrounded(run.session);
        await entered.promise;
        if (beforeJoin) {
          finalization.resolve();
          await run.promise;
        }
        let joined = false;
        const join = waitForExecScope(scopeKey).then(() => {
          joined = true;
        });
        if (!beforeJoin) {
          await Promise.resolve();
          expect(joined).toBe(false);
          expect(run.session.finalizing).toBe(true);
          finalization.resolve();
        }
        await join;
        const outcome = await run.promise;
        expect(outcome.status).toBe(fails || commandCode !== 0 ? "failed" : "completed");
        expect(finalizeExec).toHaveBeenCalledOnce();
      });
      expect(cleanupScope.outcome).toBe(fails ? "uncertain" : "closed");
    } finally {
      finalization.resolve();
      await run?.promise;
    }
  },
);
