import { expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { mergeAcceptedSessionSpawnsForRun } from "./accepted-session-spawn.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "./admitted-run-context.js";
import type { EmbeddedAgentQueueHandle } from "./embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "./embedded-agent-runner/runs.test-support.js";
import {
  createSessionsSendTestCaller,
  setSessionsSendTestActiveRun,
} from "./openclaw-tools.sessions-steering.test-support.js";
import { announceTesting } from "./subagents/announce/subagent-announce-overrides.test-support.js";
import { subscribeSubagentRunChanges } from "./subagents/registry/subagent-registry-publication.js";
import {
  addSubagentRunForTests,
  countPendingDescendantRuns,
  getSubagentRunByRunId,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./tools/in-process-gateway.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

export type GatewayCall = {
  method?: string;
  params?: Record<string, unknown>;
  onAccepted?: (payload: unknown) => void;
};

export function observeSubagentChange(ready: () => boolean) {
  const done = createDeferredCore();
  const stop = subscribeSubagentRunChanges("persistence", () => {
    if (ready()) {
      done.resolve();
    }
  });
  return { ...done, stop };
}

/** Gateway response for a requester turn that accepted and delivered one reply. */
export function deliveredRequesterReply(text: string) {
  return {
    status: "ok",
    inputProcessingCompleted: true,
    result: {
      payloads: [{ text }],
      deliveryStatus: { status: "sent", resultCount: 1 },
    },
  };
}

/** Ends a child run through its real lifecycle event and waits for the terminal registry row. */
export async function endChildRun(
  runId: string,
  childSessionKey: string,
  terminalReply: { disposition: "visible"; text: string },
) {
  const ended = observeSubagentChange(
    () => getSubagentRunByRunId(runId)?.execution.status === "terminal",
  );
  emitAgentEvent({
    runId,
    sessionKey: childSessionKey,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now(), terminalReply },
  });
  await ended.promise;
  ended.stop();
}

/** Asserts a consumed child result finished cleanup and no longer counts as pending work. */
export async function expectChildCleanupSettled(runId: string, requesterSessionKey: string) {
  expect(getSubagentRunByRunId(runId)?.cleanupCompletedAt).toBeTypeOf("number");
  expect(await countPendingDescendantRuns(requesterSessionKey, () => {})).toBe(0);
}

export function seedDeliveredChild(
  runId: string,
  childSessionKey: string,
  requesterSessionKey: string,
) {
  return addSubagentRunForTests({
    runId,
    childSessionKey,
    requesterSessionKey,
    requesterAgentId: "main",
    expectsCompletionMessage: true,
    createdAt: 1,
    execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
    completion: {
      required: true,
      resultText: "Original result",
      terminalReply: { disposition: "visible", text: "Original result" },
    },
    delivery: { status: "delivered" },
    cleanupCompletedAt: 3,
  });
}

export function childDeliverySettled(runId: string) {
  const child = getSubagentRunByRunId(runId);
  return child?.delivery?.status === "delivered" && !child.requesterSettleWake;
}

function requesterScope(
  context: ReturnType<typeof createContext>,
  identity: Parameters<typeof createAdmittedGatewayToolCallerIdentity>[0],
  client?: ReturnType<typeof createOperatorClient>,
) {
  return <T>(run: () => T, receiptAuthority?: () => boolean) =>
    withPluginRuntimeGatewayRequestScope(
      { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(
          createAdmittedGatewayToolCallerIdentity({ ...identity, receiptAuthority }),
          run,
        ),
    );
}

/** Reuse the coordination suite's transport and state fixture for post-commit retirement. */
export function registerSessionsSendRequesterRetirementTests({
  config,
  callGatewayMock,
  calls,
  writeEntry,
  writeFinal,
  writePair,
  sendTool,
  yieldTool,
  deliveredReply,
  requesterCalls,
  settleSessionWork,
  drainRootWork,
}: {
  config: OpenClawConfig;
  callGatewayMock: AgentToolGatewayRequestCaller &
    MockInstance<(request: GatewayCall) => Promise<unknown>>;
  calls: GatewayCall[];
  writeEntry: (sessionKey: string, entry: SessionEntry, storePath?: string) => Promise<void>;
  writeFinal: (sessionKey: string, runId: string, text: string) => Promise<void>;
  writePair: (
    requesterKey: string,
    requesterId: string,
    childKey: string,
    childId: string,
  ) => Promise<void>;
  sendTool: (requesterKey: string, runId?: string) => ReturnType<typeof createSessionsSendTool>;
  yieldTool: (
    sessionId: string,
    requesterKey: string,
    runId: string,
    onYield?: () => void,
  ) => ReturnType<typeof createSessionsYieldTool>;
  deliveredReply: (text: string) => unknown;
  requesterCalls: (sessionKey: string) => GatewayCall[];
  settleSessionWork: () => Promise<void>;
  drainRootWork: () => Promise<void>;
}) {
  it.each([
    { mode: "followup", retirement: "after Gateway acceptance" },
    { mode: "followup", retirement: "before publication" },
    { mode: "followup", retirement: "after publication" },
    { mode: "steer", retirement: "before publication" },
    { mode: "steer", retirement: "after publication" },
  ] as const)(
    "delivers a watched $mode once when the requester retires $retirement",
    async ({ mode, retirement }) => {
      const requesterSessionKey = "agent:main:dashboard:retiring-requester";
      const childSessionKey = "agent:main:dashboard:retiring-child";
      const requesterTurnRunId = "retiring-requester-turn";
      const childSessionId = "retiring-child";
      const runId = "retired-requester-child-run";
      await writePair(requesterSessionKey, "retiring-requester", childSessionKey, childSessionId);
      await resetSubagentRegistryForTests();
      const childPending = createDeferredCore();
      const fullReply = "Result after requester retirement";
      const terminalReply = { disposition: "visible" as const, text: fullReply };
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent" && request.params?.sessionKey === childSessionKey) {
          const receipt = { runId, status: "accepted", targetDisposition: "queued" };
          if (retirement === "after Gateway acceptance") {
            retireRequester();
            request.onAccepted?.(receipt);
          }
          return receipt;
        }
        if (request.method === "agent.wait" && request.params?.runId === runId) {
          await childPending.promise;
          await writeFinal(childSessionKey, runId, fullReply);
          return { runId, status: "ok", startedAt: 1, endedAt: Date.now(), terminalReply };
        }
        if (request.method === "agent") {
          return deliveredReply("Retired requester's child result delivered");
        }
        return {};
      });
      const queueMessage = vi.fn<EmbeddedAgentQueueHandle["queueMessage"]>(
        async (_text, options) => {
          const recorder = options?.userTurnTranscriptRecorder;
          if (!recorder || !(await recorder.persistApproved())) {
            throw new Error("Steering fixture did not commit the admitted guidance");
          }
        },
      );
      const handle = createEmbeddedRunHandle({
        runId,
        queueMessage,
        supportsTranscriptCommitWait: true,
        guarded: true,
      });
      if (mode === "steer") {
        await registerSubagentRun({
          runId,
          childSessionKey,
          childAgentId: "main",
          sessionEntry: { sessionId: childSessionId },
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          requesterAgentId: "main",
          task: "Existing child work",
          cleanup: "keep",
          spawnMode: "session",
          expectsCompletionMessage: true,
        });
        await setSessionsSendTestActiveRun(
          childSessionId,
          handle,
          childSessionKey,
          requesterSessionKey,
          config,
        );
      } else {
        await seedDeliveredChild(
          "retiring-original-child-run",
          childSessionKey,
          requesterSessionKey,
        );
      }
      const admission = prepareSystemAgentRunAdmission(
        config,
        requesterTurnRunId,
        "main",
        "watched-followup-retirement",
      );
      const admittedRunContext = await admission.admit("embedded");
      const context = createContext();
      // This fixture uses the mocked transport; it does not boot a hosted recovery runtime.
      context.localEmbedded = true;
      context.getRuntimeConfig = () => config;
      context.resolveGatewayContext = () => context;
      let requesterRetired = false;
      const retireRequester = () => {
        expect(mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance)).toEqual([]);
        requesterRetired = true;
        admission.close();
      };
      const retireBeforePublication = probe.command(
        stateWorker,
        async (command, executeOptions, scope) => {
          const result = await scope.execute(command, executeOptions);
          if (
            retirement === "before publication" &&
            !requesterRetired &&
            command.type === "subagents.persistChanges"
          ) {
            retireRequester();
          }
          return result;
        },
      );
      const stopRetiring = subscribeSubagentRunChanges("persistence", () => {
        if (
          retirement === "after publication" &&
          !requesterRetired &&
          getSubagentRunByRunId(runId)?.requesterTurnRunId === requesterTurnRunId
        ) {
          retireRequester();
        }
      });
      announceTesting.setDepsForTest({ callGateway: callGatewayMock });
      let stopObserving = () => {};
      try {
        const withCaller = requesterScope(context, {
          admittedRunContext,
          agentId: "main",
          sessionKey: requesterSessionKey,
          requesterOrigin: createSessionsSendTestCaller(requesterSessionKey).requesterOrigin,
        });
        const result = await withCaller(() =>
          sendTool(requesterSessionKey, requesterTurnRunId).execute("retiring-watched-send", {
            sessionKey: childSessionKey,
            mode,
            watch: true,
            timeoutSeconds: 0,
            message: "Return the follow-up result",
          }),
        );
        expect(requesterRetired).toBe(true);
        expect(result.details).toMatchObject({ status: "error", sentBeforeError: true });
        expect(getSubagentRunByRunId(runId)?.requesterTurnRunId).toBeUndefined();
        if (mode === "steer") {
          expect(queueMessage).toHaveBeenCalledOnce();
        }
        expect(requesterCalls(requesterSessionKey)).toHaveLength(0);
        const delivered = observeSubagentChange(() => childDeliverySettled(runId));
        stopObserving = delivered.stop;
        clearActiveEmbeddedRun(childSessionId, handle, childSessionKey);
        childPending.resolve();
        await delivered.promise;
        await settleSessionWork();
        expect(requesterCalls(requesterSessionKey)).toHaveLength(1);
        expect(requesterCalls(requesterSessionKey)[0]?.params).toMatchObject({
          message: "Continue the OpenClaw runtime event.",
          internalEvents: [
            {
              type: "task_completion",
              childSessionKey,
              result: expect.stringContaining(terminalReply.text),
            },
          ],
          inputProvenance: { sourceTool: "subagent_announce" },
        });
        emitAgentEvent({
          runId,
          sessionKey: childSessionKey,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now(), terminalReply },
        });
        await settleSessionWork();
        expect(requesterCalls(requesterSessionKey)).toHaveLength(1);
      } finally {
        stopRetiring();
        retireBeforePublication.mockRestore();
        admission.close();
        clearActiveEmbeddedRun(childSessionId, handle, childSessionKey);
        childPending.resolve();
        stopObserving();
        await resetSubagentRegistryForTests();
        await settleSessionWork();
        announceTesting.setDepsForTest();
      }
    },
  );

  it.for([
    { scenario: "tool authority retires", sameChild: false, revokeTool: true },
    { scenario: "two runs target one child" },
    { scenario: "requester finishes without yielding", finish: "normal" },
    { scenario: "requester retires without yielding", finish: "retired" },
    { scenario: "newest child finishes first", finish: "normal", newestFirst: true },
    { scenario: "nested requester finishes", finish: "normal", nested: true },
  ])("keeps earlier child claims when $scenario", async (scenario, { signal }) => {
    const { sameChild = true, revokeTool = false, finish, newestFirst, nested } = scenario;
    const requesterSessionKey = "agent:main:dashboard:active-requester";
    const requesterTurnRunId = "active-requester-turn";
    const firstChildKey = "agent:main:dashboard:first-watched-child";
    const secondChildKey = sameChild ? firstChildKey : "agent:main:dashboard:second-watched-child";
    const children = [
      { childSessionKey: firstChildKey, runId: "first-watched-run" },
      { childSessionKey: secondChildKey, runId: "second-watched-run" },
    ];
    await writeEntry(requesterSessionKey, {
      sessionId: "active-requester",
      updatedAt: 1,
      ...(nested ? { spawnDepth: 1 } : {}),
    });
    for (const childSessionKey of new Set(children.map((child) => child.childSessionKey))) {
      await writeEntry(childSessionKey, {
        sessionId: childSessionKey,
        updatedAt: 1,
        spawnedBy: requesterSessionKey,
        spawnDepth: 1,
      });
    }
    await resetSubagentRegistryForTests();
    const childrenPending = children.map(() => createDeferredCore());
    let acceptedMessages = 0;
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      calls.push(request);
      const sessionKey = request.params?.sessionKey;
      if (
        request.method === "agent" &&
        children.some((child) => child.childSessionKey === sessionKey)
      ) {
        const child = children[acceptedMessages++];
        if (!child) {
          throw new Error("Unexpected additional child admission");
        }
        expect(sessionKey).toBe(child.childSessionKey);
        return { runId: child.runId, status: "accepted", targetDisposition: "queued" };
      }
      if (request.method === "agent.wait") {
        const child = children.find((candidate) => candidate.runId === request.params?.runId);
        if (!child) {
          throw new Error("Unexpected child completion wait");
        }
        await childrenPending[children.indexOf(child)]!.promise;
        const fullReply = `Watched child result ${child.runId}`;
        await writeFinal(child.childSessionKey, child.runId, fullReply);
        return {
          status: "ok",
          startedAt: 1,
          endedAt: Date.now(),
          terminalReply: {
            disposition: "visible",
            text: fullReply,
          },
        };
      }
      if (request.method === "agent" && sessionKey === requesterSessionKey) {
        return deliveredReply("Both watched results reached the requester");
      }
      return {};
    });
    const context = createContext();
    context.localEmbedded = true;
    context.getRuntimeConfig = () => config;
    context.resolveGatewayContext = () => context;
    const client = createOperatorClient({
      profileName: "watched-cohort",
      scopes: ["operator.admin"],
    });
    const operator = await captureGatewayOperatorRunAuthority({ client, context });
    if (!operator) {
      throw new Error("Expected an operator-owned requester admission");
    }
    const admission = prepareSystemAgentRunAdmission(
      config,
      requesterTurnRunId,
      "main",
      "watched-tool-retirement",
      undefined,
      operator.authority,
    );
    const admittedRunContext = await admission.admit("embedded");
    let toolCurrent = true;
    const withCaller = requesterScope(
      context,
      { admittedRunContext, agentId: "main", sessionKey: requesterSessionKey },
      client,
    );
    const send = (sessionKey: string) =>
      withCaller(
        () =>
          sendTool(requesterSessionKey, requesterTurnRunId).execute("watched-send", {
            sessionKey,
            mode: "followup",
            watch: true,
            timeoutSeconds: 0,
            message: "Return the child result",
          }),
        () => toolCurrent,
      );
    const stopRetiringTool = subscribeSubagentRunChanges("persistence", () => {
      if (getSubagentRunByRunId("second-watched-run")?.requesterTurnRunId !== requesterTurnRunId) {
        return;
      }
      if (revokeTool) {
        toolCurrent = false;
      }
      if (finish === "retired") {
        admission.close();
      }
    });
    announceTesting.setDepsForTest({ callGateway: callGatewayMock });
    let stopObserving = () => {};
    try {
      expect((await send(firstChildKey)).details).toMatchObject({ status: "accepted" });
      expect((await send(secondChildKey)).details).toMatchObject(
        revokeTool || finish === "retired"
          ? { status: "error", sentBeforeError: true }
          : { status: "accepted" },
      );
      expect(toolCurrent).toBe(!revokeTool);
      expect(Boolean(getAdmittedRunDelegatedAuthority(admittedRunContext))).toBe(
        finish !== "retired",
      );
      for (const { runId } of children) {
        expect(getSubagentRunByRunId(runId)?.requesterTurnRunId).toBe(
          finish === "retired" ? undefined : requesterTurnRunId,
        );
      }
      expect(mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance)).toEqual(
        children.map(({ childSessionKey, runId }) => ({
          runId,
          childSessionKey,
          expectsCompletionMessage: true,
        })),
      );
      if (!finish) {
        const yielded = await withCaller(() =>
          yieldTool("active-requester", requesterSessionKey, requesterTurnRunId, vi.fn()).execute(
            "yield-existing-claims",
            {},
          ),
        );
        expect(yielded.details).toEqual({ status: "yielded" });
        for (const { runId } of children) {
          expect(getSubagentRunByRunId(runId)?.requesterTurnYielded).toBe(true);
        }
      }
      if (finish !== "retired") {
        expect(
          await withCaller(() =>
            settleRequesterAfterSessionSpawns({
              requesterSessionKey,
              requesterAgentId: "main",
              requesterTurnRunId,
              requesterYielded: !finish,
              acceptedSessionSpawns: mergeAcceptedSessionSpawnsForRun(
                admission.operationalRunInstance,
              ),
            }),
          ),
        ).toBe(true);
      }
      for (const { runId } of children) {
        expect(getSubagentRunByRunId(runId)?.requesterTurnRunId).toBeUndefined();
      }
      const firstIndex = newestFirst ? 1 : 0;
      const firstSettled = createDeferredCore();
      const resultsDelivered = createDeferredCore();
      stopObserving = subscribeSubagentRunChanges("persistence", () => {
        const firstChild = getSubagentRunByRunId(children[firstIndex]!.runId);
        if (!firstChild || firstChild.cleanupCompletedAt !== undefined) {
          firstSettled.resolve();
        }
        if (children.every(({ runId }) => childDeliverySettled(runId))) {
          resultsDelivered.resolve();
        }
      });
      admission.close();
      childrenPending[firstIndex]!.resolve();
      await withinTest(firstSettled.promise, signal);
      expect(
        getSubagentRunByRunId(children[firstIndex]!.runId),
        "The first accepted result must retain its completion owner",
      ).toBeDefined();
      await drainRootWork();
      expect(requesterCalls(requesterSessionKey)).toHaveLength(0);
      childrenPending[1 - firstIndex]!.resolve();
      // The wait receipt must publish completion before its newly admitted roots can be drained.
      await withinTest(resultsDelivered.promise, signal);
      await settleSessionWork();
      const deliveredCalls = requesterCalls(requesterSessionKey);
      expect(deliveredCalls).toHaveLength(1);
      for (const { runId } of children) {
        expect(deliveredCalls[0]?.params?.message).toContain(`Watched child result ${runId}`);
        expect(getSubagentRunByRunId(runId)?.delivery?.status).toBe("delivered");
        expect(getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        });
      }
      await settleSessionWork();
      expect(requesterCalls(requesterSessionKey)).toHaveLength(1);
    } finally {
      stopRetiringTool();
      admission.close();
      childrenPending.forEach((pending) => pending.resolve());
      stopObserving();
      await settleSessionWork();
      await resetSubagentRegistryForTests();
      announceTesting.setDepsForTest();
      operator.release();
    }
  });
}
