/**
 * Exec runtime tests.
 * Covers cursor mode tracking, exit outcome classification, system events,
 * sandbox finalization, and process lifecycle behavior.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticExecProcessCompletedEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import { getFinishedSession } from "./bash-process-registry.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventWithReceiptMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventWithReceipt: enqueueSystemEventWithReceiptMock,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorMock.spawn,
  }),
}));

let markBackgrounded: typeof import("./bash-process-registry.js").markBackgrounded;
let getActiveBackgroundExecSessionCount: typeof import("./bash-process-registry.js").getActiveBackgroundExecSessionCount;
let listRunningSessions: typeof import("./bash-process-registry.js").listRunningSessions;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
let prepareGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").prepareGatewaySuspend;
let resetGatewaySuspendCoordinatorForLifecycleRestart: typeof import("../infra/gateway-suspend-coordinator.js").resetGatewaySuspendCoordinatorForLifecycleRestart;
let resumeGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").resumeGatewaySuspend;

beforeAll(async () => {
  ({ getActiveBackgroundExecSessionCount, listRunningSessions, markBackgrounded } =
    await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
  ({
    prepareGatewaySuspend,
    resetGatewaySuspendCoordinatorForLifecycleRestart,
    resumeGatewaySuspend,
  } = await import("../infra/gateway-suspend-coordinator.js"));
});

beforeEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetProcessRegistryForTests();
  requestHeartbeatMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReturnValue(vi.fn(() => true));
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

function runTestExecProcess(params: Partial<Parameters<typeof runExecProcess>[0]> = {}) {
  return runExecProcess({
    command: "test-command",
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

async function runExecWithExit(params: {
  exit: RunExit;
  stdout?: string | string[];
  timeoutSec?: number | null;
  usePty?: boolean;
}) {
  supervisorMock.spawn.mockImplementationOnce(
    async (input: { onStdout?: (chunk: string) => void }) => {
      if (params.stdout) {
        for (const chunk of typeof params.stdout === "string" ? [params.stdout] : params.stdout) {
          input.onStdout?.(chunk);
        }
      }
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
        runId: "run-exit",
        startedAtMs: Date.now(),
        pid: 123,
        wait: async () => params.exit,
        cancel: vi.fn(),
      };
    },
  );
  const run = await runTestExecProcess({
    usePty: params.usePty ?? false,
    timeoutSec: params.timeoutSec ?? null,
  });
  return { run, outcome: await run.promise };
}

function prepareSuspension(requestId: string) {
  // This test owns only the background-exec registry. Other process-global
  // activity counters may legitimately stay busy in the non-isolated suite.
  const inspect: GatewayActiveWorkInspectors = {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
    getCronRuns: () => 0,
    getAgentRuns: () => 0,
    getAcpRuns: () => 0,
    getMediaRuns: () => 0,
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
  return prepareGatewaySuspend({
    requestId,
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    inspect,
  });
}

function requireSystemEventCall(): [string, Record<string, unknown>] {
  const call = enqueueSystemEventWithReceiptMock.mock.calls[0];
  if (!call) {
    throw new Error("expected system event call");
  }
  return call as [string, Record<string, unknown>];
}

describe("runExecProcess cursor tracking", () => {
  it.each([
    { raw: ["\x1b[?1l\x1b", "[?1", "h"], expected: "application" },
    { raw: ["\x1b[?1h\x1b[?", "1", "l"], expected: "normal" },
    { raw: ["\x1b]0;\x1b[?1h", "\x07"], expected: "unknown" },
  ])("tracks the last cursor-mode toggle as $expected", async ({ raw, expected }) => {
    const { run } = await runExecWithExit({
      stdout: raw,
      usePty: true,
      exit: createRunExit(),
    });

    expect(run.session.cursorKeyMode).toBe(expected);
  });
});

describe("sandbox exec preparation failures", () => {
  it("rechecks the admitting repair authority after deferred supervisor work", async () => {
    let current = true;
    const controller = new AbortController();
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (error) => controller.abort(error),
      isCurrent: () => current,
    });
    const childEffect = vi.fn();
    supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
      await Promise.resolve();
      current = false;
      input.assertCurrent?.();
      childEffect();
      return runtimeManagedRun(input);
    });
    await expect(
      budget.run(() =>
        runTestExecProcess({
          command: "echo forbidden",
          beforeSpawn: async () => {
            await Promise.resolve();
            return undefined;
          },
        }),
      ),
    ).rejects.toThrow("execution scope is no longer active");
    expect(childEffect).not.toHaveBeenCalled();
    expect(supervisorMock.spawn).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "PTY", usePty: true, cancelCheck: 1, expectedSpawns: 0 },
    { mode: "PTY fallback", usePty: true, cancelCheck: 2, expectedSpawns: 1 },
  ])(
    "does not start $mode after cancellation during final admission",
    async ({ usePty, cancelCheck, expectedSpawns }) => {
      const controller = new AbortController();
      let checks = 0;
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        if (input.mode === "pty") {
          throw new Error("PTY unavailable");
        }
        return runtimeManagedRun(input);
      });

      await expect(
        runTestExecProcess({
          command: "echo should-not-run",
          workdir: process.cwd(),
          usePty,
          startupSignal: controller.signal,
          beforeSpawn: async () => {
            if (++checks === cancelCheck) {
              controller.abort(new Error("cancelled during admission"));
            }
            return undefined;
          },
        }),
      ).rejects.toThrow("cancelled during admission");

      expect(supervisorMock.spawn.mock.calls.length).toBe(expectedSpawns);
      expect(checks).toBe(cancelCheck);
    },
  );

  it.each([
    { mode: "PTY", usePty: true, loseAt: 1, authority: "replaced", spawns: 0 },
    { mode: "PTY fallback", usePty: true, loseAt: 2, authority: "revoked", spawns: 1 },
    { mode: "PTY construction", usePty: true, loseAt: -1, authority: "revoked", spawns: 1 },
  ])(
    "checks $authority source authority before $mode admission without polling",
    async ({ usePty, loseAt, authority, spawns }) => {
      const originalClaim = {};
      let currentClaim: object | undefined = originalClaim;
      let checks = 0;
      const generation = new AbortController();
      const warnings: string[] = [];
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        // The real supervisor preserves this callback across queued construction.
        await Promise.resolve();
        if (loseAt === -1) {
          currentClaim = undefined;
        }
        input.assertCurrent?.();
        if (input.mode === "pty") {
          throw new Error("PTY unavailable");
        }
        return runtimeManagedRun(input);
      });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:source-exec-authority",
          receiptAuthority: () => currentClaim === originalClaim,
        },
        () =>
          runTestExecProcess({
            command: "source-authority-command",
            workdir: process.cwd(),
            usePty,
            warnings,
            startupSignal: generation.signal,
            beforeSpawn: async () => {
              if (++checks === loseAt) {
                currentClaim = authority === "replaced" ? {} : undefined;
              }
              return undefined;
            },
          }),
      );
      await expect(pending).rejects.toThrow("authority is no longer active");
      expect(generation.signal.aborted).toBe(false);
      expect(supervisorMock.spawn).toHaveBeenCalledTimes(spawns);
      expect(warnings).toEqual(
        usePty && loseAt !== -1 && spawns > 0
          ? [expect.stringContaining("retrying without PTY")]
          : [],
      );
      expect(listRunningSessions()).toHaveLength(0);
    },
  );

  it("keeps turn authority out of process lifetime while preserving foreground updates", async () => {
    const exit = createDeferred<RunExit>();
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:exec-lifetime",
      signedAgentRuntimeIdentityToken: "synthetic-turn-identity",
    };
    const spawnIdentity = vi.fn();
    const updateIdentity = vi.fn();
    const settledIdentity = vi.fn();
    const beforeSpawn = vi.fn(async () => {
      expect(getGatewayToolCallerIdentity()).toMatchObject(identity);
      return undefined;
    });
    let stdout: SpawnInput["onStdout"];
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      spawnIdentity(getGatewayToolCallerIdentity());
      stdout = input.onStdout;
      stdout?.("foreground output\n");
      return { ...runtimeManagedRun(input), wait: () => exit.promise };
    });

    const run = await withGatewayToolCallerIdentity(identity, () =>
      runTestExecProcess({
        beforeSpawn,
        onUpdate: () => updateIdentity(getGatewayToolCallerIdentity()),
        onSettledBeforeNotify: () => settledIdentity(getGatewayToolCallerIdentity()),
      }),
    );
    run.disableUpdates();
    stdout?.("background output\n");
    exit.resolve(createRunExit());
    const outcome = await run.promise;

    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(updateIdentity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(identity));
    expect(outcome.aggregated).toBe("foreground output\nbackground output");
    expect(spawnIdentity).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(settledIdentity).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("runs the final authorization check after async preparation and before spawn", async () => {
    const preparation =
      createDeferred<Awaited<ReturnType<NonNullable<BashSandboxConfig["buildExecSpec"]>>>>();
    const denied = new Error("approval directory changed");
    const beforeSpawn = vi.fn(async () => {
      throw denied;
    });
    const pending = runTestExecProcess({
      command: "sandbox-command",
      sandbox: {
        containerName: "sandbox",
        workspaceDir: "/workspace",
        containerWorkdir: "/workspace",
        buildExecSpec: async () => await preparation.promise,
      },
      beforeSpawn,
    });

    expect(beforeSpawn).not.toHaveBeenCalled();
    preparation.resolve({
      argv: ["sandbox-command"],
      env: {},
      stdinMode: "pipe-closed",
    });
    await expect(pending).rejects.toBe(denied);
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

  it("rejects a sandbox without a backend-owned exec specification", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
      runtimeManagedRun(input),
    );

    await expect(
      runTestExecProcess({
        command: "sandbox-command",
        env: { EXAMPLE_VALUE: "synthetic-runtime-sandbox-value" },
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
        },
      }),
    ).rejects.toThrow("sandbox backend does not provide buildExecSpec");

    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

  it("settles the registered session once when buildExecSpec rejects", async () => {
    const registry = await import("./bash-process-registry.js");
    const sessionSlugs = await import("./session-slug.js");
    const sessionId = "sandbox-preparation-failure";
    const sessionSlug = vi.spyOn(sessionSlugs, "createSessionSlug").mockReturnValue(sessionId);
    const preparation =
      createDeferred<Awaited<ReturnType<NonNullable<BashSandboxConfig["buildExecSpec"]>>>>();
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    const onSettledBeforeNotify = vi.fn();
    const completionEvents: DiagnosticExecProcessCompletedEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (
        event.type === "exec.process.completed" &&
        event.sessionKey === "agent:main:sandbox-preparation"
      ) {
        completionEvents.push(event);
      }
    });
    const failure = new Error("sandbox preparation failed");

    try {
      const pending = runTestExecProcess({
        command: "sandbox-command",
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
          buildExecSpec: async () => await preparation.promise,
          finalizeExec,
        },
        sessionKey: "agent:main:sandbox-preparation",
        onSettledBeforeNotify,
      });

      expect(registry.getSession(sessionId)).toMatchObject({ exited: false });
      preparation.reject(failure);
      await expect(pending).rejects.toBe(failure);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(finalizeExec).not.toHaveBeenCalled();
      expect(supervisorMock.spawn).not.toHaveBeenCalled();
      expect(registry.getSession(sessionId)).toBeUndefined();
      expect(onSettledBeforeNotify).toHaveBeenCalledOnce();
      expect(onSettledBeforeNotify).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", failureKind: "runtime-error" }),
      );
      expect(completionEvents).toEqual([
        expect.objectContaining({
          type: "exec.process.completed",
          target: "sandbox",
          mode: "child",
          outcome: "failed",
          failureKind: "runtime-error",
          timedOut: false,
          sessionKey: "agent:main:sandbox-preparation",
        }),
      ]);
    } finally {
      unsubscribe();
      sessionSlug.mockRestore();
    }
  });
});

describe("sandbox exec finalization suspension", () => {
  it.each([
    {
      scenario: "successful cleanup",
      finalizeRejects: false,
      processTimesOut: false,
      expectedStatus: "completed" as const,
      expectedFailureKind: undefined,
    },
    {
      scenario: "failed cleanup after a process timeout",
      finalizeRejects: true,
      processTimesOut: true,
      expectedStatus: "failed" as const,
      expectedFailureKind: "overall-timeout" as const,
    },
  ])(
    "keeps suspension busy until asynchronous finalization settles after $scenario",
    async ({ finalizeRejects, processTimesOut, expectedFailureKind, expectedStatus }) => {
      const exit = createDeferred<RunExit>();
      const finalization = createDeferred();
      const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(
        async () => await finalization.promise,
      );
      let producer: SpawnInput | undefined;
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
        producer = input;
        input.onStdout?.("sandbox output\n");
        const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
        return {
          activity,
          runId: "sandbox-run",
          startedAtMs: Date.now(),
          pid: 123,
          wait: async () => {
            try {
              return await exit.promise;
            } finally {
              activity.resultSettled = true;
            }
          },
          cancel: vi.fn(),
        };
      });

      const run = await runTestExecProcess({
        command: "sandbox-command",
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
          buildExecSpec: async () => ({
            argv: ["sandbox-command"],
            env: {},
            stdinMode: "pipe-closed",
            finalizeToken: "sandbox-token",
          }),
          finalizeExec,
        },
        notifyOnExit: true,
        sessionKey: "agent:main:main",
      });
      markBackgrounded(run.session);
      expect(getActiveBackgroundExecSessionCount()).toBe(1);

      exit.resolve(
        createRunExit({
          reason: processTimesOut ? "overall-timeout" : "exit",
          exitCode: processTimesOut ? null : 0,
          exitSignal: processTimesOut ? "SIGKILL" : null,
          timedOut: processTimesOut,
        }),
      );
      await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
      expect(run.session.finalizing).toBe(true);
      producer?.onStderr?.("during cleanup\n");
      expect(getFinishedSession(run.session.id)).toBeUndefined();

      const busy = prepareSuspension(`before-finalize-${expectedFailureKind ?? "success"}`);
      expect(busy.status).toBe("busy");
      if (busy.status === "busy") {
        expect(busy.blockers).toContainEqual(
          expect.objectContaining({ kind: "background-exec", count: 1 }),
        );
      }
      expect(getActiveBackgroundExecSessionCount()).toBe(1);

      if (finalizeRejects) {
        finalization.reject(new Error("sandbox finalize failed"));
      } else {
        finalization.resolve();
      }
      const outcome = await run.promise;

      expect(outcome.status).toBe(expectedStatus);
      if (outcome.status === "failed") {
        expect(outcome.failureKind).toBe(expectedFailureKind);
        expect(outcome.reason).toContain("timed out");
      }
      expect(finalizeExec).toHaveBeenCalledOnce();
      expect(getActiveBackgroundExecSessionCount()).toBe(0);
      expect(run.session.finalizing).toBe(false);
      expect(enqueueSystemEventWithReceiptMock).toHaveBeenCalledTimes(1);
      expect(requireSystemEventCall()[0]).toContain(
        expectedStatus === "failed" ? "Exec failed" : "Exec completed",
      );
      expect(requireSystemEventCall()[0]).toContain("during cleanup");
      const retained = getFinishedSession(run.session.id);
      const outputBeforeLateCallback = {
        aggregated: retained?.aggregated,
        tail: retained?.tail,
        totalOutputChars: retained?.totalOutputChars,
        truncated: retained?.truncated,
      };
      expect(outputBeforeLateCallback.aggregated).toContain("sandbox output\nduring cleanup\n");
      producer?.onStdout?.("late output".repeat(1_000));
      expect(getFinishedSession(run.session.id)).toMatchObject(outputBeforeLateCallback);

      const ready = prepareSuspension(`after-finalize-${expectedFailureKind ?? "success"}`);
      expect(ready.status).toBe("ready");
      if (ready.status === "ready") {
        expect(resumeGatewaySuspend(ready.suspensionId)).toMatchObject({ ok: true });
      }
    },
  );
});

describe("runExecProcess exit outcomes", () => {
  it("keeps non-zero normal exits in the completed path", async () => {
    const { outcome } = await runExecWithExit({
      stdout: "done",
      exit: createRunExit({ exitCode: 1, durationMs: 123 }),
      timeoutSec: 30,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error(`Expected completed outcome, got ${outcome.status}`);
    }
    expect(outcome.exitCode).toBe(1);
    expect(outcome.aggregated).toBe("done\n\n(Command exited with code 1)");
  });
});

describe("runExecProcess PTY fallback", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  function runPtyFallback(warnings: string[] = []) {
    return runTestExecProcess({
      command: "printf ok",
      workdir: process.cwd(),
      usePty: true,
      warnings,
      maxOutput: 20_000,
      pendingMaxOutput: 20_000,
      timeoutSec: 5,
    });
  }

  function spawnInput(index: number): SpawnInput {
    const call = supervisorMock.spawn.mock.calls[index] as [SpawnInput] | undefined;
    if (!call) {
      throw new Error(`expected supervisor spawn call ${index}`);
    }
    return call[0];
  }

  it("visibly falls back when the portable worker rejects PTY", async () => {
    supervisorMock.spawn
      .mockRejectedValueOnce(new Error("PTY is unavailable in the portable worker runtime"))
      .mockImplementationOnce(async (input: SpawnInput) => runtimeManagedRun(input, "ok"));

    const warnings: string[] = [];
    const handle = await runPtyFallback(warnings);
    const outcome = await handle.promise;

    expect(outcome.status).toBe("completed");
    expect(outcome.aggregated).toContain("ok");
    expect(warnings.join("\n")).toContain("PTY is unavailable in the portable worker runtime");
    expect(spawnInput(0).mode).toBe("pty");
    expect(spawnInput(1).mode).toBe("child");
  });

  it("cleans session state when PTY fallback spawn also fails", async () => {
    supervisorMock.spawn
      .mockRejectedValueOnce(new Error("pty spawn failed"))
      .mockRejectedValueOnce(new Error("child fallback failed"));

    await expect(runPtyFallback()).rejects.toThrow("child fallback failed");

    expect(listRunningSessions()).toHaveLength(0);
  });

  it("emits bounded process diagnostics without command text", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
      runtimeManagedRun(input, "ok"),
    );
    const events: DiagnosticEventPayload[] = [];
    const metadataByEvent = new Map<DiagnosticEventPayload, DiagnosticEventMetadata>();
    const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
      events.push(event);
      metadataByEvent.set(event, metadata);
    });
    try {
      const command = "printf super-secret-value";
      const handle = await runTestExecProcess({
        command,
        workdir: process.cwd(),
        maxOutput: 20_000,
        pendingMaxOutput: 20_000,
        sessionKey: "session-1",
        timeoutSec: 5,
      });

      await handle.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const event = events.find(
        (item): item is DiagnosticExecProcessCompletedEvent =>
          item.type === "exec.process.completed",
      );
      if (!event) {
        throw new Error("Expected exec process completed event");
      }
      expect(event.type).toBe("exec.process.completed");
      // The payload stays untrusted, but exporters need the ambient trace context marked
      // OpenClaw-owned or the exec span cannot be nested under the run that spawned it.
      expect(metadataByEvent.get(event)?.trusted).toBe(false);
      expect(metadataByEvent.get(event)?.trustedTraceContext).toBe(true);
      expect(event.target).toBe("host");
      expect(event.mode).toBe("child");
      expect(event.outcome).toBe("completed");
      expect(typeof event.durationMs).toBe("number");
      expect(event.commandLength).toBe(command.length);
      expect(event.exitCode).toBe(0);
      expect(event.sessionKey).toBe("session-1");
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("printf");
      expect(serialized).not.toContain("super-secret-value");
      expect(serialized).not.toContain(process.cwd());
    } finally {
      unsubscribe();
    }
  });
});

function successfulSupervisorRun() {
  return {
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: "mock-run",
    startedAtMs: Date.now(),
    wait: async () => createRunExit({ durationMs: 0 }),
    cancel: vi.fn(),
  };
}

function requireHeartbeatCall(): Record<string, unknown> {
  const call = requestHeartbeatMock.mock.calls[0];
  if (!call) {
    throw new Error("expected heartbeat call");
  }
  return call[0] as Record<string, unknown>;
}

describe("exec notifyOnExit suppression", () => {
  async function runBackgroundedExit(params: {
    reason: "manual-cancel" | "overall-timeout";
    stdout?: string;
  }) {
    supervisorMock.spawn.mockImplementationOnce(
      async (input: { onStdout?: (chunk: string) => void }) => {
        if (params.stdout) {
          input.onStdout?.(params.stdout);
        }
        const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
        return {
          activity,
          runId: "run-1",
          startedAtMs: Date.now(),
          pid: 123,
          wait: async () => {
            await new Promise((resolve) => {
              setImmediate(resolve);
            });
            activity.resultSettled = true;
            return {
              reason: params.reason,
              exitCode: null,
              exitSignal: "SIGKILL",
              durationMs: 10,
              stdout: "",
              stderr: "",
              timedOut: params.reason === "overall-timeout",
              noOutputTimedOut: false,
            };
          },
          cancel: vi.fn(),
        };
      },
    );

    const run = await runTestExecProcess({
      command: "sleep 999",
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      sessionKey: "agent:main:main",
    });
    markBackgrounded(run.session);
    return await run.promise;
  }

  it.each(["partial output\n"])(
    "keeps manually canceled background execs silent (output=%j)",
    async (stdout) => {
      const outcome = await runBackgroundedExit({ reason: "manual-cancel", stdout });

      expect(outcome.status).toBe("failed");
      expect(enqueueSystemEventWithReceiptMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    },
  );

  it("still notifies for no-output background exec timeouts", async () => {
    await runBackgroundedExit({ reason: "overall-timeout" });

    const [message, options] = requireSystemEventCall();
    expect(message).toContain("Exec failed");
    expect(message).toContain("external side effects may already have completed");
    expect(message).toContain("Verify the resulting state before retrying");
    expect(message).toContain("Do not automatically rerun non-idempotent commands");
    expect(options.sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:main:main");
  });

  it("keeps background exec exit-notification snippets on a UTF-16 boundary", async () => {
    const head = "a".repeat(178);
    const overflowingOutput = `${head}🎉${"b".repeat(30)}`;
    await runBackgroundedExit({ reason: "overall-timeout", stdout: overflowingOutput });

    const [message] = requireSystemEventCall();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).toContain("…");
    expect(message).toContain(head);
  });

  it("keeps the notify tail source on a UTF-16 boundary", async () => {
    const prefix = "a".repeat(101);
    const tailHead = "b".repeat(179);
    const overflowingOutput = `${prefix}🎉${tailHead}${"c".repeat(220)}`;
    await runBackgroundedExit({ reason: "overall-timeout", stdout: overflowingOutput });

    const [message] = requireSystemEventCall();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).not.toContain("�");
    expect(message).toContain(tailHead);
  });
});

describe("runExecProcess POSIX command wrapper", () => {
  it("normalizes non-finite and oversized exec timeouts before spawning", async () => {
    supervisorMock.spawn.mockResolvedValue(successfulSupervisorRun());

    const baseParams = {
      command: "echo test",
      env: { PATH: "/usr/bin" },
      pathPrepend: [],
    };

    await runTestExecProcess({
      ...baseParams,
      timeoutSec: Number.POSITIVE_INFINITY,
    });
    await runTestExecProcess({
      ...baseParams,
      timeoutSec: 3_000_000,
    });

    expect(supervisorMock.spawn.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
    expect(supervisorMock.spawn.mock.calls[1]?.[0].timeoutMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("wraps command with PATH export if OPENCLAW_PREPEND_PATH is present", async () => {
    if (process.platform === "win32") {
      return;
    }

    supervisorMock.spawn.mockResolvedValueOnce(successfulSupervisorRun());

    await runTestExecProcess({
      command: "echo test",
      env: { PATH: "/usr/bin" },
      pathPrepend: ["/custom/bin", "/opt/bin"],
    });

    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];
    expect(spawnCall.argv.join(" ")).toContain(
      'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; echo test',
    );
  });

  it("does not wrap command on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    supervisorMock.spawn.mockResolvedValueOnce(successfulSupervisorRun());
    await runTestExecProcess({
      command: "echo test",
      workdir: "C:\\tmp",
      env: { Path: "C:\\Windows\\System32" },
      pathPrepend: ["C:\\custom\\bin"],
    });

    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];
    const commandStr = spawnCall.argv.join(" ");
    expect(commandStr).not.toContain("export PATH=");
    expect(commandStr).toContain("echo test");
  });
});

describe("runExecProcess stream sanitization", () => {
  function runStyledExec() {
    return runTestExecProcess({
      command: "printf styled",
      workdir: process.cwd(),
      maxOutput: 20_000,
      pendingMaxOutput: 20_000,
      timeoutSec: 5,
    });
  }

  it("sanitizes ANSI and OSC sequences split across stdout chunks", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      for (const chunk of [
        "A\u001B]0;title",
        "\u0007B",
        "C\u001B[31",
        "mD",
        "E\u009D0;title",
        "\u001B\\F",
        "G\u009B31",
        "mH",
      ]) {
        input.onStdout?.(chunk);
      }
      return runtimeManagedRun(input);
    });

    const outcome = await (await runStyledExec()).promise;
    expect(outcome.aggregated).toContain("ABCDEFGH");
    expect(outcome.aggregated).not.toContain("\\x1b");
  });

  it("keeps stdout and stderr parser state independent", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      input.onStdout?.("out\u001B[");
      input.onStderr?.("err\u001B[");
      input.onStdout?.("32mOUT");
      input.onStderr?.("31mERR");
      return runtimeManagedRun(input);
    });

    const outcome = await (await runStyledExec()).promise;
    expect(outcome.aggregated).toBe("outerrOUTERR");
  });
});
