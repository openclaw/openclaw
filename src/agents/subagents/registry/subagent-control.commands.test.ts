// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { stopSubagentsForRequester } from "../../../auto-reply/reply/abort-operation.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-descendants.js";
import { withExecRequestTurn } from "../../../infra/exec-request-context.js";
import { getProcessSupervisor } from "../../../process/supervisor/index.js";
import { beginSessionEffect } from "../../../sessions/session-controller.lifecycle.js";
import { isPidDefinitelyDead } from "../../../shared/pid-alive.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { captureExecRequestCancellation } from "../../bash-process-control.js";
import * as commandControl from "../../bash-process-control.js";
import {
  deleteSession,
  getFinishedSession,
  getSession,
  waitForExecSession,
  type ProcessSession,
} from "../../bash-process-registry.js";
import { createLazyExecTool } from "../../lazy-exec-tool.js";
import { isAgentRunDirectAbortReason } from "../../run-termination.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { killSessionSubagentRuns } from "./subagent-control-kill.js";
import * as killSession from "./subagent-control-session.js";
import { createControlRunFixture } from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { startQueuedSubagentRun } from "./subagent-registry.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const runs = createControlRunFixture(() => fixture.stateDir);

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});

function withCommands<T>(
  commands: ProcessSession[],
  identity: { runId: string; sessionKey: string; sessionId: string; agentId: string },
  body: (start: (background?: boolean, callId?: string) => Promise<ProcessSession>) => Promise<T>,
  abortSignal?: AbortSignal,
) {
  return withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
    withExecRequestTurn({ identity, abortSignal }, async () => {
      const exec = createLazyExecTool({
        ...identity,
        config: getRuntimeConfig(),
        cwd: fixture.stateDir,
        scopeKey: identity.sessionKey,
        host: "gateway",
        mode: "full",
        ask: "off",
        allowBackground: true,
        notifyOnExit: false,
        preparedStoreEnvironment: {},
      });
      return body(async (background = false, callId = "child-command") => {
        const result = await exec.execute(
          callId,
          {
            command: `node -e "require('fs').watch('.', () => {})"`,
            ...(background ? { background: true } : { yieldMs: 10 }),
            timeoutSeconds: 60,
          },
          abortSignal,
        );
        const details = asOptionalRecord(result.details);
        expect(details?.status).toBe("running");
        if (typeof details?.sessionId !== "string") {
          throw new Error("Expected a running command's process handle");
        }
        const command = expectDefined(getSession(details.sessionId), "child command");
        commands.push(command);
        return command;
      });
    }),
  );
}

function controllerFor(controllerSessionKey: string) {
  return {
    controllerSessionKey,
    controllerAgentId: "main",
    callerSessionKey: controllerSessionKey,
    callerIsSubagent: false,
    controlScope: "children" as const,
  };
}

async function writeCommandSession(sessionKey: string, sessionId: string) {
  return runs.writeSession(sessionId, `${sessionId}-revision`, {
    sessionKey,
    defaultSessionId: sessionId,
  });
}

async function drainCommands(commands: ProcessSession[]) {
  for (const command of commands) {
    getProcessSupervisor().cancel(command.id, "manual-cancel");
  }
  await Promise.all(commands.map(waitForExecSession));
}

const parentKey = "agent:main:main";
const identity = (runId: string, sessionKey: string, sessionId: string) => ({
  runId,
  sessionKey,
  sessionId,
  agentId: "main",
});
function interceptPreparation(
  prepareRead: (original: () => Promise<void> | undefined) => Promise<void> | undefined,
) {
  const prepare = killSession.prepareSubagentKillSession;
  vi.spyOn(killSession, "prepareSubagentKillSession").mockImplementation(async (...args) => {
    const session = await prepare(...args);
    return { ...session, prepareRead: () => prepareRead(session.prepareRead) };
  });
}
function expectEvicted(command: ProcessSession) {
  expect(getSession(command.id)).toBeUndefined();
  expect(getFinishedSession(command.id)).toBeUndefined();
}
function expectServiceSurvives(command: ProcessSession) {
  expect(command.exited).toBe(false);
  expect(command.cancellationRequested).not.toBe(true);
}
function expectRetained(entry: ReturnType<typeof createSubagentRunRecord>) {
  expect(subagentRuns.get(entry.runId)).toEqual(entry);
  expect(loadSubagentRegistryFromSqlite().get(entry.runId)).toEqual(entry);
}

it.each([
  "owned",
  "legacy-owned",
  "other-controller",
  "new-generation",
  "admin-root",
  "gateway",
  "gateway-error",
  "channel",
  "lifecycle",
  "nested",
  "preaccept-revoked",
  "postaccept-revoked",
  "alternate-freshness-failed",
  "alternate-superseded",
] as const)(
  "parent Stop drains completed-child commands only for its %s selection",
  async (selection) => {
    const requesterSessionKey = parentKey;
    const childSessionKey = "agent:main:subagent:completed-command";
    const sessionId = "completed-command-session";
    await writeCommandSession(childSessionKey, sessionId);
    const commands: ProcessSession[] = [];
    let authorized = true;
    let captured = false;
    let injected = false;
    const alternate = selection.startsWith("alternate-");
    const shouldCancel = ![
      "other-controller",
      "new-generation",
      "admin-root",
      "preaccept-revoked",
    ].includes(selection);
    const supervisor = getProcessSupervisor();
    const spawn = supervisor.spawn.bind(supervisor);
    const spawnFault = vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
      const managed = await spawn(input);
      if (!alternate && selection !== "postaccept-revoked") {
        return managed;
      }
      return {
        ...managed,
        waitForExtinction: async () => {
          const outcome = await managed.waitForExtinction?.();
          if (selection === "postaccept-revoked") {
            authorized = false;
            return outcome;
          }
          return {
            status: "uncertain",
            reason: "job-observation-failed",
            cause: new Error("Synthetic completed command cleanup uncertainty"),
          } as const;
        },
      };
    });
    const startCommands = (
      runId: string,
      includeService: boolean,
      target = { sessionKey: childSessionKey, sessionId },
    ) =>
      withCommands(commands, { runId, ...target, agentId: "main" }, async (start) => {
        const ordinary = await start();
        return includeService ? [ordinary, await start(true)] : [ordinary];
      });
    const createdAt = Date.now();
    const completed = (
      runId: string,
      generation: number,
      overrides: Partial<SubagentRunRecordOverrides> = {},
    ) =>
      createSubagentRunRecord({
        runId,
        generation,
        childSessionKey,
        childAgentId: "main",
        childSessionIdentity: { sessionId, lifecycleRevision: `${sessionId}-revision` },
        requesterSessionKey,
        controllerSessionKey: requesterSessionKey,
        requesterAgentId: "main",
        createdAt: createdAt + generation,
        endedAt: createdAt + generation + 1,
        outcome: { status: "ok" },
        expectsCompletionMessage: false,
        ...overrides,
      });
    const original = completed("completed-command-run", 1);
    if (selection === "legacy-owned") {
      delete original.childSessionIdentity!.lifecycleRevision;
    }
    const publish = async (entry: typeof original) =>
      mutateSubagentRuns([entry.runId], () => ({
        value: undefined,
        postimages: new Map([[entry.runId, entry]]),
      }));
    try {
      const [ordinary, service] = await startCommands(original.runId, true);
      const ordinaryCommand = expectDefined(ordinary, "ordinary child command");
      const independentService = expectDefined(service, "independent child service");
      await publish(original);
      const receipt = structuredClone(
        expectDefined(subagentRuns.get(original.runId), "completed child"),
      );
      let nestedCommand: ProcessSession | undefined;
      let nestedReceipt: typeof original | undefined;
      if (selection === "nested") {
        const nestedKey = "agent:main:subagent:nested-completed-command";
        const nestedId = "nested-completed-command-session";
        await writeCommandSession(nestedKey, nestedId);
        const nested = completed("nested-completed-command", 1, {
          childSessionKey: nestedKey,
          childSessionIdentity: {
            sessionId: nestedId,
            lifecycleRevision: `${nestedId}-revision`,
          },
          requesterSessionKey: childSessionKey,
          controllerSessionKey: childSessionKey,
        });
        await publish(nested);
        nestedReceipt = structuredClone(
          expectDefined(subagentRuns.get(nested.runId), "nested child"),
        );
        nestedCommand = (
          await startCommands(nested.runId, false, { sessionKey: nestedKey, sessionId: nestedId })
        )[0];
      }
      const controllerKey =
        selection === "other-controller" ? "agent:main:other" : requesterSessionKey;
      const successor = completed("replacement-command-run", 2);
      let successorCommand: ProcessSession | undefined;
      let execAborted = false;
      const capture = commandControl.captureExecRequestCancellation;
      vi.spyOn(commandControl, "captureExecRequestCancellation").mockImplementation((...args) => {
        const plan = capture(...args);
        if (args[0].runId === original.runId) {
          captured = true;
        }
        return plan;
      });
      interceptPreparation((prepareRead) => {
        if (captured && !injected && (alternate || selection === "preaccept-revoked")) {
          injected = true;
          if (selection === "preaccept-revoked") {
            authorized = false;
            throw new Error("Synthetic preaccept authority revoked");
          }
          capture(identity(original.runId, childSessionKey, sessionId)).cancel();
          return (async () => {
            await waitForExecSession(ordinaryCommand);
            deleteSession(ordinaryCommand.id);
            if (selection === "alternate-superseded") {
              await publish(successor);
              successorCommand = (await startCommands(successor.runId, false))[0];
              return;
            }
            throw new Error("Synthetic freshness read failed after accepted cancellation");
          })();
        }
        return prepareRead();
      });
      if (selection === "gateway" || selection === "gateway-error") {
        const parent = capture({ sessionKey: requesterSessionKey, agentId: "main" });
        const result = await abortControlledSubagents({
          cfg: getRuntimeConfig(),
          sessionKey: requesterSessionKey,
          agentId: "main",
          execCancellation:
            selection === "gateway-error"
              ? {
                  ...parent,
                  settle: async () => {
                    throw new Error("Synthetic parent command cleanup failed");
                  },
                }
              : parent,
        });
        expect(result).toMatchObject({
          status: selection === "gateway-error" ? "error" : "ok",
          killed: 0,
          labels: [],
          execAborted: true,
        });
        if (selection === "gateway-error") {
          expect(result).toMatchObject({
            error: expect.stringContaining("Synthetic parent command cleanup failed"),
          });
        }
        execAborted = result?.execAborted === true;
      } else if (selection === "channel") {
        const result = await stopSubagentsForRequester({
          cfg: getRuntimeConfig(),
          requesterSessionKey,
          requesterAgentId: "main",
        });
        expect(result).toEqual({ stopped: 0, failed: 0, execAborted: true });
        execAborted = result.execAborted === true;
      } else if (selection === "lifecycle") {
        const result = await killSessionSubagentRuns({
          cfg: getRuntimeConfig(),
          sessionKey: requesterSessionKey,
          agentId: "main",
        });
        expect(result).toMatchObject({ status: "ok", killed: 0, execAborted: true });
        execAborted = result.execAborted === true;
      } else if (selection === "admin-root") {
        const result = await killSubagentRunAdmin({
          cfg: getRuntimeConfig(),
          sessionKey: childSessionKey,
          agentId: "main",
        });
        expect(result).toMatchObject({ found: true, killed: false });
      } else {
        const result = await killAllControlledSubagentRuns({
          cfg: getRuntimeConfig(),
          controller: controllerFor(controllerKey),
          runs: [original],
          suppressTaskDelivery: true,
          assertCurrent: () => {
            if (!authorized) {
              throw new Error("Synthetic caller authority revoked");
            }
          },
          beforeKill: async () => {
            if (selection === "new-generation") {
              await publish(successor);
              successorCommand = (await startCommands(successor.runId, false))[0];
            }
            return true;
          },
        });
        expect(result).toMatchObject({
          status:
            alternate || selection === "preaccept-revoked" || selection === "postaccept-revoked"
              ? "error"
              : "ok",
          killed: 0,
          labels: [],
        });
        if (alternate) {
          expect(injected).toBe(true);
          expectEvicted(ordinaryCommand);
          expect(result).toMatchObject({
            error: expect.stringContaining("command cleanup could not be confirmed"),
          });
          if (selection === "alternate-freshness-failed") {
            expect(result).toMatchObject({
              error: expect.stringContaining("Synthetic freshness read failed"),
            });
          }
        }
        execAborted = result.execAborted === true;
      }
      expect(execAborted).toBe(shouldCancel);
      expect(ordinaryCommand.exited).toBe(shouldCancel);
      if (shouldCancel) {
        expect(ordinaryCommand.exitReason).toBe("manual-cancel");
        expect(ordinaryCommand.finalizationFailed === true).toBe(alternate);
      }
      expectServiceSurvives(independentService);
      if (nestedReceipt) {
        expect(expectDefined(nestedCommand, "nested command")).toMatchObject({
          exited: true,
          exitReason: "manual-cancel",
        });
        expectRetained(nestedReceipt);
      }
      expectRetained(receipt);
      if (selection === "new-generation" || selection === "alternate-superseded") {
        expect(expectDefined(successorCommand, "replacement command").exited).toBe(false);
        expect(subagentRuns.get(successor.runId)).toEqual(successor);
      }
    } finally {
      spawnFault.mockRestore();
      await drainCommands(commands);
      for (const command of commands) {
        deleteSession(command.id);
      }
    }
  },
);

it.each([
  "confirmed",
  "uncertain",
  "failed",
  "evicted",
  "late-evicted",
  "late-revoked-evicted",
  "late-owner-evicted",
] as const)(
  "parent cancellation reports %s command cleanup and preserves an independent service",
  async (cleanup) => {
    const requesterSessionKey = parentKey;
    const childSessionKey = "agent:main:subagent:active-command";
    const sessionId = "active-command-session";
    const runId = "active-command-run";
    const storePath = await writeCommandSession(childSessionKey, sessionId);
    await runs.register(runId, storePath, {
      childSessionKey,
      requesterSessionKey,
      requesterAgentId: "main",
      requesterDisplayKey: requesterSessionKey,
      task: "Run an ordinary command and an independent service",
      cleanup: "keep",
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
    });
    expect(await startQueuedSubagentRun(runId)).toBe(true);
    const controller = new AbortController();
    let callerAuthorized = true;
    const ready = createDeferred();
    const interrupted = createDeferred();
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      run: identity(runId, childSessionKey, sessionId),
      assertAllowed: () => {},
      onInterrupt: (reason) => {
        // The native kill owner supplies the reason; the admitted command relays it.
        controller.abort(reason);
        interrupted.resolve();
        if (cleanup === "late-revoked-evicted") {
          callerAuthorized = false;
        }
        return { runId };
      },
    });
    const commands: ProcessSession[] = [];
    const late = cleanup === "late-evicted" || cleanup === "late-revoked-evicted";
    const lateOwner = cleanup === "late-owner-evicted";
    const order: string[] = [];
    const requested = createDeferred();
    const registered = createDeferred();
    let captured = false;
    let lateStarted = false;
    const supervisor = getProcessSupervisor();
    const spawn = supervisor.spawn.bind(supervisor);
    let faultInjected = false;
    let rootExitObserved = false;
    const spawnFault = vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
      const managed = await spawn(input);
      if (
        cleanup === "confirmed" ||
        input.scopeKey !== childSessionKey ||
        faultInjected ||
        (late && !lateStarted)
      ) {
        return managed;
      }
      faultInjected = true;
      return {
        ...managed,
        waitForExtinction: async () => {
          await managed.wait();
          await managed.waitForExtinction?.();
          rootExitObserved = isPidDefinitelyDead(
            expectDefined(managed.pid, "ordinary command pid"),
          );
          if (cleanup === "uncertain") {
            return {
              status: "uncertain",
              reason: "job-observation-failed",
              cause: new Error("Synthetic cleanup certification failure"),
            } as const;
          }
          order.push("cleanup-failed");
          throw new Error("Synthetic command finalization failure");
        },
      };
    });
    let childSettled = false;
    let recordEvicted = false;
    const execution = admission
      .run(async () => {
        if (lateOwner) {
          ready.resolve();
          await requested.promise;
        }
        return withCommands(
          commands,
          identity(runId, childSessionKey, sessionId),
          async (start) => {
            if (lateOwner) {
              order.push("owner-created");
            }
            for (const background of [false, true]) {
              await start(background, background ? "independent-service" : "ordinary-command");
            }
            if (lateOwner) {
              lateStarted = true;
              order.push("registered");
              registered.resolve();
            }
            ready.resolve();
            if (late) {
              await requested.promise;
              lateStarted = true;
              await start(false, "late-ordinary-command");
              order.push("registered");
              registered.resolve();
            }
            await interrupted.promise;
          },
          controller.signal,
        );
      })
      .finally(() => {
        // Result eviction can precede the native kill owner's cleanup verdict.
        const ordinary = commands[late ? 2 : 0];
        if ((cleanup === "evicted" || late || lateOwner) && ordinary?.exited) {
          deleteSession(ordinary.id);
          recordEvicted = true;
          order.push("evicted");
        }
        childSettled = true;
        admission.release();
      });
    void execution.catch((error: unknown) => {
      ready.reject(error);
      registered.reject(error);
    });
    void registered.promise.catch(() => {});
    let stopping: ReturnType<typeof killAllControlledSubagentRuns> | undefined;
    try {
      await ready.promise;
      if (late || lateOwner) {
        const capture = commandControl.captureExecRequestCancellation;
        vi.spyOn(commandControl, "captureExecRequestCancellation").mockImplementation((...args) => {
          const plan = capture(...args);
          if (args[0].runId === runId && !captured) {
            captured = true;
            if (lateOwner) {
              expect(plan.owners).toHaveLength(0);
            }
            order.push("captured");
          }
          return plan;
        });
        interceptPreparation((prepareRead) => {
          if (captured && !lateStarted) {
            requested.resolve();
            return registered.promise;
          }
          return prepareRead();
        });
        controller.signal.addEventListener("abort", () => order.push("cancel-accepted"), {
          once: true,
        });
      }
      const observation =
        cleanup === "uncertain"
          ? captureExecRequestCancellation(identity(runId, childSessionKey, sessionId))
          : undefined;
      stopping = killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: controllerFor(requesterSessionKey),
        runs: [expectDefined(subagentRuns.get(runId), "running child")],
        assertCurrent: () => {
          if (!callerAuthorized) {
            throw new Error("Synthetic caller revoked after native cancellation acceptance");
          }
        },
        suppressTaskDelivery: true,
      });
      const result = await stopping;
      order.push("stop-settled");
      if (late || lateOwner) {
        expect(order).toEqual([
          "captured",
          ...(lateOwner ? ["owner-created"] : []),
          "registered",
          "cancel-accepted",
          "cleanup-failed",
          "evicted",
          "stop-settled",
        ]);
      }
      expect(faultInjected).toBe(cleanup !== "confirmed");
      if (faultInjected) {
        expect(rootExitObserved).toBe(true);
      }
      expect(result).toMatchObject({
        status: cleanup === "confirmed" ? "ok" : "error",
        killed: 1,
        ...(cleanup !== "confirmed"
          ? { error: expect.stringContaining("command cleanup could not be confirmed") }
          : {}),
      });
      if (cleanup === "late-revoked-evicted") {
        expect(result).toMatchObject({
          error: expect.stringContaining(
            "Synthetic caller revoked after native cancellation acceptance",
          ),
        });
      }
      if (observation) {
        // This plan never requested cancellation; native Stop accepted it through another owner.
        await expect(observation.settle()).rejects.toThrow(
          "command cleanup could not be confirmed",
        );
      }
      expect(isAgentRunDirectAbortReason(controller.signal.reason)).toBe(true);
      expect(childSettled).toBe(true);
      await execution;
      const ordinary = expectDefined(commands[late ? 2 : 0], "ordinary child command");
      const service = expectDefined(commands[1], "independent child service");
      expect(ordinary).toMatchObject({ exited: true, exitReason: "manual-cancel" });
      expect(ordinary.finalizationFailed === true).toBe(cleanup !== "confirmed");
      if (cleanup === "uncertain") {
        expect(ordinary.cleanupUncertain).toBe(true);
      }
      if (cleanup === "evicted" || late || lateOwner) {
        expect(recordEvicted).toBe(true);
        expectEvicted(ordinary);
      }
      expectServiceSurvives(service);
      expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("killed");
    } finally {
      spawnFault.mockRestore();
      controller.abort();
      requested.resolve();
      interrupted.resolve();
      await drainCommands(commands);
      await execution.catch(() => {});
      admission.release();
      await stopping?.catch(() => {});
      for (const command of commands) {
        deleteSession(command.id);
      }
    }
  },
);
