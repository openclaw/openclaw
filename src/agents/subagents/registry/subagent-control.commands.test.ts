// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { stopSubagentsForRequester } from "../../../auto-reply/reply/abort-operation.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-descendants.js";
import { withExecRequestTurn } from "../../../infra/exec-request-context.js";
import { getProcessSupervisor } from "../../../process/supervisor/index.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
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
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import * as killSession from "./subagent-control-session.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun, startQueuedSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();

it.each([
  "owned",
  "other-controller",
  "new-generation",
  "admin-root",
  "gateway",
  "gateway-error",
  "channel",
  "nested",
  "preaccept-revoked",
  "postaccept-revoked",
  "alternate-freshness-failed",
  "alternate-superseded",
] as const)(
  "parent Stop drains completed-child commands only for its %s selection",
  async (selection) => {
    const requesterSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:completed-command";
    const sessionId = "completed-command-session";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: sessionId,
    });
    const commands: ProcessSession[] = [];
    let authorized = true;
    let captured = false;
    let injected = false;
    const alternate = selection.startsWith("alternate-");
    const shouldCancel =
      selection === "owned" ||
      selection === "postaccept-revoked" ||
      selection === "gateway" ||
      selection === "gateway-error" ||
      selection === "channel" ||
      selection === "nested" ||
      alternate;
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
      withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
        withExecRequestTurn(
          {
            identity: { runId, ...target, agentId: "main" },
          },
          async () => {
            const exec = createLazyExecTool({
              runId,
              ...target,
              agentId: "main",
              config: getRuntimeConfig(),
              cwd: fixture.stateDir,
              scopeKey: target.sessionKey,
              host: "gateway",
              mode: "full",
              ask: "off",
              allowBackground: true,
              notifyOnExit: false,
              preparedStoreEnvironment: {},
            });
            const started: ProcessSession[] = [];
            for (const background of includeService ? [false, true] : [false]) {
              const result = await exec.execute("child-command", {
                command: `node -e "require('fs').watch('.', () => {})"`,
                ...(background ? { background: true } : { yieldMs: 10 }),
                timeoutSeconds: 60,
              });
              const details = asOptionalRecord(result.details);
              expect(details?.status).toBe("running");
              if (typeof details?.sessionId !== "string") {
                throw new Error("Expected a running command's process handle");
              }
              const command = expectDefined(getSession(details.sessionId), "child command");
              commands.push(command);
              started.push(command);
            }
            return started;
          },
        ),
      );
    const createdAt = Date.now();
    const completed = (runId: string, generation: number) =>
      createSubagentRunRecord({
        runId,
        generation,
        childSessionKey,
        childAgentId: "main",
        childSessionIdentity: { sessionId },
        requesterSessionKey,
        controllerSessionKey: requesterSessionKey,
        requesterAgentId: "main",
        createdAt: createdAt + generation,
        endedAt: createdAt + generation + 1,
        outcome: { status: "ok" },
        expectsCompletionMessage: false,
        completion: {
          required: false,
          resultText: "Completed child result",
          capturedAt: createdAt + generation + 1,
        },
        delivery: { status: "not_required" },
      });
    const original = completed("completed-command-run", 1);
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
        await writeSubagentSessionEntry({
          stateDir: fixture.stateDir,
          agentId: "main",
          sessionKey: nestedKey,
          defaultSessionId: nestedId,
        });
        const nested = createSubagentRunRecord({
          runId: "nested-completed-command",
          generation: 1,
          childSessionKey: nestedKey,
          childAgentId: "main",
          childSessionIdentity: { sessionId: nestedId },
          requesterSessionKey: childSessionKey,
          controllerSessionKey: childSessionKey,
          requesterAgentId: "main",
          createdAt,
          endedAt: createdAt + 1,
          outcome: { status: "ok" },
          expectsCompletionMessage: false,
          completion: {
            required: false,
            resultText: "Completed nested result",
            capturedAt: createdAt + 1,
          },
          delivery: { status: "not_required" },
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
      const prepare = killSession.prepareSubagentKillSession;
      vi.spyOn(killSession, "prepareSubagentKillSession").mockImplementation(async (...args) => {
        const session = await prepare(...args);
        return {
          ...session,
          prepareRead: () => {
            if (captured && !injected && (alternate || selection === "preaccept-revoked")) {
              injected = true;
              if (selection === "preaccept-revoked") {
                authorized = false;
                throw new Error("Synthetic preaccept authority revoked");
              }
              capture({
                runId: original.runId,
                sessionKey: childSessionKey,
                sessionId,
                agentId: "main",
              }).cancel();
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
            return session.prepareRead();
          },
        };
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
          controller: {
            controllerSessionKey: controllerKey,
            controllerAgentId: "main",
            callerSessionKey: controllerKey,
            callerIsSubagent: false,
            controlScope: "children",
          },
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
          expect(getSession(ordinaryCommand.id)).toBeUndefined();
          expect(getFinishedSession(ordinaryCommand.id)).toBeUndefined();
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
      expect(independentService.exited).toBe(false);
      expect(independentService.cancellationRequested).not.toBe(true);
      if (nestedReceipt) {
        expect(expectDefined(nestedCommand, "nested command")).toMatchObject({
          exited: true,
          exitReason: "manual-cancel",
        });
        expect(subagentRuns.get(nestedReceipt.runId)).toEqual(nestedReceipt);
        expect(loadSubagentRegistryFromSqlite().get(nestedReceipt.runId)).toEqual(nestedReceipt);
      }
      expect(subagentRuns.get(original.runId)).toEqual(receipt);
      expect(loadSubagentRegistryFromSqlite().get(original.runId)).toEqual(receipt);
      if (selection === "new-generation" || selection === "alternate-superseded") {
        expect(expectDefined(successorCommand, "replacement command").exited).toBe(false);
        expect(subagentRuns.get(successor.runId)).toEqual(successor);
      }
    } finally {
      spawnFault.mockRestore();
      for (const command of commands) {
        getProcessSupervisor().cancel(command.id, "manual-cancel");
      }
      await Promise.all(commands.map(waitForExecSession));
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
    const requesterSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:active-command";
    const sessionId = "active-command-session";
    const runId = "active-command-run";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: sessionId,
    });
    await registerSubagentRun({
      runId,
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
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
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
    const lateCommandRequested = createDeferred();
    const lateCommandReady = createDeferred();
    const ownerRequested = createDeferred();
    const ownerCommandsReady = createDeferred();
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
          await ownerRequested.promise;
        }
        return withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
          withExecRequestTurn(
            {
              identity: { runId, sessionKey: childSessionKey, sessionId, agentId: "main" },
              abortSignal: controller.signal,
            },
            async () => {
              if (lateOwner) {
                order.push("owner-created");
              }
              const exec = createLazyExecTool({
                runId,
                sessionKey: childSessionKey,
                sessionId,
                agentId: "main",
                config: getRuntimeConfig(),
                cwd: fixture.stateDir,
                scopeKey: childSessionKey,
                host: "gateway",
                mode: "full",
                ask: "off",
                allowBackground: true,
                notifyOnExit: false,
                preparedStoreEnvironment: {},
              });
              for (const background of [false, true]) {
                const result = await exec.execute(
                  background ? "independent-service" : "ordinary-command",
                  {
                    command: `node -e "require('fs').watch('.', () => {})"`,
                    ...(background ? { background: true } : { yieldMs: 10 }),
                    timeoutSeconds: 60,
                  },
                  controller.signal,
                );
                const details = asOptionalRecord(result.details);
                expect(details?.status).toBe("running");
                if (typeof details?.sessionId !== "string") {
                  throw new Error("Expected a running command's process handle");
                }
                commands.push(expectDefined(getSession(details.sessionId), "child command"));
              }
              if (lateOwner) {
                lateStarted = true;
                order.push("registered");
                ownerCommandsReady.resolve();
              }
              const startLateCommand = async () => {
                lateStarted = true;
                const result = await exec.execute(
                  "late-ordinary-command",
                  {
                    command: `node -e "require('fs').watch('.', () => {})"`,
                    yieldMs: 10,
                    timeoutSeconds: 60,
                  },
                  controller.signal,
                );
                const details = asOptionalRecord(result.details);
                if (typeof details?.sessionId !== "string") {
                  throw new Error("Expected late ordinary process handle");
                }
                commands.push(expectDefined(getSession(details.sessionId), "late child command"));
                order.push("registered");
              };
              ready.resolve();
              if (late) {
                await lateCommandRequested.promise;
                await startLateCommand();
                lateCommandReady.resolve();
              }
              await interrupted.promise;
            },
          ),
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
      lateCommandReady.reject(error);
      ownerCommandsReady.reject(error);
    });
    void lateCommandReady.promise.catch(() => {});
    void ownerCommandsReady.promise.catch(() => {});
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
        const prepare = killSession.prepareSubagentKillSession;
        vi.spyOn(killSession, "prepareSubagentKillSession").mockImplementation(async (...args) => {
          const session = await prepare(...args);
          return {
            ...session,
            prepareRead: () => {
              if (captured && !lateStarted) {
                if (lateOwner) {
                  ownerRequested.resolve();
                  return ownerCommandsReady.promise;
                }
                lateCommandRequested.resolve();
                return lateCommandReady.promise;
              }
              return session.prepareRead();
            },
          };
        });
        controller.signal.addEventListener("abort", () => order.push("cancel-accepted"), {
          once: true,
        });
      }
      const observation =
        cleanup === "uncertain"
          ? captureExecRequestCancellation({
              runId,
              sessionKey: childSessionKey,
              sessionId,
              agentId: "main",
            })
          : undefined;
      stopping = killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: {
          controllerSessionKey: requesterSessionKey,
          controllerAgentId: "main",
          callerSessionKey: requesterSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
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
      expect(
        result,
        JSON.stringify({
          result,
          order,
          native: {
            execution: subagentRuns.get(runId)?.execution,
            killIntent: subagentRuns.get(runId)?.killIntent,
            killReconciliation: subagentRuns.get(runId)?.killReconciliation,
          },
        }),
      ).toMatchObject({
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
        expect(getSession(ordinary.id)).toBeUndefined();
        expect(getFinishedSession(ordinary.id)).toBeUndefined();
      }
      expect(service.exited).toBe(false);
      expect(service.cancellationRequested).not.toBe(true);
      expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("killed");
    } finally {
      spawnFault.mockRestore();
      controller.abort();
      lateCommandRequested.resolve();
      ownerRequested.resolve();
      interrupted.resolve();
      for (const command of commands) {
        getProcessSupervisor().cancel(command.id, "manual-cancel");
      }
      await Promise.all(commands.map(waitForExecSession));
      await execution.catch(() => {});
      admission.release();
      await stopping?.catch(() => {});
      for (const command of commands) {
        deleteSession(command.id);
      }
    }
  },
);
