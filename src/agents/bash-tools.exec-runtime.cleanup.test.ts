import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  acknowledgeNotifyOnExit,
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  markBackgrounded,
  waitForExecScope,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";
import type { SandboxBackendHandle } from "./sandbox/backend-handle.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventWithReceiptMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventWithReceipt: enqueueSystemEventWithReceiptMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
beforeAll(async () => {
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});
beforeEach(() => {
  resetProcessRegistryForTests();
  requestHeartbeatMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReturnValue(vi.fn(() => true));
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

describe("terminal execution-context release", () => {
  it.each([
    { path: "notify", trace: ["task", "enqueue", "wake"] },
    { path: "quiet", trace: ["task"] },
    { path: "unrouted", trace: ["task"] },
    { path: "observed", trace: ["task"] },
    { path: "task failure", trace: ["task", "task"] },
    { path: "enqueue failure", trace: ["task", "enqueue", "task"] },
    { path: "wake failure", trace: ["task", "enqueue", "wake", "task"] },
  ])(
    "releases routing after $path without changing notification order",
    async ({ path, trace }) => {
      const exit = createDeferred<RunExit>();
      const observed: string[] = [];
      const removal = vi.fn(() => true);
      const deliveryContext = { channel: "telegram", to: "synthetic-chat" };
      const failure = new Error("notification boundary failed");
      enqueueSystemEventWithReceiptMock.mockImplementation((_text, options) => {
        observed.push("enqueue");
        expect(options.deliveryContext).toEqual(deliveryContext);
        if (path === "enqueue failure") {
          throw failure;
        }
        return removal;
      });
      requestHeartbeatMock.mockImplementation(() => {
        observed.push("wake");
        if (path === "wake failure") {
          throw failure;
        }
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, path === "quiet" ? "" : "retained output\n"),
        wait: () => exit.promise,
      }));
      const run = await runExecProcess({
        command: "context-release",
        workdir: "/tmp",
        env: {},
        usePty: false,
        warnings: [],
        maxOutput: 1_000,
        pendingMaxOutput: 1_000,
        scopeKey: "process-scope",
        sessionKey: path === "unrouted" ? undefined : "agent:main:main",
        agentId: "main",
        eventRouting: { mainKey: "main", sessionScope: "per-sender" },
        notifyDeliveryContext: deliveryContext,
        notifyOnExit: true,
        notifyOnExitEmptySuccess: false,
        timeoutSec: null,
        onSettledBeforeNotify: () => {
          observed.push("task");
          if (path === "task failure" && observed.length === 1) {
            throw failure;
          }
        },
      });
      markBackgrounded(run.session);
      if (path === "observed") {
        acknowledgeNotifyOnExit(run.session);
      }
      exit.resolve(createRunExit());
      const outcome = await run.promise;
      expect(observed).toEqual(trace);
      expect(outcome.status).toBe(path.endsWith("failure") ? "failed" : "completed");
      const retained = getFinishedSession(run.session.id);
      expect(retained).toMatchObject({ scopeKey: "process-scope", terminalStatus: "completed" });
      for (const field of [
        "sessionKey",
        "agentId",
        "eventRouting",
        "notifyDeliveryContext",
        "notifyOnExit",
        "notifyOnExitEmptySuccess",
        "stdin",
      ] as const) {
        expect(retained?.[field], field).toBeUndefined();
      }
      expect(retained?.notifyOnExitRemoval).toBe(trace.includes("wake") ? removal : undefined);
      expect(removal).not.toHaveBeenCalled();
    },
  );
});

describe("exec settlement recovery", () => {
  it.each([
    { boundary: "task", asynchronous: false },
    { boundary: "persistent task", asynchronous: false },
    { boundary: "enqueue", asynchronous: false },
    { boundary: "wake", asynchronous: false },
    { boundary: "task", asynchronous: true },
    { boundary: "persistent task", asynchronous: true },
    { boundary: "stdin", asynchronous: true },
    { boundary: "enqueue", asynchronous: true },
    { boundary: "wake", asynchronous: true },
  ])(
    "settles $boundary failure with asynchronous=$asynchronous before releasing the exec scope",
    async ({ boundary, asynchronous }) => {
      const exit = createDeferred<RunExit>();
      const settlementStarted = createDeferred();
      const settlement = createDeferred();
      const correctionStarted = createDeferred();
      const correction = createDeferred();
      const observed: string[] = [];
      const identities: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
      const scopeKey = `settlement-recovery:${boundary}:${asynchronous}`;
      const failure = new Error("process settlement failed");
      enqueueSystemEventWithReceiptMock.mockImplementation(() => {
        observed.push("enqueue");
        if (boundary === "enqueue") {
          throw failure;
        }
        return vi.fn(() => true);
      });
      requestHeartbeatMock.mockImplementation(() => {
        observed.push("wake");
        if (boundary === "wake") {
          throw failure;
        }
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, "process output\n"),
        wait: () => exit.promise,
      }));
      const run = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:settlement-recovery" },
        () =>
          runExecProcess({
            command: "settlement-recovery",
            workdir: "/tmp",
            env: {},
            usePty: false,
            warnings: [],
            maxOutput: 1000,
            pendingMaxOutput: 1000,
            scopeKey,
            sessionKey: "agent:main:settlement-recovery",
            notifyOnExit: true,
            timeoutSec: null,
            onSettledBeforeNotify: (outcome) => {
              observed.push(`task:${outcome.status}`);
              identities.push(getGatewayToolCallerIdentity());
              if (!asynchronous) {
                if (
                  boundary === "persistent task" ||
                  (boundary === "task" && observed.length === 1)
                ) {
                  throw failure;
                }
                return undefined;
              }
              if (outcome.status === "failed") {
                correctionStarted.resolve();
                return correction.promise.then(() => {
                  if (boundary === "persistent task") {
                    throw failure;
                  }
                });
              }
              settlementStarted.resolve();
              const pending = settlement.promise.then(() => {
                if (boundary === "task" || boundary === "persistent task") {
                  throw failure;
                }
              });
              void pending.catch(() => {});
              return pending;
            },
          }),
      );
      if (boundary === "stdin") {
        run.session.stdin = {
          write: vi.fn(),
          end: vi.fn(),
          destroy() {
            observed.push("stdin");
            throw failure;
          },
        };
      }
      markBackgrounded(run.session);
      const joined = waitForExecScope(scopeKey).then(() => observed.push("scope-released"));
      exit.resolve(createRunExit());
      try {
        if (asynchronous) {
          await settlementStarted.promise;
          expect(run.session.finalizing).toBe(true);
          expect(run.session.exited).toBe(false);
          expect(getActiveBackgroundExecSessionCount()).toBe(1);
          expect(observed).toEqual(["task:completed"]);
          settlement.resolve();
          await correctionStarted.promise;
          expect(run.session.finalizing).toBe(true);
          expect(getActiveBackgroundExecSessionCount()).toBe(1);
          expect(observed).not.toContain("scope-released");
          correction.resolve();
        }
        if (boundary === "persistent task") {
          await expect(run.promise).rejects.toBe(failure);
        } else {
          await expect(run.promise).resolves.toMatchObject({ status: "failed" });
        }
        await joined;
        expect(observed).toEqual([
          "task:completed",
          ...(boundary === "stdin" ? ["stdin"] : []),
          ...(boundary === "enqueue" || boundary === "wake" ? ["enqueue"] : []),
          ...(boundary === "wake" ? ["wake"] : []),
          "task:failed",
          "scope-released",
        ]);
        expect(identities).toEqual([undefined, undefined]);
        expect(getActiveBackgroundExecSessionCount()).toBe(0);
        expect(run.session.finalizing).toBe(false);
        expect(run.session.terminalStatus).toBe("completed");
        if (boundary !== "stdin") {
          expect(getFinishedSession(run.session.id)).toMatchObject({
            terminalStatus: "completed",
            aggregated: "process output\n",
          });
        }
        expect(run.session.sessionKey).toBeUndefined();
      } finally {
        settlement.resolve();
        correction.resolve();
        await Promise.allSettled([run.promise, joined]);
      }
    },
  );
});
