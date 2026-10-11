import { expect, it, vi, type MockInstance } from "vitest";
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
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "./embedded-agent-runner/runs.test-support.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { announceTesting } from "./subagents/announce/subagent-announce-overrides.test-support.js";
import { subscribeSubagentRunChanges } from "./subagents/registry/subagent-registry-publication.js";
import {
  addSubagentRunForTests,
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

/** Reuse the coordination suite's transport and state fixture for post-commit retirement. */
export function registerSessionsSendRequesterRetirementTests({
  config,
  callGatewayMock,
  calls,
  writeEntry,
  settleSessionWork,
  drainRootWork,
}: {
  config: OpenClawConfig;
  callGatewayMock: AgentToolGatewayRequestCaller &
    MockInstance<(request: GatewayCall) => Promise<unknown>>;
  calls: GatewayCall[];
  writeEntry: (sessionKey: string, entry: SessionEntry, storePath?: string) => Promise<void>;
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
      await writeEntry(requesterSessionKey, { sessionId: "retiring-requester", updatedAt: 1 });
      await writeEntry(childSessionKey, {
        sessionId: childSessionId,
        updatedAt: 1,
        spawnedBy: requesterSessionKey,
        spawnDepth: 1,
      });
      await resetSubagentRegistryForTests();
      const childPending = createDeferredCore();
      const terminalReply = { disposition: "visible", text: "Result after requester retirement" };
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
          return { runId, status: "ok", startedAt: 1, endedAt: Date.now(), terminalReply };
        }
        if (request.method === "agent") {
          return {
            status: "ok",
            inputProcessingCompleted: true,
            result: {
              payloads: [{ text: "Retired requester's child result delivered" }],
              deliveryStatus: { status: "sent", resultCount: 1 },
            },
          };
        }
        return {};
      });
      const queueMessage = vi.fn(async () => {});
      const handle: EmbeddedAgentQueueHandle = {
        ...createEmbeddedRunHandle({ runId, queueMessage }),
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (_text, _options, assertCurrent) => {
            assertCurrent?.();
            await queueMessage();
          },
        },
      };
      if (mode === "steer") {
        await registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          requesterAgentId: "main",
          task: "Existing child work",
          cleanup: "keep",
          spawnMode: "session",
          expectsCompletionMessage: true,
        });
        setActiveEmbeddedRun(childSessionId, handle, childSessionKey);
      } else {
        await addSubagentRunForTests({
          runId: "retiring-original-child-run",
          childSessionKey,
          requesterSessionKey,
          requesterAgentId: "main",
          expectsCompletionMessage: true,
          createdAt: 1,
          execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
          completion: { required: true, resultText: "Original result" },
          delivery: { status: "delivered" },
          cleanupCompletedAt: 3,
        });
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
        const result = await withPluginRuntimeGatewayRequestScope(
          { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
          () =>
            withGatewayToolCallerIdentity(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext,
                agentId: "main",
                sessionKey: requesterSessionKey,
              }),
              () =>
                createSessionsSendTool({
                  agentSessionKey: requesterSessionKey,
                  requesterTurnRunId,
                  config,
                  callGateway: callGatewayMock,
                }).execute("retiring-watched-send", {
                  sessionKey: childSessionKey,
                  mode,
                  watch: true,
                  timeoutSeconds: 0,
                  message: "Return the follow-up result",
                }),
            ),
        );
        expect(requesterRetired).toBe(true);
        expect(result.details).toMatchObject({ status: "error", sentBeforeError: true });
        expect(getSubagentRunByRunId(runId)?.requesterTurnRunId).toBeUndefined();
        if (mode === "steer") {
          expect(queueMessage).toHaveBeenCalledOnce();
        }
        const requesterCalls = () =>
          calls.filter(
            (call) => call.method === "agent" && call.params?.sessionKey === requesterSessionKey,
          );
        expect(requesterCalls()).toHaveLength(0);
        const delivered = createDeferredCore();
        stopObserving = subscribeSubagentRunChanges("persistence", () => {
          const child = getSubagentRunByRunId(runId);
          if (child?.delivery?.status === "delivered" && !child.requesterSettleWake) {
            delivered.resolve();
          }
        });
        clearActiveEmbeddedRun(childSessionId, handle, childSessionKey);
        childPending.resolve();
        await delivered.promise;
        await settleSessionWork();
        expect(requesterCalls()).toHaveLength(1);
        expect(requesterCalls()[0]?.params).toMatchObject({
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
        expect(requesterCalls()).toHaveLength(1);
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
    { scenario: "only a watched tool's authority retires", sameChild: false, revokeTool: true },
    { scenario: "two watched runs target the same child", sameChild: true, revokeTool: false },
    { scenario: "the requester finishes without yielding", sameChild: true, finish: "normal" },
    { scenario: "the requester retires without yielding", sameChild: true, finish: "retired" },
    {
      scenario: "the newest task finishes first without yielding",
      sameChild: true,
      finish: "normal",
      newestFirst: true,
    },
    {
      scenario: "a nested requester finishes without yielding",
      sameChild: true,
      finish: "normal",
      nested: true,
    },
  ])("keeps earlier child claims when $scenario", async (scenario, { signal }) => {
    const { sameChild, revokeTool, finish, newestFirst, nested } = scenario;
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
        return {
          status: "ok",
          startedAt: 1,
          endedAt: Date.now(),
          terminalReply: {
            disposition: "visible",
            text: `Watched child result ${child.runId}`,
          },
        };
      }
      if (request.method === "agent" && sessionKey === requesterSessionKey) {
        return {
          status: "ok",
          inputProcessingCompleted: true,
          result: {
            payloads: [{ text: "Both watched results reached the requester" }],
            deliveryStatus: { status: "sent", resultCount: 1 },
          },
        };
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
    const withCaller = <T>(run: () => T, receiptAuthority?: () => boolean) =>
      withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext,
              agentId: "main",
              sessionKey: requesterSessionKey,
              receiptAuthority,
            }),
            run,
          ),
      );
    const send = (sessionKey: string) =>
      withCaller(
        () =>
          createSessionsSendTool({
            agentSessionKey: requesterSessionKey,
            requesterTurnRunId,
            config,
            callGateway: callGatewayMock,
          }).execute("watched-send", {
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
          createSessionsYieldTool({
            sessionId: "active-requester",
            claimYield: createRequesterYieldCallback({
              requesterSessionKey,
              requesterAgentId: "main",
              requesterTurnRunId,
            }),
            onYield: vi.fn(),
          }).execute("yield-existing-claims", {}),
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
        if (
          children.every(({ runId }) => {
            const child = getSubagentRunByRunId(runId);
            return child?.delivery?.status === "delivered" && !child.requesterSettleWake;
          })
        ) {
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
      expect(
        calls.filter(
          (call) => call.method === "agent" && call.params?.sessionKey === requesterSessionKey,
        ),
      ).toHaveLength(0);
      childrenPending[1 - firstIndex]!.resolve();
      // The wait receipt must publish completion before its newly admitted roots can be drained.
      await withinTest(resultsDelivered.promise, signal);
      await settleSessionWork();
      const requesterCalls = calls.filter(
        (call) => call.method === "agent" && call.params?.sessionKey === requesterSessionKey,
      );
      expect(requesterCalls).toHaveLength(1);
      for (const { runId } of children) {
        expect(requesterCalls[0]?.params?.message).toContain(`Watched child result ${runId}`);
        expect(getSubagentRunByRunId(runId)?.delivery?.status).toBe("delivered");
        expect(getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        });
      }
      await settleSessionWork();
      expect(
        calls.filter(
          (call) => call.method === "agent" && call.params?.sessionKey === requesterSessionKey,
        ),
      ).toHaveLength(1);
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
