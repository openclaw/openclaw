import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  cancelExecRequestOwners,
  captureExecRequestOwners,
  withExecRequestTurn,
} from "../infra/exec-request-context.js";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { captureExecRequestCancellation } from "./bash-process-control.js";
import { readBackgroundProcesses } from "./bash-process-observation.js";
import {
  acknowledgeNotifyOnExit,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  markBackgrounded,
  waitForExecScope,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";
import type { SandboxBackendHandle } from "./sandbox/backend-handle.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
const enqueueSessionEventMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventWithReceiptMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));
// mock-isolation: Control completion receipts while testing process cancellation and cleanup.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: async (agentId: string, sessionKey: string) => ({
    agentId,
    sessionKey,
    sessionId: sessionKey,
    generation: "test",
  }),
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));
vi.mock(import("../infra/system-events.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueSystemEventWithReceipt: enqueueSystemEventWithReceiptMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

beforeEach(() => {
  resetProcessRegistryForTests();
  enqueueSessionEventMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReturnValue(vi.fn(() => true));
  supervisorMock.spawn.mockReset();
});
afterEach(() => {
  resetProcessRegistryForTests();
});

function runTestExecProcess(params: Partial<Parameters<typeof runExecProcess>[0]>) {
  return runExecProcess({
    command: "sandbox-fixture",
    workdir: "/tmp",
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: null,
    ...params,
  });
}

it.each([
  {
    reason: "manual-cancel" as const,
    cleanupFails: false,
    duringFinalize: false,
    requestStop: "none" as const,
  },
  {
    reason: "overall-timeout" as const,
    cleanupFails: true,
    duringFinalize: false,
    requestStop: "none" as const,
  },
  {
    reason: "manual-cancel" as const,
    cleanupFails: false,
    duringFinalize: true,
    requestStop: "none" as const,
  },
  {
    reason: "manual-cancel" as const,
    cleanupFails: false,
    duringFinalize: true,
    requestStop: "capture" as const,
  },
  {
    reason: "manual-cancel" as const,
    cleanupFails: true,
    duringFinalize: true,
    requestStop: "capture" as const,
  },
  {
    reason: "manual-cancel" as const,
    cleanupFails: true,
    duringFinalize: true,
    requestStop: "direct" as const,
  },
])(
  "starts and joins targeted sandbox cleanup for $reason (duringFinalize=$duringFinalize, requestStop=$requestStop, cleanupFails=$cleanupFails)",
  async ({ reason, cleanupFails, duringFinalize, requestStop }) => {
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
    const originalSource = new AbortController();
    const requestIdentity = {
      runId: "sandbox-request-stop",
      sessionKey: "agent:main:targeted-cleanup",
    };
    const request =
      requestStop !== "none"
        ? await withExecRequestTurn({ identity: requestIdentity }, async () => {
            const owner = captureExecRequestOwners(requestIdentity)?.[0];
            if (!owner) {
              throw new Error("Expected the sandbox command's request owner");
            }
            return { owner, cancellation: captureExecRequestCancellation(requestIdentity) };
          })
        : undefined;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      signal: originalSource.signal,
      assertCurrent: () => originalSource.signal.throwIfAborted(),
      retain: () => releaseSource,
    });
    const guest = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:targeted-cleanup", operatorAuthority: authority },
      () =>
        runTestExecProcess({
          scopeKey: "targeted-cleanup:guest",
          sandbox,
          requestOwners: request ? [request.owner] : undefined,
        }),
    );
    const other = await runTestExecProcess({ sandbox: otherSandbox });
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
        if (request) {
          if (requestStop === "capture") {
            expect(request.cancellation.cancel()).toBe(true);
          } else {
            cancelExecRequestOwners([request.owner]);
          }
          expect(originalSource.signal.aborted).toBe(false);
          expect(guest.session.requestCancelled).toBe(true);
        } else {
          originalSource.abort(
            new Error("original invitation revoked during artifact finalization"),
          );
        }
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
      expect(outcome.status).toBe(duringFinalize && !cleanupFails ? "completed" : "failed");
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(sandbox.finalizeExec).toHaveBeenCalledOnce();
      expect(releaseSource).toHaveBeenCalledOnce();
      if (cleanupFails) {
        expect(guest.session.finalizationFailed).toBe(true);
        expect(outcome.aggregated).toContain(cleanupError.message);
      }
      if (request) {
        // The command registered after capture; output eviction cannot erase its cleanup verdict.
        deleteSession(guest.session.id);
        expect(getFinishedSession(guest.session.id)).toBeUndefined();
        if (cleanupFails) {
          await expect(request.cancellation.settle()).rejects.toThrow(
            "command cleanup could not be confirmed",
          );
        } else {
          await expect(request.cancellation.settle()).resolves.toBeUndefined();
        }
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

it.each([
  { fails: false, beforeJoin: false, commandCode: 0 },
  { fails: true, beforeJoin: true, commandCode: 0 },
  { fails: true, beforeJoin: false, commandCode: 127 },
])(
  "joins sandbox artifacts and retains cleanup failure (fails=$fails, beforeJoin=$beforeJoin, commandCode=$commandCode)",
  async ({ fails, beforeJoin, commandCode }) => {
    const finalization = createDeferred();
    const entered = createDeferred();
    const cleanupScope = createAgentCleanupScope();
    const scopeKey = "scope:sandbox-artifact-cleanup";
    const cleanupFailure =
      "sandbox artifact cleanup failed: API_TOKEN = computeToken(); Authorization: Bearer sk-fixture1234567890";
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput): Promise<ManagedRun> => ({
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      runId: input.runId ?? "test-run",
      pid: 1234,
      startedAtMs: Date.now(),
      stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
      cancel: vi.fn(),
      wait: async () => createRunExit({ exitCode: commandCode }),
    }));
    let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
    const finalizeExec = vi.fn(async () => {
      entered.resolve();
      await finalization.promise;
      if (fails) {
        throw new Error(cleanupFailure);
      }
    });
    try {
      await cleanupScope.run(async () => {
        run = await runTestExecProcess({
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
        if (fails) {
          expect(outcome.aggregated).toContain(cleanupFailure);
          expect(run.session.aggregated).toContain(cleanupFailure);
        }
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
    { path: "notify", trace: ["task", "enqueue"] },
    { path: "quiet", trace: ["task"] },
    { path: "unrouted", trace: ["task"] },
    { path: "observed", trace: ["task"] },
  ])(
    "releases routing after $path without changing notification order",
    async ({ path, trace }) => {
      const exit = createDeferred<RunExit>();
      const observed: string[] = [];
      const removal = vi.fn(() => true);
      const deliveryContext = { channel: "telegram", to: "synthetic-chat" };
      enqueueSessionEventMock.mockImplementation((_text, options) => {
        observed.push("enqueue");
        expect(options.deliveryContext).toEqual(deliveryContext);
        return {
          id: "exec-event",
          cancel: removal,
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
        };
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, path === "quiet" ? "" : "retained output\n"),
        wait: () => exit.promise,
      }));
      const run = await runTestExecProcess({
        command: "context-release",
        scopeKey: "global",
        sessionKey: path === "unrouted" ? undefined : "agent:main:main",
        agentId: "main",
        eventRouting: { mainKey: "main", sessionScope: "per-sender" },
        notifyDeliveryContext: deliveryContext,
        notifyOnExit: true,
        notifyOnExitEmptySuccess: false,
        onSettledBeforeNotify: () => {
          observed.push("task");
        },
      });
      markBackgrounded(run.session);
      const scope = { scopeKeys: ["global"], agentId: "main" };
      const running = readBackgroundProcesses(scope).processes[0];
      expect(running).toMatchObject({ processId: run.session.id, status: "running" });
      if (path === "observed") {
        acknowledgeNotifyOnExit(run.session);
      }
      exit.resolve(createRunExit());
      const outcome = await run.promise;
      expect(observed).toEqual(trace);
      expect(outcome.status).toBe("completed");
      const retained = getFinishedSession(run.session.id);
      expect(retained).toMatchObject({ scopeKey: "global", terminalStatus: "completed" });
      expect(readBackgroundProcesses(scope).processes).toEqual([
        expect.objectContaining({
          processId: run.session.id,
          instanceId: running?.instanceId,
          status: "completed",
          canStop: false,
        }),
      ]);
      expect(readBackgroundProcesses({ ...scope, agentId: "other" }).processes).toEqual([]);
      for (const field of [
        "sessionKey",
        "eventRouting",
        "notifyDeliveryContext",
        "notifySessionTarget",
        "notifyOnExit",
        "notifyOnExitEmptySuccess",
        "stdin",
      ] as const) {
        expect(retained?.[field], field).toBeUndefined();
      }
      expect(retained?.notifyOnExitRemoval).toBe(trace.includes("enqueue") ? removal : undefined);
      expect(removal).not.toHaveBeenCalled();
    },
  );
});

describe("exec settlement recovery", () => {
  it.each([
    { boundary: "task", asynchronous: true },
    { boundary: "persistent task", asynchronous: true },
    { boundary: "stdin", asynchronous: true },
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
      enqueueSessionEventMock.mockImplementation(() => {
        observed.push("enqueue");
        if (boundary === "enqueue") {
          throw failure;
        }
        return {
          id: "exec-event",
          cancel: vi.fn(() => true),
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
        };
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, "process output\n"),
        wait: () => exit.promise,
      }));
      const run = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:settlement-recovery" },
        () =>
          runTestExecProcess({
            command: "settlement-recovery",
            scopeKey,
            sessionKey: "agent:main:settlement-recovery",
            agentId: "main",
            eventRouting: { mainKey: "main", sessionScope: "per-sender" },
            notifyDeliveryContext: { channel: "telegram", to: "synthetic-chat" },
            notifyOnExit: true,
            notifyOnExitEmptySuccess: false,
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
          await expect(run.promise).resolves.toMatchObject({
            status: boundary === "enqueue" ? "completed" : "failed",
          });
        }
        await joined;
        expect(observed).toEqual([
          "task:completed",
          ...(boundary === "stdin" ? ["stdin"] : []),
          ...(boundary === "enqueue" ? ["enqueue"] : ["task:failed"]),
          "scope-released",
        ]);
        expect(identities).toEqual(boundary === "enqueue" ? [undefined] : [undefined, undefined]);
        expect(getActiveBackgroundExecSessionCount()).toBe(0);
        expect(run.session.finalizing).toBe(false);
        expect(run.session.terminalStatus).toBe("completed");
        if (boundary !== "stdin") {
          expect(getFinishedSession(run.session.id)).toMatchObject({
            terminalStatus: "completed",
            aggregated: "process output\n",
          });
        }
        for (const field of [
          "sessionKey",
          "eventRouting",
          "notifyDeliveryContext",
          "notifySessionTarget",
          "notifyOnExit",
          "notifyOnExitEmptySuccess",
        ] as const) {
          expect(run.session[field], field).toBeUndefined();
        }
      } finally {
        settlement.resolve();
        correction.resolve();
        await Promise.allSettled([run.promise, joined]);
      }
    },
  );
});
