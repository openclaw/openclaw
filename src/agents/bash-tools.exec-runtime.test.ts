import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { captureExecRequestOwners, withExecRequestTurn } from "../infra/exec-request-context.js";
import {
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { inspectors } from "../infra/gateway-suspend-coordinator.test-support.js";
import { sanitizeHostExecEnv, setGatewayCredentialEnvKeys } from "../infra/host-env-security.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import { createCodingToolsGatewayCaller } from "./agent-tools.caller.js";
import {
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  listRunningSessions,
  markBackgrounded,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecFixture as runTestExecProcess } from "./bash-tools.exec-fixture.test-support.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
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
let unsubscribeDiagnostics: (() => void) | undefined;
// mock-isolation: Control completion receipts without starting session turns in process tests.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: async (agentId: string, sessionKey: string) => ({
    agentId,
    sessionKey,
    sessionId: sessionKey,
    generation: "test",
  }),
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventWithReceipt: enqueueSystemEventWithReceiptMock,
}));

// mock-isolation: Control child-process settlement without spawning real processes.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => supervisorMock }));

beforeEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetProcessRegistryForTests();
  enqueueSessionEventMock.mockReset().mockReturnValue({
    id: "exec-event",
    cancel: vi.fn(() => true),
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  });
  enqueueSystemEventWithReceiptMock.mockReset().mockReturnValue(vi.fn(() => true));
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  unsubscribeDiagnostics?.();
  unsubscribeDiagnostics = undefined;
});

const sandboxDirectories = {
  containerName: "sandbox",
  workspaceDir: "/workspace",
  containerWorkdir: "/workspace",
};
const nextImmediate = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const sandboxSpec = (finalizeToken?: string) => ({
  argv: ["sandbox-command"],
  env: {},
  stdinMode: "pipe-closed" as const,
  ...(finalizeToken ? { finalizeToken } : {}),
});

function managedExit(
  input: SpawnInput,
  exit: () => Promise<RunExit>,
  stdout = "",
  runId = "run-1",
) {
  if (stdout) {
    input.onStdout?.(stdout);
  }
  const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
  return {
    activity,
    runId,
    pid: 123,
    startedAtMs: Date.now(),
    cancel: vi.fn(),
    wait: async () => {
      try {
        return await exit();
      } finally {
        activity.resultSettled = true;
      }
    },
  };
}

function captureCompletions(sessionKey?: string) {
  const events: Extract<DiagnosticEventPayload, { type: "exec.process.completed" }>[] = [];
  const metadata = new Map<DiagnosticEventPayload, DiagnosticEventMetadata>();
  unsubscribeDiagnostics = onInternalDiagnosticEvent((event, meta) => {
    if (
      event.type === "exec.process.completed" &&
      (!sessionKey || event.sessionKey === sessionKey)
    ) {
      events.push(event);
      metadata.set(event, meta);
    }
  });
  return { events, metadata };
}

function prepareSuspension(requestId: string) {
  // This test owns only the background-exec registry. Other process-global
  // activity counters may legitimately stay busy in the non-isolated suite.
  const inspect = inspectors({ getBackgroundExecSessions: getActiveBackgroundExecSessionCount });
  return prepareGatewaySuspend({
    requestId,
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    inspect,
  });
}

function requireSystemEventCall(): [string, Record<string, unknown>] {
  return expectDefined(enqueueSessionEventMock.mock.calls[0], "expected system event call") as [
    string,
    Record<string, unknown>,
  ];
}

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

  it("does not start PTY fallback after cancellation during final admission", async () => {
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
        usePty: true,
        startupSignal: controller.signal,
        beforeSpawn: async () => {
          if (++checks === 2) {
            controller.abort(new Error("cancelled during admission"));
          }
          return undefined;
        },
      }),
    ).rejects.toThrow("cancelled during admission");

    expect(supervisorMock.spawn).toHaveBeenCalledOnce();
    expect(checks).toBe(2);
  });

  it.each([
    { mode: "PTY fallback", loseAt: 2 },
    { mode: "PTY construction", loseAt: -1 },
  ])(
    "checks revoked source authority before $mode admission without polling",
    async ({ loseAt }) => {
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
            usePty: true,
            warnings,
            startupSignal: generation.signal,
            beforeSpawn: async () => {
              if (++checks === loseAt) {
                currentClaim = undefined;
              }
              return undefined;
            },
          }),
      );
      await expect(pending).rejects.toThrow("authority is no longer active");
      expect(generation.signal.aborted).toBe(false);
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
      expect(warnings).toEqual(
        loseAt !== -1 ? [expect.stringContaining("retrying without PTY")] : [],
      );
      expect(listRunningSessions()).toHaveLength(0);
    },
  );

  it.each(["current", "reassigned"] as const)(
    "rechecks a prepared settle tool at final process spawn when its batch is %s",
    async (state) => {
      const sessionKey = "agent:main:settle-exec";
      const sourceSessionKey = "agent:main:subagent:child";
      const claim = {};
      let currentClaim: object | undefined = claim;
      const profile = resolveConversationCapabilityProfile({ sessionKey, agentId: "main" });
      const wrap = createCodingToolsGatewayCaller({
        agentId: "main",
        sessionKey,
        capabilityProfile: {
          ...profile,
          policy: { ...profile.policy, requesterPolicySource: "completion-handoff" },
        },
        options: {
          trustedInternalHandoff: {
            kind: "subagent-completion",
            sourceSessionKey,
            targetSessionKey: sessionKey,
            targetSessionId: "settle-parent",
            provider: "openai",
            model: "test-model",
            settleBatch: {
              sourceSessionKeys: [sourceSessionKey],
              isCurrent: () => currentClaim === claim,
            },
          },
        },
      });
      const effect = vi.fn();
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
        await Promise.resolve();
        currentClaim = state === "current" ? claim : {};
        input.assertCurrent?.();
        effect();
        return runtimeManagedRun(input);
      });
      const tool = wrap({
        name: "exec",
        label: "Exec",
        description: "Synthetic exec using the production process boundary",
        parameters: Type.Object({}),
        execute: async () => {
          const process = await runTestExecProcess();
          return { content: [], details: await process.promise };
        },
      });
      const pending = withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, receiptAuthority: () => true },
        () =>
          expectDefined(tool.execute, "Expected the prepared settle exec tool")("settle-exec", {}),
      );
      if (state === "current") {
        await expect(pending).resolves.toMatchObject({ details: { status: "completed" } });
        expect(effect).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow("authority is no longer active");
        expect(effect).not.toHaveBeenCalled();
      }
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
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

  it("rejects a sandbox without a backend-owned exec specification", async () => {
    await expect(runTestExecProcess({ sandbox: sandboxDirectories })).rejects.toThrow(
      "sandbox backend does not provide buildExecSpec",
    );

    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

  it("settles the registered session once when sandbox authorization fails before spawn", async () => {
    const registry = await import("./bash-process-registry.js");
    const sessionIds = await import("./bash-process-id.js");
    const sessionId = "sandbox-preparation-failure";
    using _ = vi.spyOn(sessionIds, "createProcessSessionId").mockReturnValue(sessionId);
    const preparation = createDeferred<ReturnType<typeof sandboxSpec>>();
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    const onSettledBeforeNotify = vi.fn();
    const { events } = captureCompletions("agent:main:sandbox-preparation");
    const failure = new Error("approval directory changed");
    const beforeSpawn = vi.fn(async () => {
      throw failure;
    });

    const pending = runTestExecProcess({
      sandbox: {
        ...sandboxDirectories,
        buildExecSpec: async () => await preparation.promise,
        finalizeExec,
      },
      sessionKey: "agent:main:sandbox-preparation",
      onSettledBeforeNotify,
      beforeSpawn,
    });

    expect(registry.getSession(sessionId)).toMatchObject({ exited: false });
    expect(beforeSpawn).not.toHaveBeenCalled();
    preparation.resolve(sandboxSpec());
    await expect(pending).rejects.toBe(failure);
    await nextImmediate();

    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn).not.toHaveBeenCalled();
    expect(registry.getSession(sessionId)).toBeUndefined();
    expect(onSettledBeforeNotify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "failed", failureKind: "runtime-error" }),
    );
    expect(events).toEqual([
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
  });
});

it("keeps suspension busy until failed cleanup settles after a process timeout", async () => {
  const exit = createDeferred<RunExit>();
  const finalization = createDeferred();
  const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(
    async () => await finalization.promise,
  );
  let producer: SpawnInput | undefined;
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
    producer = input;
    return managedExit(input, () => exit.promise, "sandbox output\n", "sandbox-run");
  });

  const run = await runTestExecProcess({
    sandbox: {
      ...sandboxDirectories,
      buildExecSpec: async () => sandboxSpec("sandbox-token"),
      finalizeExec,
    },
    notifyOnExit: true,
    sessionKey: "agent:main:main",
  });
  markBackgrounded(run.session);
  expect(getActiveBackgroundExecSessionCount()).toBe(1);

  exit.resolve(
    createRunExit({
      reason: "overall-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
      timedOut: true,
    }),
  );
  await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
  expect(run.session.finalizing).toBe(true);
  producer?.onStderr?.("during cleanup\n");
  expect(getFinishedSession(run.session.id)).toBeUndefined();

  const busy = prepareSuspension("before-finalize-overall-timeout");
  expect(busy).toMatchObject({
    status: "busy",
    blockers: expect.arrayContaining([
      expect.objectContaining({ kind: "background-exec", count: 1 }),
    ]),
  });
  expect(getActiveBackgroundExecSessionCount()).toBe(1);

  finalization.reject(new Error("sandbox finalize failed"));
  const outcome = await run.promise;

  expect(outcome).toMatchObject({
    status: "failed",
    failureKind: "overall-timeout",
    reason: expect.stringContaining("timed out"),
  });
  expect(finalizeExec).toHaveBeenCalledOnce();
  expect(getActiveBackgroundExecSessionCount()).toBe(0);
  expect(run.session.finalizing).toBe(false);
  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
  expect(requireSystemEventCall()[0]).toContain("Exec failed");
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

  const ready = prepareSuspension("after-finalize-overall-timeout");
  expect(ready.status).toBe("ready");
  if (ready.status === "ready") {
    expect(resumeGatewaySuspend(ready.suspensionId)).toMatchObject({ ok: true });
  }
});

describe("runExecProcess PTY fallback", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it.each([false, true])(
    "releases launch custody and only falls back before target initiation (initiated=%s)",
    async (initiated) => {
      let held = false;
      const heldAfterHandoff: boolean[] = [];
      const heldBeforePreparation: boolean[] = [];
      const nativeLaunch = vi.fn();
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        if (input.mode === "pty" && !initiated) {
          throw new Error("PTY unavailable before launch");
        }
        const launch = () => {
          expect(held).toBe(true);
          nativeLaunch();
        };
        if (input.initiateSpawn) {
          input.initiateSpawn(launch);
        } else {
          launch();
        }
        heldAfterHandoff.push(held);
        if (input.mode === "pty") {
          throw new Error("PTY readiness failed after launch");
        }
        return runtimeManagedRun(input, "ok");
      });
      const starting = runTestExecProcess({
        usePty: true,
        beforeSpawn: async () => {
          heldBeforePreparation.push(held);
          held = true;
          return undefined;
        },
        initiateSpawn: (launch) => launch(),
        releaseSpawn: () => {
          held = false;
        },
      });
      if (initiated) {
        await expect(starting).rejects.toThrow("PTY readiness failed after launch");
      } else {
        expect((await (await starting).promise).status).toBe("completed");
      }
      expect(nativeLaunch).toHaveBeenCalledOnce();
      expect(supervisorMock.spawn).toHaveBeenCalledTimes(initiated ? 1 : 2);
      expect(heldAfterHandoff).toEqual([false]);
      expect(heldBeforePreparation).toEqual(initiated ? [false] : [false, false]);
      expect(held).toBe(false);
    },
  );

  it("emits bounded process diagnostics without command text", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
      runtimeManagedRun(input, "ok"),
    );
    const { events, metadata } = captureCompletions();
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
    await nextImmediate();

    const event = expectDefined(events[0], "Expected exec process completed event");
    // The payload stays untrusted, but exporters need the ambient trace context marked
    // OpenClaw-owned or the exec span cannot be nested under the run that spawned it.
    expect(metadata.get(event)).toMatchObject({ trusted: false, trustedTraceContext: true });
    expect(event).toMatchObject({
      type: "exec.process.completed",
      target: "host",
      mode: "child",
      outcome: "completed",
      commandLength: command.length,
      exitCode: 0,
      sessionKey: "session-1",
    });
    expect(typeof event.durationMs).toBe("number");
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("printf");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain(process.cwd());
  });
});

describe("runExecProcess Gateway credential withholding", () => {
  afterEach(() => {
    setGatewayCredentialEnvKeys("hooks.token", []);
    vi.unstubAllEnvs();
  });

  async function launchAfterReload(requestedNewValue?: string) {
    vi.stubEnv("OLD_HOOK_TOKEN", "synthetic-old-hook-token");
    vi.stubEnv("NEW_HOOK_TOKEN", "synthetic-new-hook-token");
    // Prepare while hooks.token still references OLD_HOOK_TOKEN.
    setGatewayCredentialEnvKeys("hooks.token", ["OLD_HOOK_TOKEN"]);
    const prepared = sanitizeHostExecEnv({
      overrides: requestedNewValue ? { NEW_HOOK_TOKEN: requestedNewValue } : undefined,
    });
    expect(prepared).not.toHaveProperty("OLD_HOOK_TOKEN");
    expect(prepared).toHaveProperty("NEW_HOOK_TOKEN");
    const launchedEnvs: Array<SpawnInput["env"]> = [];
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      launchedEnvs.push(input.env);
      return runtimeManagedRun(input, "ok");
    });
    const handle = await runTestExecProcess({
      env: prepared,
      workdir: process.cwd(),
      // Approval revalidation is the last await before launch; hooks.token reloads here.
      beforeSpawn: async () => {
        setGatewayCredentialEnvKeys("hooks.token", ["NEW_HOOK_TOKEN"]);
        return undefined;
      },
    });
    expect((await handle.promise).status).toBe("completed");
    expect(launchedEnvs).toHaveLength(1);
    return launchedEnvs[0];
  }

  it("withholds a hook token source activated after the env was prepared", async () => {
    const launched = await launchAfterReload();
    expect(launched).not.toHaveProperty("NEW_HOOK_TOKEN");
    expect(launched).not.toHaveProperty("OLD_HOOK_TOKEN");
    expect(launched).toHaveProperty("PATH");
  });

  it("keeps a value the request supplied for the newly active name", async () => {
    const launched = await launchAfterReload("requested-value");
    expect(launched?.NEW_HOOK_TOKEN).toBe("requested-value");
  });
});

it.each([
  ["empty timeout", undefined, undefined],
  [
    "UTF-16 tail boundary",
    `${"a".repeat(101)}🎉${"b".repeat(179)}${"c".repeat(220)}`,
    "b".repeat(179),
  ],
] as const)("preserves timeout notification policy for %s", async (_name, stdout, head) => {
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
    managedExit(
      input,
      async () => {
        await nextImmediate();
        return createRunExit({
          reason: "overall-timeout",
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 10,
          timedOut: true,
        });
      },
      stdout,
    ),
  );

  const run = await runTestExecProcess({
    command: "sleep 999",
    notifyOnExit: true,
    notifyOnExitEmptySuccess: false,
    sessionKey: "agent:main:main",
  });
  markBackgrounded(run.session);
  const outcome = await run.promise;
  expect(outcome.status).toBe("failed");
  const [message, options] = requireSystemEventCall();
  expect(message).toContain("Exec failed");
  expect(message).toContain("external side effects may already have completed");
  expect(message).toContain("Verify the resulting state before retrying");
  expect(message).toContain("Do not automatically rerun commands unless repeating them is safe");
  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
  expect(options).toMatchObject({
    sessionKey: "agent:main:main",
    source: "exec",
    expectedTarget: expect.objectContaining({ sessionKey: "agent:main:main" }),
  });
  if (head) {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).not.toContain("�");
    expect(message).toContain("…");
    expect(message).toContain(head);
  }
});

it("preserves independent stdout and stderr parser state", async () => {
  const chunks = [
    ["onStdout", "out\u001B["],
    ["onStderr", "err\u001B["],
    ["onStdout", "32mOUT"],
    ["onStderr", "31mERR"],
  ] as const;
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
    for (const [stream, chunk] of chunks) {
      input[stream]?.(chunk);
    }
    return runtimeManagedRun(input);
  });
  const identity = { runId: "output-owner", sessionId: "output-session" };
  const updates: string[] = [];
  const outcome = await withExecRequestTurn({ identity }, async () => {
    const run = await runTestExecProcess({
      requestOwners: captureExecRequestOwners(identity),
      onUpdate: (update) => {
        if (update.details?.status === "running") {
          updates.push(update.details.tail ?? "");
        }
      },
    });
    return run.promise;
  });
  expect(outcome.aggregated).toBe("outerrOUTERR");
  expect(outcome.aggregated).not.toContain("\\x1b");
  expect(updates.at(-1)).toBe("outerrOUTERR");
});
