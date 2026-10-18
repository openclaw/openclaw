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
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  createControlRunFixture,
  enqueueControlRun,
} from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import type { ResolvedSubagentController } from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getSubagentRunByChildSessionKey as getChildRun } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const stopContext = (SessionKey: string, Provider = "stop-lookup", room = "room") =>
  buildTestCtx({
    CommandBody: "/stop",
    RawBody: "/stop",
    CommandAuthorized: true,
    Provider,
    Surface: Provider,
    SessionKey,
    From: `${Provider}:${room}`,
    To: `${Provider}:${room}`,
  });
const stopResult = (stoppedSubagents: number) => ({
  handled: true,
  stoppedSubagents,
  failedSubagents: 0,
});

function holdConversationLookup(failure?: Error) {
  const entered = createDeferred();
  const released = createDeferred();
  const registry = captureActivePluginRegistrySnapshot();
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
    .mockImplementationOnce(async (c) => {
      expect(c).toMatchObject({ channel: "stop-lookup", conversationId: "room" });
      entered.resolve();
      await released.promise;
      if (failure) {
        throw failure;
      }
      return resolve(c);
    });
  return {
    release: released.resolve,
    wait: (stop: Promise<unknown>, signal: AbortSignal) =>
      withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          stop,
          "Stop completed before its ACP lookup boundary",
        ),
        signal,
      ),
    restore() {
      lookup.mockRestore();
      restoreActivePluginRegistrySnapshot(registry);
    },
  };
}

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
      const collector = (name: "running" | "queued") => {
        const queued = name === "queued";
        const owner =
          queued && kind.endsWith("tree")
            ? "agent:main:subagent:running-collector"
            : controllerSessionKey;
        return createSubagentRunRecord({
          runId: `${name}-collector`,
          childSessionKey: `agent:main:subagent:${name}-collector`,
          childSessionIdentity: {
            sessionId: `${name}-session`,
            lifecycleRevision: `${name}-session-revision`,
          },
          controllerSessionKey: owner,
          requesterSessionKey: owner,
          collect: true,
          createdAt: 1,
          execution: queued ? { status: "queued" } : { status: "running", startedAt: 2 },
          swarmLaunchPending: queued || undefined,
        });
      };
      const running = await addRun(collector("running"));
      const queued = await addRun(collector("queued"));
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
        enqueueControlRun("cancelled-group", runId, [running.runId], async () => {
          started.push(runId);
          firstDispatch.resolve(runId);
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
      let stopDuringLookup: ReturnType<typeof tryFastAbortFromMessage> | undefined;
      let lookup: ReturnType<typeof holdConversationLookup> | undefined;
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
          lookup = holdConversationLookup();
          stopDuringLookup = tryFastAbortFromMessage({
            cfg,
            ctx: stopContext(controllerSessionKey),
          });
          await lookup.wait(stopDuringLookup, signal);
          expect(parent?.abortSignal.aborted).toBe(false);
          const later = await addRun({
            runId: "later-human-native-root",
            childSessionKey: "agent:main:subagent:later-human-native-root",
            controllerSessionKey,
            requesterSessionKey: controllerSessionKey,
            requesterTurnRunId: "later-human-turn",
          });
          expect(loadSessionEntry({ storePath, sessionKey: controllerSessionKey })?.sessionId).toBe(
            "parent-session",
          );
          expect(releaseSwarmRun(running.runId)).toBe(true);
          expect(await getChildRun(queued.childSessionKey)).toMatchObject({
            execution: { status: "queued" },
          });
          expect.soft(started, "selected FIFO head must remain held during ACP lookup").toEqual([]);
          lookup.release();
          const stopped = await withinTest(stopDuringLookup, signal);
          const dispatched = await withinTest(firstDispatch.promise, signal);
          expect.soft(dispatched).toBe("unselected");
          expect.soft(stopped).toMatchObject(stopResult(2));
          expect((await getChildRun(later.childSessionKey))?.execution.endedAt).toBeUndefined();
          expect(parent?.abortSignal.aborted).toBe(true);
        } else {
          expect(
            await tryFastAbortFromMessage({
              cfg,
              ctx: stopContext(controllerSessionKey, "telegram", "queue-owner"),
            }),
          ).toMatchObject(stopResult(2));
          expect(parent?.abortSignal.aborted).toBe(true);
        }
        for (const entry of [running, queued]) {
          expect(await getChildRun(entry.childSessionKey)).toMatchObject({
            execution: { status: "terminal" },
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
          });
        }
        expect(started).not.toContain(queued.runId);
        await vi.waitFor(() => expect(started).toEqual(["unselected"]));
      } finally {
        lookup?.release();
        await stopDuringLookup?.catch(() => {});
        lookup?.restore();
        parent?.complete();
        swarmSchedulerTesting.reset();
      }
    },
  );
}

export function registerRequestFrontierControlTests(fixture: { readonly stateDir: string }) {
  const records = createControlRunFixture(() => fixture.stateDir);
  const writeSession = (sessionKey: string, sessionId: string, revision: string) =>
    records.writeSession(sessionKey, revision, { sessionKey, defaultSessionId: sessionId });
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
      const storePath = await writeSession(
        identity.sessionKey,
        identity.sessionId,
        "frontier-parent-revision",
      );
      for (const key of [childKey, humanKey]) {
        await writeSession(key, `session-${key}`, `session-${key}-revision`);
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
      const firstDispatch = createDeferred<string>();
      let current = true;
      let stopping: ReturnType<typeof tryFastAbortFromMessage> | undefined;
      let lookup: ReturnType<typeof holdConversationLookup> | undefined;
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
        const lookupFailure = new Error("ACP lookup failed");
        lookup = holdConversationLookup(phase === "lookup rejected" ? lookupFailure : undefined);
        stopping = tryFastAbortFromMessage({
          cfg,
          isCommandTargetCurrent: () => current,
          ctx: stopContext(identity.sessionKey),
        });
        await lookup.wait(stopping, signal);
        const runId = "frontier-original-child";
        for (const queuedId of [runId, "frontier-outside"]) {
          enqueueControlRun("frontier-capacity", queuedId, ["frontier-blocker"], async () =>
            firstDispatch.resolve(queuedId),
          );
        }
        const register = (
          childSessionKey: string,
          childRunId: string,
          requesterTurnRunId: string,
          requestOwners: readonly ExecRequestOwner[],
        ) =>
          records.register(
            childRunId,
            undefined,
            {
              childSessionKey,
              sessionEntry: {
                sessionId: `session-${childSessionKey}`,
                lifecycleRevision: `session-${childSessionKey}-revision`,
              },
              requesterSessionKey: identity.sessionKey,
              requesterTurnRunId,
              requesterDisplayKey: identity.sessionKey,
              collect: true,
              queued: true,
              expectsCompletionMessage: undefined,
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
          await getChildRun(childKey),
          "published original child",
        ).execution;
        const humanBefore = expectDefined(
          await getChildRun(humanKey),
          "published human child",
        ).execution;
        expect(childBefore.status).toBe("queued");
        expect(humanBefore.status).toBe("queued");
        expect(loadSessionEntry({ storePath, sessionKey: identity.sessionKey })?.sessionId).toBe(
          identity.sessionId,
        );
        expect(parent.abortSignal.aborted).toBe(false);
        current = phase !== "caller revoked";
        lookup.release();
        if (phase === "success") {
          expect(await withinTest(stopping, signal)).toMatchObject(stopResult(1));
          expect(await getChildRun(childKey)).toMatchObject({
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
          expect((await getChildRun(childKey))?.execution).toEqual(childBefore);
          expect(subagentRuns.get(runId)?.killIntent).toBeUndefined();
          expect(owners[0]?.signal.aborted).toBe(false);
          expect(
            loadSessionEntry({ storePath, sessionKey: identity.sessionKey })?.abortedLastRun,
          ).not.toBe(true);
        }
        expect(cancelParent).not.toHaveBeenCalled();
        expect(parent.abortSignal.aborted).toBe(false);
        expect(humanOwners[0]?.signal.aborted).toBe(false);
        expect((await getChildRun(humanKey))?.execution).toEqual(humanBefore);
        expect(releaseSwarmRun("frontier-blocker")).toBe(true);
        expect(await withinTest(firstDispatch.promise, signal)).toBe(
          phase === "success" ? "frontier-outside" : runId,
        );
      } finally {
        lookup?.release();
        finishOriginal.resolve();
        await stopping?.catch(() => {});
        await originalTurn;
        lookup?.restore();
        parent.complete();
        swarmSchedulerTesting.reset();
      }
    },
  );
}
