import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureExecRequestOwners, withExecRequestTurn } from "../infra/exec-request-context.js";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { captureExecRequestCancellation } from "./bash-process-control.js";
import { readBackgroundProcesses } from "./bash-process-observation.js";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  acknowledgeNotifyOnExit,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  markBackgrounded,
  waitForExecScope,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecFixture } from "./bash-tools.exec-fixture.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import { createEnteredGate } from "./entered-gate.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";
import type { SandboxBackendHandle } from "./sandbox/backend-handle.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
// mock-isolation: Process lifecycle tests use synthetic destinations; durable notification behavior has its own owner suite.
vi.mock("../config/sessions/session-accessor.sqlite-entry.js", () => ({
  patchSessionEntryCore: async () => null,
}));
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
afterEach(resetProcessRegistryForTests);

function completedReceipt(cancel = vi.fn(() => true)) {
  return {
    id: "exec-event",
    cancel,
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  };
}

function runTestExecProcess(params: Partial<Parameters<typeof runExecProcess>[0]>) {
  return runExecFixture({ command: "sandbox-fixture", ...params });
}

function queueRun(
  wait: (() => Promise<RunExit>) | undefined,
  output = "",
  overrides: Partial<ManagedRun> | ((input: SpawnInput) => Partial<ManagedRun>) = {},
) {
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
    ...runtimeManagedRun(input, output),
    ...(wait ? { wait } : {}),
    ...(typeof overrides === "function" ? overrides(input) : overrides),
  }));
}

function createExecOperatorSource(profileId = "exec-guest") {
  const controller = new AbortController();
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.write"],
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    retain,
  });
  return { controller, authority, retain, release };
}

const deliveryContext = { channel: "telegram", to: "synthetic-chat" };
const notificationRouting = {
  agentId: "main",
  eventRouting: { mainKey: "main", sessionScope: "per-sender" },
  notifyDeliveryContext: deliveryContext,
  notifyOnExit: true,
  notifyOnExitEmptySuccess: false,
} satisfies Partial<Parameters<typeof runExecProcess>[0]>;

function expectRoutingReleased(session: ProcessSession | undefined) {
  for (const field of [
    "sessionKey",
    "eventRouting",
    "notifyDeliveryContext",
    "notifySessionTarget",
    "notifyOnExit",
    "notifyOnExitEmptySuccess",
  ] as const) {
    expect(session?.[field], field).toBeUndefined();
  }
}

it.each([
  ["manual-cancel", false, false, "none"],
  ["overall-timeout", true, false, "none"],
  ["manual-cancel", false, true, "none"],
  ["manual-cancel", false, true, "capture"],
  ["manual-cancel", true, true, "capture"],
] as const)(
  "starts and joins targeted sandbox cleanup for %s (cleanupFails=%s, duringFinalize=%s, requestStop=%s)",
  async (reason, cleanupFails, duringFinalize, requestStop) => {
    const termination = createDeferred();
    const artifacts = createEnteredGate();
    const guestExit = createDeferred<ReturnType<typeof createRunExit>>();
    const otherExit = createDeferred<ReturnType<typeof createRunExit>>();
    const {
      controller: originalSource,
      release: releaseSource,
      authority,
    } = createExecOperatorSource("guest");
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
            await artifacts.wait();
          }
        }),
        terminate,
      };
    };
    const sandbox = makeSandbox("guest");
    const otherSandbox = makeSandbox("independent");
    let guestInput: SpawnInput | undefined;
    const cancelOther = vi.fn();
    queueRun(
      () => guestExit.promise,
      "",
      (input) => {
        guestInput = input;
        return { cancel: () => input.onCancel?.("manual-cancel") };
      },
    );
    queueRun(() => otherExit.promise, "", { cancel: cancelOther });
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
        await artifacts.entered;
        if (request) {
          expect(request.cancellation.cancel()).toBe(true);
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
        artifacts.release();
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
      artifacts.release();
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
    const finalization = createEnteredGate();
    const cleanupScope = createAgentCleanupScope();
    const scopeKey = "scope:sandbox-artifact-cleanup";
    const cleanupFailure = "sandbox artifact cleanup failed";
    const secret = `ghp_${"a".repeat(36)}`;
    queueRun(async () => createRunExit({ exitCode: commandCode }), "saved process output");
    let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
    const finalizeExec = vi.fn(async () => {
      await finalization.wait();
      if (fails) {
        throw new Error(`${cleanupFailure}: token=${secret}`);
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
        await finalization.entered;
        if (beforeJoin) {
          finalization.release();
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
          finalization.release();
        }
        await join;
        const outcome = await run.promise;
        expect(outcome.status).toBe(fails || commandCode !== 0 ? "failed" : "completed");
        if (fails) {
          assert(outcome.status === "failed");
          expect(outcome.aggregated).toContain(cleanupFailure);
          expect(run.session.aggregated).toContain(cleanupFailure);
          expect(outcome.message).toContain(cleanupFailure);
          expect(outcome.message).not.toContain("saved process output");
          expect(outcome.reason).toContain("saved process output");
          expect(outcome.reason.split(cleanupFailure)).toHaveLength(2);
          expect(JSON.stringify(outcome)).not.toContain(secret);
        }
        expect(finalizeExec).toHaveBeenCalledOnce();
      });
      expect(cleanupScope.outcome).toBe(fails ? "uncertain" : "closed");
    } finally {
      finalization.release();
      await run?.promise;
    }
  },
);

it.each([
  { path: "notify", trace: ["task", "enqueue"] },
  { path: "quiet", trace: ["task"] },
  { path: "unrouted", trace: ["task"] },
  { path: "observed", trace: ["task"] },
])("releases routing after $path without changing notification order", async ({ path, trace }) => {
  const exit = createDeferred<RunExit>();
  const observed: string[] = [];
  const removal = vi.fn(() => true);
  enqueueSessionEventMock.mockImplementation((_text, options) => {
    observed.push("enqueue");
    expect(options.deliveryContext).toEqual(deliveryContext);
    return completedReceipt(removal);
  });
  queueRun(() => exit.promise, path === "quiet" ? "" : "retained output\n");
  const run = await runTestExecProcess({
    ...notificationRouting,
    command: "context-release",
    scopeKey: "global",
    sessionKey: path === "unrouted" ? undefined : "agent:main:main",
    onSettledBeforeNotify: () => void observed.push("task"),
  });
  markBackgrounded(run.session);
  const scope = { scopeKeys: ["global"], agentId: "main" };
  if (path === "observed") {
    acknowledgeNotifyOnExit(run.session);
  }
  exit.resolve(createRunExit());
  const outcome = await run.promise;
  expect(observed).toEqual(trace);
  expect(outcome.status).toBe("completed");
  const retained = getFinishedSession(run.session.id);
  expect(retained).toMatchObject({ scopeKey: "global", terminalStatus: "completed" });
  expect(readBackgroundProcesses({ ...scope, agentId: "other" }).processes).toEqual([]);
  expectRoutingReleased(retained);
  expect(retained?.stdin).toBeUndefined();
  expect(retained?.notifyOnExitRemoval).toBe(trace.includes("enqueue") ? removal : undefined);
  expect(removal).not.toHaveBeenCalled();
});
it.each(["task", "persistent task", "stdin"])(
  "settles asynchronous %s failure before releasing the exec scope",
  async (boundary) => {
    const exit = createDeferred<RunExit>();
    const settlementStarted = createDeferred();
    const settlement = createDeferred();
    const correctionStarted = createDeferred();
    const correction = createDeferred();
    const observed: string[] = [];
    const identities: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    const scopeKey = `settlement-recovery:${boundary}:true`;
    const failure = new Error("process settlement failed");
    enqueueSessionEventMock.mockImplementation(() => {
      observed.push("enqueue");
      return completedReceipt();
    });
    queueRun(() => exit.promise, "process output\n");
    const run = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:settlement-recovery" },
      () =>
        runTestExecProcess({
          ...notificationRouting,
          command: "settlement-recovery",
          scopeKey,
          sessionKey: "agent:main:settlement-recovery",
          onSettledBeforeNotify: (outcome) => {
            observed.push(`task:${outcome.status}`);
            identities.push(getGatewayToolCallerIdentity());
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
      await settlementStarted.promise;
      expect(run.session).toMatchObject({ finalizing: true, exited: false });
      expect(getActiveBackgroundExecSessionCount()).toBe(1);
      expect(observed).toEqual(["task:completed"]);
      settlement.resolve();
      await correctionStarted.promise;
      expect(run.session.finalizing).toBe(true);
      expect(getActiveBackgroundExecSessionCount()).toBe(1);
      expect(observed).not.toContain("scope-released");
      correction.resolve();
      if (boundary === "persistent task") {
        await expect(run.promise).rejects.toBe(failure);
      } else {
        await expect(run.promise).resolves.toMatchObject({ status: "failed" });
      }
      await joined;
      expect(observed).toEqual([
        "task:completed",
        ...(boundary === "stdin" ? ["stdin"] : []),
        "task:failed",
        "scope-released",
      ]);
      expect(identities).toEqual([undefined, undefined]);
      expect(getActiveBackgroundExecSessionCount()).toBe(0);
      expect(run.session).toMatchObject({
        finalizing: false,
        terminalStatus: "completed",
        agentId: "main",
      });
      if (boundary !== "stdin") {
        expect(getFinishedSession(run.session.id)).toMatchObject({
          terminalStatus: "completed",
          aggregated: "process output\n",
        });
      }
      expectRoutingReleased(run.session);
    } finally {
      settlement.resolve();
      correction.resolve();
      await Promise.allSettled([run.promise, joined]);
    }
  },
);

describe("operator source lifetime", () => {
  afterEach(() => {
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventWithReceiptMock).not.toHaveBeenCalled();
  });
  const caller = (source: ReturnType<typeof createExecOperatorSource>, sessionKey: string) => ({
    agentId: "main",
    sessionKey,
    operatorAuthority: source.authority,
  });

  it("retains the original operator source through background cancellation and finalization", async () => {
    const source = createExecOperatorSource();
    const turn = new AbortController();
    const guestExit = createDeferred<RunExit>();
    const staffExit = createDeferred<RunExit>();
    const cleanup = createEnteredGate();
    const cancelGuest = vi.fn(() => {
      guestExit.resolve(createRunExit({ reason: "manual-cancel", exitCode: null }));
    });
    const cancelStaff = vi.fn();
    queueRun(undefined, "saved guest output\n", {
      cancel: cancelGuest,
      wait: () => guestExit.promise,
      waitForExtinction: cleanup.wait,
    });
    queueRun(undefined, "independent output\n", {
      cancel: cancelStaff,
      wait: () => staffExit.promise,
    });
    const guest = await withGatewayToolCallerIdentity(
      {
        ...caller(source, "agent:main:retained-exec"),
        receiptAuthority: () => !turn.signal.aborted,
      },
      () => runTestExecProcess({ command: "retained-source-command", startupSignal: turn.signal }),
    );
    const staff = await runTestExecProcess({ command: "retained-source-command" });
    markBackgrounded(guest.session);
    markBackgrounded(staff.session);
    try {
      turn.abort();
      guest.disableUpdates();
      expect(cancelGuest).not.toHaveBeenCalled();
      expect(guest.session.exited).toBe(false);

      source.controller.abort(new Error("original invitation revoked"));
      expect(cancelGuest).toHaveBeenCalledWith("manual-cancel");
      expect(cancelStaff).not.toHaveBeenCalled();
      await cleanup.entered;
      expect(guest.session).toMatchObject({ finalizing: true, exited: false });
      expect(source.release).not.toHaveBeenCalled();

      expect(() => source.authority.assertCurrent()).toThrow("original invitation revoked");
      expect(staff.session.exited).toBe(false);
      cleanup.release();
      await expect(guest.promise).resolves.toMatchObject({
        status: "failed",
        exitReason: "manual-cancel",
        aggregated: expect.stringContaining("saved guest output"),
      });
      expect(source.retain).toHaveBeenCalledOnce();
      expect(source.release).toHaveBeenCalledOnce();
      staffExit.resolve(createRunExit());
      await expect(staff.promise).resolves.toMatchObject({ status: "completed" });
      expect(cancelStaff).not.toHaveBeenCalled();
    } finally {
      cleanup.release();
      guestExit.resolve(createRunExit());
      staffExit.resolve(createRunExit());
      await Promise.all([guest.promise, staff.promise]);
    }
  });

  it.each([false, true])(
    "releases the original operator source after startup failure=%s",
    async (fails) => {
      const source = createExecOperatorSource();
      const cancel = vi.fn();
      if (fails) {
        supervisorMock.spawn.mockRejectedValueOnce(new Error("process startup failed"));
      } else {
        queueRun(undefined, "", { cancel });
      }
      const pending = withGatewayToolCallerIdentity(
        caller(source, "agent:main:source-release"),
        () => runTestExecProcess({ command: "source-release-command" }),
      );
      if (fails) {
        await expect(pending).rejects.toThrow("process startup failed");
      } else {
        const run = await pending;
        await expect(run.promise).resolves.toMatchObject({ status: "completed" });
      }
      expect(source.retain).toHaveBeenCalledOnce();
      expect(source.release).toHaveBeenCalledOnce();
      source.controller.abort();
      expect(cancel).not.toHaveBeenCalled();
    },
  );
});
