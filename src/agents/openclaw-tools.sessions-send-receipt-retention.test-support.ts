import { expect, it, vi, type MockInstance } from "vitest";
import { admitReplyTurn } from "../auto-reply/reply/reply-turn-admission.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "../gateway/session-utils-store-lookup.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  retireAcceptedSessionSpawnCompletionForRun,
} from "./accepted-session-spawn.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { clearTestEmbeddedRun as clearActiveEmbeddedRun } from "./embedded-agent-runner/runs.test-support.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import {
  deliveredRequesterReply,
  observeSubagentChange,
  seedDeliveredChild,
  childDeliverySettled,
  type GatewayCall,
} from "./openclaw-tools.sessions-send-requester-retirement.test-support.js";
import {
  createDurableSessionsSendTestRun,
  createSessionsSendTestCaller,
  setSessionsSendTestActiveRun,
} from "./openclaw-tools.sessions-steering.test-support.js";
import { settleRequesterRun } from "./requester-run-settlement.js";
import { announceTesting } from "./subagents/announce/subagent-announce-overrides.test-support.js";
import { mutateSubagentRuns } from "./subagents/registry/subagent-registry-persistence.js";
import {
  adoptPausedSubagentRunForFollowUp,
  claimSubagentYield,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  registerSubagentRun,
  testing as registryTesting,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./tools/in-process-gateway.js";
import type { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import type { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

/** Reuse coordination's transport and private state for the native receipt lifetime boundary. */
export function registerSessionsSendReceiptRetentionTests({
  config,
  callGatewayMock,
  calls,
  writeEntry,
  writeFinal,
  sendTool,
  yieldTool,
  requesterCalls,
  settlePair,
  settleSessionWork,
  releaseAndObserve,
  cleanupFollowup,
}: {
  config: OpenClawConfig;
  callGatewayMock: AgentToolGatewayRequestCaller &
    MockInstance<(request: GatewayCall) => Promise<unknown>>;
  calls: GatewayCall[];
  writeEntry: (sessionKey: string, entry: SessionEntry, storePath?: string) => Promise<void>;
  writeFinal: (sessionKey: string, runId: string, text: string) => Promise<void>;
  sendTool: (
    requesterKey: string,
    requesterTurnRunId?: string,
  ) => ReturnType<typeof createSessionsSendTool>;
  yieldTool: (
    sessionId: string,
    requesterSessionKey: string,
    requesterTurnRunId: string,
  ) => ReturnType<typeof createSessionsYieldTool>;
  requesterCalls: (requesterSessionKey: string) => GatewayCall[];
  settlePair: (
    requesterSessionKey: string,
    requesterTurnRunId: string,
    childSessionKey: string,
    runIds: string[],
  ) => Promise<boolean>;
  settleSessionWork: () => Promise<void>;
  releaseAndObserve: (predicate: () => boolean, release: () => void) => Promise<void>;
  cleanupFollowup: () => Promise<void>;
}) {
  it.each([
    "inline",
    "held",
    "before-expiry",
    "detached",
    "adopted",
    "paused-resume",
    "paused-resume-closed",
    "receipt-retired",
    "source-closed",
    "instance-replaced",
    "wrong-turn",
    "unknown-task",
    "row-replaced",
  ] as const)("retains only the live requester's required delivered witness (%s)", async (mode) => {
    const pausedResume = mode.startsWith("paused-resume");
    const deliveredEarly = mode !== "inline" && mode !== "held";
    const retiresWitness = ![
      "inline",
      "held",
      "before-expiry",
      "detached",
      "adopted",
      "paused-resume",
    ].includes(mode);
    const requesterSessionKey = "agent:main:dashboard:receipt-parent";
    const requesterTurnRunId = "receipt-parent-turn";
    const childKeys = [
      "agent:main:subagent:receipt-child-1",
      "agent:main:subagent:receipt-child-2",
    ];
    const runIds = [
      "receipt-followup-1",
      "receipt-followup-2",
      "receipt-followup-3",
      "receipt-followup-4",
    ];
    const executionRunIds = [...runIds];
    await writeEntry(requesterSessionKey, { sessionId: "receipt-parent", updatedAt: 1 });
    await resetSubagentRegistryForTests();
    for (let index = 0; index < childKeys.length; index++) {
      await writeEntry(childKeys[index]!, {
        sessionId: childKeys[index]!,
        updatedAt: 1,
        spawnedBy: requesterSessionKey,
        spawnDepth: 1,
      });
      await seedDeliveredChild("receipt-original-" + index, childKeys[index]!, requesterSessionKey);
    }
    const replies = runIds.map(() => createDeferredCore());
    const completions: Promise<Record<string, unknown>>[] = [];
    let dispatched = 0;
    const adoptedRun =
      mode === "adopted"
        ? createDurableSessionsSendTestRun(runIds[0]!, async () => {
            dispatched = 1;
          })
        : undefined;
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      calls.push(request);
      if (request.method === "agent" && childKeys.includes(String(request.params?.sessionKey))) {
        return { runId: runIds[dispatched++], status: "accepted", targetDisposition: "queued" };
      }
      if (request.method === "agent.wait") {
        const index = executionRunIds.indexOf(String(request.params?.runId));
        if (index >= 0) {
          completions[index] ??= (async () => {
            await replies[index]!.promise;
            await writeFinal(
              childKeys[index % 2]!,
              executionRunIds[index]!,
              "RECEIPT-" + (index + 1),
            );
            return {
              status: "ok",
              startedAt: 10,
              endedAt: Date.now(),
              terminalReply: {
                disposition: "visible",
                text: "RECEIPT-" + (index + 1),
              },
            };
          })();
          return completions[index];
        }
      }
      return deliveredRequesterReply("Both continuation results reviewed");
    });
    announceTesting.setDepsForTest({ callGateway: callGatewayMock });
    const context = createContext();
    context.localEmbedded = true;
    context.getRuntimeConfig = () => config;
    context.resolveGatewayContext = () => context;
    const client = createOperatorClient({
      profileName: "receipt-proof",
      scopes: ["operator.admin"],
    });
    const operator = await captureGatewayOperatorRunAuthority({ client, context });
    if (!operator) {
      throw new Error("Expected operator requester admission");
    }
    const admission = prepareSystemAgentRunAdmission(
      config,
      requesterTurnRunId,
      "main",
      "receipt-proof",
      undefined,
      operator.authority,
    );
    const admittedRunContext = await admission.admit("embedded");
    let replacement: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
    const reply = await admitReplyTurn({
      agentId: "main",
      sessionKey: requesterSessionKey,
      sessionId: "receipt-parent",
      runId: requesterTurnRunId,
      storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
      kind: "visible",
      resetTriggered: false,
    });
    if (reply.status !== "owned") {
      throw new Error("Requester did not acquire its reply operation");
    }
    // Admission reserves the reply slot; backend attachment gives it the physical run identity.
    reply.operation.attachBackend({
      kind: "embedded",
      runId: requesterTurnRunId,
      cancel: () => {},
      isStreaming: () => false,
    });
    const withCaller = <T>(run: () => T) =>
      withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext,
              agentId: "main",
              sessionKey: requesterSessionKey,
              ...(mode === "adopted"
                ? {
                    requesterOrigin:
                      createSessionsSendTestCaller(requesterSessionKey).requesterOrigin,
                  }
                : {}),
            }),
            run,
          ),
      );
    try {
      if (deliveredEarly && !pausedResume) {
        // Diagnostic contrast: an admitted system run can outlive its reply controller.
        reply.operation.complete();
        await reply.operation.ownerSettlement;
      }
      if (mode === "adopted") {
        const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
          cfg: config,
          key: childKeys[0]!,
          readOnly: true,
          exactRead: true,
        });
        await withCaller(() =>
          registerSubagentRun({
            runId: runIds[0]!,
            childSessionKey: childKeys[0]!,
            childAgentId: "main",
            sessionEntry: target.store[target.canonicalKey]!,
            requesterSessionKey,
            requesterAgentId: "main",
            requesterDisplayKey: requesterSessionKey,
            task: "Existing child execution",
            cleanup: "keep",
            spawnMode: "session",
            expectsCompletionMessage: true,
            completionTarget: "parent",
            completionRequesterSessionId: "receipt-parent",
          }),
        );
        expect(getSubagentRunByRunId(executionRunIds[0]!)?.requesterTurnRunId).toBeUndefined();
        await setSessionsSendTestActiveRun(
          childKeys[0]!,
          adoptedRun!.handle,
          childKeys[0]!,
          requesterSessionKey,
          config,
        );
      }
      if (mode === "inline") {
        replies[0]!.resolve();
      }
      const early = await withCaller(() =>
        sendTool(requesterSessionKey, requesterTurnRunId).execute("early-result", {
          sessionKey: childKeys[0],
          message: "Return early result",
          ...(mode === "adopted" ? { mode: "steer", watch: true } : {}),
          timeoutSeconds: mode === "inline" ? 1 : 0,
        }),
      );
      expect(early.details).not.toHaveProperty("error");
      if (adoptedRun) {
        expect(adoptedRun.queueMessage).toHaveBeenCalledOnce();
        clearActiveEmbeddedRun(childKeys[0]!, adoptedRun.handle, childKeys[0]!);
      }
      expect(early.details).toMatchObject(
        mode === "inline"
          ? { status: "ok", reply: "RECEIPT-1" }
          : { status: "accepted", delivery: { status: "pending" } },
      );
      if (pausedResume) {
        expect(
          await withCaller(() =>
            claimSubagentYield({
              runId: runIds[0]!,
              sessionKey: childKeys[0]!,
              agentId: "main",
              waitForMessage: true,
              hasPendingWork: () => false,
            }),
          ),
        ).toEqual({ messageWaitRegistered: true });
        await releaseAndObserve(
          () => getSubagentRunByRunId(runIds[0]!)?.pauseReason === "sessions_yield",
          () =>
            emitAgentEvent({
              runId: runIds[0]!,
              sessionKey: childKeys[0]!,
              stream: "lifecycle",
              data: { phase: "end", endedAt: Date.now(), yielded: true },
            }),
        );
        executionRunIds[0] = "receipt-resumed-1";
        expect(
          await withCaller(() =>
            adoptPausedSubagentRunForFollowUp({
              childSessionKey: childKeys[0]!,
              childAgentId: "main",
              runId: executionRunIds[0]!,
              task: "Continue the original accepted task",
              expected: getSubagentRunByRunId(runIds[0]!),
              gatewayContextResolver: () => context,
            }),
          ),
        ).toBe(true);
        expect(getSubagentRunByRunId(runIds[0]!)).toBeUndefined();
        expect(getSubagentRunByRunId(executionRunIds[0]!)).toMatchObject({
          taskRunId: runIds[0],
          requesterSessionKey,
          requesterTurnRunId,
          execution: { status: "running" },
        });
        reply.operation.complete();
        await reply.operation.ownerSettlement;
      }
      if (mode !== "inline") {
        await releaseAndObserve(
          () =>
            deliveredEarly
              ? childDeliverySettled(executionRunIds[0]!)
              : getSubagentRunByRunId(executionRunIds[0]!)?.execution.status === "terminal",
          replies[0]!.resolve,
        );
      }
      if (
        mode === "inline" &&
        getSubagentRunByRunId(executionRunIds[0]!)?.execution.status !== "terminal"
      ) {
        const terminal = observeSubagentChange(
          () => getSubagentRunByRunId(executionRunIds[0]!)?.execution.status === "terminal",
        );
        try {
          await terminal.promise;
        } finally {
          terminal.stop();
        }
      }
      if (mode !== "held") {
        await settleSessionWork();
      }
      expect(getSubagentRunByRunId(executionRunIds[0]!)).toMatchObject({
        runId: executionRunIds[0],
        requesterTurnRunId,
        execution: { status: "terminal" },
        delivery: {
          status: mode === "held" ? "pending" : mode === "inline" ? "not_required" : "delivered",
        },
      });
      const earlyReceipt = mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance)[0]!;
      expect(earlyReceipt.expectsCompletionMessage).toBe(mode !== "inline");
      if (mode === "receipt-retired") {
        retireAcceptedSessionSpawnCompletionForRun(admission.operationalRunInstance, earlyReceipt);
      } else if (mode === "source-closed" || mode === "paused-resume-closed") {
        admission.close();
      } else if (mode === "instance-replaced") {
        replacement = prepareSystemAgentRunAdmission(
          config,
          requesterTurnRunId,
          "main",
          "receipt-proof",
          undefined,
          operator.authority,
        );
        await replacement.admit("embedded");
        // Identical correlation IDs and receipt contents cannot revive the old instance.
        mergeAcceptedSessionSpawnsForRun(replacement.operationalRunInstance, [earlyReceipt]);
      } else if (["wrong-turn", "unknown-task", "row-replaced"].includes(mode)) {
        await mutateSubagentRuns([runIds[0]!], (rows) => {
          const current = rows.get(runIds[0]!)!;
          const next = { ...current };
          if (mode === "wrong-turn") {
            next.requesterTurnRunId = "another-requester-turn";
          }
          if (mode === "unknown-task") {
            next.taskRunId = "unaccepted-task";
          }
          if (mode === "row-replaced") {
            next.generation = (current.generation ?? 0) + 1;
          }
          return { value: undefined, postimages: new Map([[current.runId, next]]) };
        });
      }
      if (mode !== "before-expiry") {
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
        try {
          await registryTesting.sweepOnceForTests();
        } finally {
          clock.mockRestore();
        }
      }
      expect
        .soft(Boolean(getSubagentRunByRunId(executionRunIds[0]!)))
        .toBe(mode !== "inline" && !retiresWitness);
      expect(requesterCalls(requesterSessionKey)).toHaveLength(deliveredEarly ? 1 : 0);
      if (deliveredEarly) {
        expect(requesterCalls(requesterSessionKey)[0]?.params).toMatchObject({
          internalEvents: [
            { type: "task_completion", result: expect.stringContaining("RECEIPT-1") },
          ],
          inputProvenance: { sourceTool: "subagent_announce" },
        });
      }
      if (retiresWitness) {
        // Removing a witness never invents credit for its otherwise still-required receipt.
        expect(
          await settlePair(requesterSessionKey, requesterTurnRunId, childKeys[0]!, [runIds[0]!]),
        ).toBe(false);
        expect(requesterCalls(requesterSessionKey)).toHaveLength(1);
        return;
      }
      for (let index = 1; index < runIds.length; index++) {
        const sent = await withCaller(() =>
          sendTool(requesterSessionKey, requesterTurnRunId).execute("continue", {
            sessionKey: childKeys[index % 2],
            message: "Continue the same child",
            timeoutSeconds: 0,
          }),
        );
        expect(sent.details).toMatchObject({ status: "accepted", delivery: { status: "pending" } });
      }
      const yielded = await withCaller(() =>
        yieldTool("receipt-parent", requesterSessionKey, requesterTurnRunId).execute("yield", {}),
      );
      expect(yielded.details).toEqual({ status: "yielded" });
      const accepted = mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance);
      expect(accepted.map(({ runId, childSessionKey }) => ({ runId, childSessionKey }))).toEqual(
        runIds.map((runId, index) => ({ runId, childSessionKey: childKeys[index % 2] })),
      );
      expect(accepted.slice(1).every((receipt) => receipt.expectsCompletionMessage)).toBe(true);
      if (mode === "inline" || mode === "held") {
        expect(accepted[0]?.expectsCompletionMessage).toBe(mode === "held");
      }
      for (let index = 1; index < runIds.length; index++) {
        expect(getSubagentRunByRunId(runIds[index]!)).toMatchObject({
          runId: runIds[index],
          childSessionKey: childKeys[index % 2],
          requesterTurnRunId,
          requesterTurnYielded: true,
          execution: { status: "running" },
          delivery: { status: "pending" },
        });
      }
      const result: EmbeddedAgentRunResult = { meta: { durationMs: 1, yielded: true } };
      await withCaller(() =>
        settleRequesterRun(
          {
            sessionKey: requesterSessionKey,
            agentId: "main",
            runId: requesterTurnRunId,
            admittedRunContext,
          },
          result,
          () => {},
        ),
      );
      expect(result.requesterContinuationSettled).toBe(true);
      await withCaller(() =>
        settleRequesterRun(
          {
            sessionKey: requesterSessionKey,
            agentId: "main",
            runId: requesterTurnRunId,
            admittedRunContext,
          },
          result,
          () => {},
        ),
      );
      reply.operation.complete();
      await reply.operation.ownerSettlement;
      admission.close();
      await releaseAndObserve(
        () => runIds.slice(1).every(childDeliverySettled),
        () => replies.forEach((pendingReply) => pendingReply.resolve()),
      );
      await settleSessionWork();
      const delivered = requesterCalls(requesterSessionKey);
      expect(delivered).toHaveLength(deliveredEarly ? 2 : 1);
      const batch = delivered.at(-1)?.params;
      expect(batch).toMatchObject({ inputProvenance: { sourceTool: "subagent_settle" } });
      if (mode === "held") {
        expect(batch?.message).toContain("RECEIPT-1");
      } else {
        expect(batch?.message).not.toContain("RECEIPT-1");
      }
      for (const index of [2, 3, 4]) {
        expect(batch?.message).toContain("RECEIPT-" + index);
      }
      for (const runId of runIds.slice(1)) {
        expect(getSubagentRunByRunId(runId)).toMatchObject({ delivery: { status: "delivered" } });
        expect(getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
      }
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
      try {
        await registryTesting.sweepOnceForTests();
      } finally {
        clock.mockRestore();
      }
      for (const runId of executionRunIds) {
        expect(getSubagentRunByRunId(runId)).toBeUndefined();
      }
    } finally {
      if (adoptedRun) {
        clearActiveEmbeddedRun(childKeys[0]!, adoptedRun.handle, childKeys[0]!);
      }
      replacement?.close();
      admission.close();
      reply.operation.complete();
      await reply.operation.ownerSettlement;
      replies.forEach((pendingReply) => pendingReply.resolve());
      await cleanupFollowup();
      operator.release();
    }
  });
}
