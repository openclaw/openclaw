import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { tryFastAbortFromMessage } from "../../../auto-reply/reply/abort.js";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  captureExecRequestOwners,
  withExecRequestOwners,
  withExecRequestTurn,
  type ExecRequestOwner,
} from "../../../infra/exec-request-context.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { captureExecRequestCancellation } from "../../bash-process-control.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import type { ResolvedSubagentController } from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerQueuedStopControlTests({
  addRun,
  controllerFor,
  cfgWithSessionStore,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
}: {
  addRun: (overrides: SubagentRunRecordOverrides) => Promise<SubagentRunRecord>;
  controllerFor: (sessionKey?: string) => ResolvedSubagentController;
  cfgWithSessionStore: (storePath: string) => OpenClawConfig;
  setSubagentControlDepsForTest: (
    overrides: Partial<typeof import("./subagent-control.runtime.js")>,
  ) => void;
  writeSessionStoreFixture: (label: string, store: Record<string, unknown>) => Promise<string>;
}) {
  it.for(["first cancellation await", "admin tree", "channel stop", "channel ACP lookup"])(
    "does not dispatch selected queued work during %s cancellation",
    async (kind, { signal }) => {
      const duringLookup = kind === "channel ACP lookup";
      const channelStop = kind === "channel stop" || duringLookup;
      const controllerSessionKey = "agent:main:main";
      const runningFixture = createSubagentRunRecord({
        runId: "running-collector",
        childSessionKey: "agent:main:subagent:running-collector",
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        task: "running collector",
        collect: true,
        createdAt: 1,
        startedAt: 2,
      });
      const queuedFixture = createSubagentRunRecord({
        ...runningFixture,
        runId: "queued-collector",
        childSessionKey: "agent:main:subagent:queued-collector",
        controllerSessionKey: kind.endsWith("tree")
          ? runningFixture.childSessionKey
          : controllerSessionKey,
        requesterSessionKey: kind.endsWith("tree")
          ? runningFixture.childSessionKey
          : controllerSessionKey,
        execution: { status: "queued" },
        swarmLaunchPending: true,
      });
      const running = await addRun(runningFixture);
      const queued = await addRun(queuedFixture);
      const storePath = await writeSessionStoreFixture("abort-dispatch", {
        [running.childSessionKey]: { sessionId: "running-session", updatedAt: 1 },
        ...(duringLookup
          ? {
              [controllerSessionKey]: {
                sessionId: "parent-session",
                lifecycleRevision: "parent-revision",
                updatedAt: 1,
              },
            }
          : {}),
      });
      const started: string[] = [];
      const firstDispatch = createDeferred<string>();
      for (const runId of [queued.runId, "unselected"]) {
        enqueueSwarmRun({
          groupId: "cancelled-group",
          runId,
          maxConcurrent: 1,
          activeRunIds: [running.runId],
          start: async () => {
            started.push(runId);
            firstDispatch.resolve(runId);
          },
          onStartFailure: () => true,
        });
      }
      setSubagentControlDepsForTest({
        isEmbeddedAgentRunActive: () => true,
        abortEmbeddedAgentRun: (sessionId) => {
          expect(sessionId).toBe("running-session");
          if (!channelStop && kind !== "first cancellation await") {
            expect(releaseSwarmRun(running.runId)).toBe(true);
          }
          return true;
        },
      });
      const controller = { ...controllerFor(controllerSessionKey), controllerAgentId: "main" };
      const cfg = cfgWithSessionStore(storePath);
      const parent = channelStop
        ? createReplyOperation({
            sessionKey: controllerSessionKey,
            sessionId: "parent-session",
            resetTriggered: false,
          })
        : undefined;
      parent?.attachBackend({
        kind: "embedded",
        cancel: () => {
          if (!duringLookup) {
            expect(releaseSwarmRun(running.runId)).toBe(true);
          }
        },
        isStreaming: () => true,
      });
      const lookupEntered = createDeferred();
      const releaseLookup = createDeferred();
      let stopDuringLookup: ReturnType<typeof tryFastAbortFromMessage> | undefined;
      let restoreLookup: (() => void) | undefined;
      const registry = duringLookup ? captureActivePluginRegistrySnapshot() : undefined;
      try {
        if (kind === "first cancellation await") {
          const cancellation = killAllControlledSubagentRuns({
            cfg,
            controller,
            runs: [running, queued],
          });
          // Natural terminal cleanup calls this same capacity owner while kill
          // admission is pending; no synthetic execution outcome is needed.
          expect(releaseSwarmRun(running.runId)).toBe(true);
          expect(await cancellation).toMatchObject({ status: "ok", killed: 2 });
        } else if (kind === "admin tree") {
          expect(
            await killSubagentRunAdmin({
              cfg,
              sessionKey: running.childSessionKey,
              expectedRunId: running.runId,
              expectedGeneration: running.generation,
              expectedOwnerKey: controllerSessionKey,
            }),
          ).toMatchObject({ found: true, killed: true, cascadeKilled: 1 });
        } else if (duringLookup) {
          setActivePluginRegistry(
            createTestRegistry([
              {
                pluginId: "stop-lookup",
                source: "test",
                plugin: {
                  ...createChannelTestPluginBase({ id: "stop-lookup" }),
                  conversationBindings: { supportsCurrentConversationBinding: true },
                },
              },
            ]),
          );
          const service = getSessionBindingService();
          const resolve = service.resolveByConversationAsync.bind(service);
          const lookup = vi
            .spyOn(service, "resolveByConversationAsync")
            .mockImplementationOnce(async (conversation) => {
              expect(conversation).toMatchObject({
                channel: "stop-lookup",
                conversationId: "room",
              });
              lookupEntered.resolve();
              await releaseLookup.promise;
              return resolve(conversation);
            });
          restoreLookup = () => lookup.mockRestore();
          stopDuringLookup = tryFastAbortFromMessage({
            cfg,
            ctx: buildTestCtx({
              CommandBody: "/stop",
              RawBody: "/stop",
              CommandAuthorized: true,
              Provider: "stop-lookup",
              Surface: "stop-lookup",
              SessionKey: controllerSessionKey,
              From: "stop-lookup:room",
              To: "stop-lookup:room",
            }),
          });
          await withinTest(
            awaitGateBeforeSettlement(
              lookupEntered.promise,
              stopDuringLookup,
              "Stop completed before its ACP lookup boundary",
            ),
            signal,
          );
          expect(parent?.abortSignal.aborted).toBe(false);
          const later = await addRun({
            runId: "later-human-native-root",
            childSessionKey: "agent:main:subagent:later-human-native-root",
            controllerSessionKey,
            requesterSessionKey: controllerSessionKey,
            requesterTurnRunId: "later-human-turn",
            task: "later human task",
          });
          expect(loadSessionEntry({ storePath, sessionKey: controllerSessionKey })?.sessionId).toBe(
            "parent-session",
          );
          expect(releaseSwarmRun(running.runId)).toBe(true);
          expect(await getSubagentRunByChildSessionKey(queued.childSessionKey)).toMatchObject({
            execution: { status: "queued" },
          });
          expect.soft(started, "selected FIFO head must remain held during ACP lookup").toEqual([]);
          releaseLookup.resolve();
          const stopped = await withinTest(stopDuringLookup, signal);
          const dispatched = await withinTest(firstDispatch.promise, signal);
          expect
            .soft(dispatched, "unselected work starts after the selected FIFO head retires")
            .toBe("unselected");
          expect
            .soft(stopped)
            .toMatchObject({ handled: true, stoppedSubagents: 2, failedSubagents: 0 });
          expect(
            (await getSubagentRunByChildSessionKey(later.childSessionKey))?.execution.endedAt,
          ).toBeUndefined();
          expect(parent?.abortSignal.aborted).toBe(true);
        } else {
          expect(
            await tryFastAbortFromMessage({
              cfg,
              ctx: buildTestCtx({
                CommandBody: "/stop",
                RawBody: "/stop",
                CommandAuthorized: true,
                Provider: "telegram",
                Surface: "telegram",
                SessionKey: controllerSessionKey,
                From: "telegram:queue-owner",
                To: "telegram:queue-owner",
              }),
            }),
          ).toMatchObject({ handled: true, stoppedSubagents: 2, failedSubagents: 0 });
          expect(parent?.abortSignal.aborted).toBe(true);
        }
        for (const entry of [running, queued]) {
          expect(await getSubagentRunByChildSessionKey(entry.childSessionKey)).toMatchObject({
            execution: { status: "terminal" },
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
          });
        }
        expect(
          started,
          "selected queued child must never dispatch during cancellation",
        ).not.toContain(queued.runId);
        await vi.waitFor(() => expect(started).toEqual(["unselected"]));
      } finally {
        releaseLookup.resolve();
        await stopDuringLookup?.catch(() => {});
        restoreLookup?.();
        if (registry) {
          restoreActivePluginRegistrySnapshot(registry);
        }
        parent?.complete();
        swarmSchedulerTesting.reset();
      }
    },
  );
}

export function registerRequestFrontierControlTests(fixture: { readonly stateDir: string }) {
  it.for(["success", "lookup rejected", "caller revoked"] as const)(
    "tracks only the original request's late native root across ACP lookup (%s)",
    async (phase, { signal }) => {
      const identity = {
        runId: "frontier-original-turn",
        sessionKey: "agent:main:main",
        sessionId: "frontier-parent-session",
        agentId: "main",
      };
      const childKey = "agent:main:subagent:frontier-original-child";
      const humanKey = "agent:main:subagent:frontier-human-child";
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        sessionKey: identity.sessionKey,
        agentId: "main",
        defaultSessionId: identity.sessionId,
        lifecycleRevision: "frontier-parent-revision",
      });
      for (const key of [childKey, humanKey]) {
        await writeSubagentSessionEntry({
          stateDir: fixture.stateDir,
          sessionKey: key,
          agentId: "main",
          defaultSessionId: `session-${key}`,
        });
      }
      const cfg = getRuntimeConfig();
      const parent = createReplyOperation({
        sessionKey: identity.sessionKey,
        sessionId: identity.sessionId,
        resetTriggered: false,
      });
      const cancelParent = vi.fn(() => {});
      parent.attachBackend({ kind: "embedded", cancel: cancelParent, isStreaming: () => true });
      const ownerEntered = createDeferred<readonly ExecRequestOwner[]>();
      const finishOriginal = createDeferred();
      const originalTurn = withExecRequestTurn({ identity }, async () => {
        ownerEntered.resolve(expectDefined(captureExecRequestOwners(identity), "original owners"));
        await finishOriginal.promise;
      });
      const lookupEntered = createDeferred();
      const releaseLookup = createDeferred();
      const firstDispatch = createDeferred<string>();
      const registry = captureActivePluginRegistrySnapshot();
      let current = true;
      let stopping: ReturnType<typeof tryFastAbortFromMessage> | undefined;
      let restoreLookup: (() => void) | undefined;
      try {
        const owners = await withinTest(
          awaitGateBeforeSettlement(
            ownerEntered.promise,
            originalTurn,
            "Original request completed before owner capture",
          ),
          signal,
        );
        expect(captureExecRequestCancellation(identity).owners).toEqual(owners);
        expect(subagentRuns.size).toBe(0);
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "stop-lookup",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "stop-lookup" }),
                conversationBindings: { supportsCurrentConversationBinding: true },
              },
            },
          ]),
        );
        const service = getSessionBindingService();
        const resolve = service.resolveByConversationAsync.bind(service);
        const lookupFailure = new Error("ACP lookup failed");
        const lookup = vi
          .spyOn(service, "resolveByConversationAsync")
          .mockImplementationOnce(async (conversation) => {
            expect(conversation).toMatchObject({ channel: "stop-lookup", conversationId: "room" });
            lookupEntered.resolve();
            await releaseLookup.promise;
            if (phase === "lookup rejected") {
              throw lookupFailure;
            }
            return resolve(conversation);
          });
        restoreLookup = () => lookup.mockRestore();
        stopping = tryFastAbortFromMessage({
          cfg,
          isCommandTargetCurrent: () => current,
          ctx: buildTestCtx({
            CommandBody: "/stop",
            RawBody: "/stop",
            CommandAuthorized: true,
            Provider: "stop-lookup",
            Surface: "stop-lookup",
            SessionKey: identity.sessionKey,
            From: "stop-lookup:room",
            To: "stop-lookup:room",
          }),
        });
        await withinTest(
          awaitGateBeforeSettlement(
            lookupEntered.promise,
            stopping,
            "Stop completed before its ACP lookup boundary",
          ),
          signal,
        );
        const runId = "frontier-original-child";
        for (const queuedId of [runId, "frontier-outside"]) {
          enqueueSwarmRun({
            groupId: "frontier-capacity",
            runId: queuedId,
            maxConcurrent: 1,
            activeRunIds: ["frontier-blocker"],
            start: async () => {
              firstDispatch.resolve(queuedId);
            },
            onStartFailure: () => true,
          });
        }
        const register = (
          childSessionKey: string,
          childRunId: string,
          requesterTurnRunId: string,
          requestOwners: readonly ExecRequestOwner[],
        ) =>
          registerSubagentRun(
            {
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: identity.sessionKey,
              requesterAgentId: "main",
              requesterTurnRunId,
              requesterDisplayKey: identity.sessionKey,
              task: "registered during ACP lookup",
              cleanup: "keep",
              collect: true,
              queued: true,
            },
            withExecRequestOwners({}, requestOwners),
          );
        await register(childKey, runId, identity.runId, owners);
        if (phase === "success") {
          finishOriginal.resolve();
          await withinTest(originalTurn, signal);
          parent.complete();
          expect(captureExecRequestCancellation(identity).owners).toEqual([]);
        }
        const humanIdentity = { ...identity, runId: "frontier-human-turn" };
        const humanOwners = await withExecRequestTurn({ identity: humanIdentity }, async () => {
          const captured = expectDefined(captureExecRequestOwners(humanIdentity), "human owners");
          expect(captured[0]).not.toBe(owners[0]);
          await register(humanKey, "frontier-human-child", humanIdentity.runId, captured);
          return captured;
        });
        const childBefore = expectDefined(
          await getSubagentRunByChildSessionKey(childKey),
          "published original child",
        ).execution;
        const humanBefore = expectDefined(
          await getSubagentRunByChildSessionKey(humanKey),
          "published human child",
        ).execution;
        expect(childBefore.status).toBe("queued");
        expect(humanBefore.status).toBe("queued");
        expect(loadSessionEntry({ storePath, sessionKey: identity.sessionKey })?.sessionId).toBe(
          identity.sessionId,
        );
        expect(parent.abortSignal.aborted).toBe(false);
        current = phase !== "caller revoked";
        releaseLookup.resolve();
        if (phase === "success") {
          expect(await withinTest(stopping, signal)).toMatchObject({
            handled: true,
            stoppedSubagents: 1,
            failedSubagents: 0,
          });
          expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
          expect(owners[0]?.signal.aborted).toBe(true);
        } else {
          const outcome = withinTest(stopping, signal);
          if (phase === "lookup rejected") {
            await expect(outcome).rejects.toBe(lookupFailure);
          } else {
            await expect(outcome).rejects.toThrow("selected session changed");
          }
          expect((await getSubagentRunByChildSessionKey(childKey))?.execution).toEqual(childBefore);
          expect(subagentRuns.get(runId)?.killIntent).toBeUndefined();
          expect(owners[0]?.signal.aborted).toBe(false);
          expect(
            loadSessionEntry({ storePath, sessionKey: identity.sessionKey })?.abortedLastRun,
          ).not.toBe(true);
        }
        expect(cancelParent).not.toHaveBeenCalled();
        expect(parent.abortSignal.aborted).toBe(false);
        expect(humanOwners[0]?.signal.aborted).toBe(false);
        expect((await getSubagentRunByChildSessionKey(humanKey))?.execution).toEqual(humanBefore);
        expect(releaseSwarmRun("frontier-blocker")).toBe(true);
        expect(await withinTest(firstDispatch.promise, signal)).toBe(
          phase === "success" ? "frontier-outside" : runId,
        );
      } finally {
        releaseLookup.resolve();
        finishOriginal.resolve();
        await stopping?.catch(() => {});
        await originalTurn;
        restoreLookup?.();
        restoreActivePluginRegistrySnapshot(registry);
        parent.complete();
        swarmSchedulerTesting.reset();
      }
    },
  );
}
