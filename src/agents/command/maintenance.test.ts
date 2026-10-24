import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestState as state,
  compactionTestRuntime,
  findCompactionSessionEntry as findStoredSessionEntry,
  requireCompactionStorePath as requireStorePath,
  makeCompactionResult,
  readCompactionLifecyclePhases,
  registerAgentCommandCompactionTestHooks,
  GATEWAY_INGRESS_ARGS,
} from "../agent-command.compaction.test-support.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";

const {
  runAgentAttemptMock: attempt,
  runMemoryFlushIfNeededMock: memoryFlush,
  runSessionPreflightCompactionMock: preflight,
  runSessionCompactionIfNeededMock: compact,
  runCliTurnCompactionLifecycleMock: cliCompact,
  deliverAgentCommandResultMock: deliver,
} = state;
const {
  replaceSessionEntry,
  patchSessionEntryCore,
  loadSessionEntry,
  loadTranscriptEvents,
  acceptCompactionSuccessor,
  createAgentRunRestartAbortError,
} = compactionTestRuntime;

registerAgentCommandCompactionTestHooks();

function sessionTarget(sessionId: string, kind = "explicit") {
  return {
    sessionId,
    sessionKey: `agent:main:${kind}:${sessionId}`,
    storePath: requireStorePath(),
  };
}
async function transcript(target: Parameters<typeof loadTranscriptEvents>[0]) {
  return JSON.stringify(await loadTranscriptEvents(target));
}
function answer(sessionId: string, text: string, runner: "cli" | "embedded" = "embedded") {
  return makeCompactionResult({ sessionId, text, runner, agentHarnessId: "openclaw" });
}
function expectDelivered(text: string, sessionId?: string) {
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({
      payloads: [{ text }],
      ...(sessionId
        ? {
            result: expect.objectContaining({
              meta: expect.objectContaining({ agentMeta: expect.objectContaining({ sessionId }) }),
            }),
          }
        : {}),
    }),
  );
}

describe("agent command foreground completion", () => {
  it("skips fresh-child preflight once and reads committed state on its next turn", async () => {
    const { sessionId, sessionKey, storePath } = sessionTarget("fresh-child-preflight", "subagent");
    const firstPrompt = "Remember the child's first-turn marker.";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    const runtimeContext = {
      config: expectDefined(state.cfg, "command config"),
      pluginGeneration: {
        remoteCatalog: null,
        pluginMetadataSnapshot: createPluginMetadataSnapshot({
          manifestRegistry: { plugins: [], diagnostics: [] },
        }),
        inlineProviderModels: [],
        configuredCatalogEntries: [],
      },
    };
    attempt.mockImplementation(async (params) => {
      await params.userTurnTranscriptRecorder?.persistApproved();
      return makeCompactionResult({ sessionId, text: "Child answer.", runner: "embedded" });
    });

    await agentCommandFromGatewayIngress(
      { message: firstPrompt, sessionId, sessionKey, allowModelOverride: false },
      ...GATEWAY_INGRESS_ARGS,
      { ...runtimeContext, freshChild: true },
    );
    await waitForSessionMaintenance(sessionKey);
    expect(preflight).not.toHaveBeenCalled();
    expect(await transcript({ sessionId, storePath })).toContain(firstPrompt);

    await patchSessionEntryCore({ sessionKey, storePath }, () => ({
      totalTokens: 90_000,
      totalTokensFresh: true,
    }));
    preflight.mockImplementationOnce(async (params) => {
      expect(params.sessionEntry).toMatchObject({ sessionId, totalTokens: 90_000 });
      expect(await transcript({ sessionId, storePath })).toContain(firstPrompt);
      return params.sessionEntry;
    });
    await agentCommandFromGatewayIngress(
      { message: "Continue the child.", sessionId, sessionKey, allowModelOverride: false },
      ...GATEWAY_INGRESS_ARGS,
      runtimeContext,
    );
    expect(preflight).toHaveBeenCalledOnce();
    expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(sessionId);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it.each([
    { abortStage: "none", preserveUserFacingSessionModelState: false },
    { abortStage: "none", preserveUserFacingSessionModelState: true },
    { abortStage: "compaction", preserveUserFacingSessionModelState: false },
    { abortStage: "memory", preserveUserFacingSessionModelState: false },
  ] as const)(
    "retains the accepted preflight successor (abort=$abortStage, preserve=$preserveUserFacingSessionModelState)",
    async ({ abortStage, preserveUserFacingSessionModelState }) => {
      const aborted = abortStage !== "none";
      const { sessionId, sessionKey, storePath } = sessionTarget("preflight-predecessor");
      const successorId = "preflight-successor";
      const prompt = "Record the preflight successor marker.";
      const events: string[] = [];
      const controller = new AbortController();
      const onSessionIdChanged = vi.fn();
      const abortError = createAgentRunRestartAbortError();
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId, updatedAt: Date.now(), totalTokens: 90_000, totalTokensFresh: true },
      );
      memoryFlush.mockImplementationOnce(async (params) => {
        events.push("checkpoint");
        if (abortStage === "memory") {
          controller.abort(abortError);
          return { sessionEntry: params.sessionEntry, outcome: "failed" };
        }
        return { sessionEntry: params.sessionEntry, outcome: "completed" };
      });
      preflight.mockImplementationOnce(async (params) => {
        const entry = expectDefined(params.sessionEntry, "preflight predecessor");
        const checkpoint = expectDefined(params.beforeCompaction, "preflight checkpoint");
        const refreshed = expectDefined(await checkpoint(entry), "checkpoint session");
        const ownerEntry = expectDefined(
          loadSessionEntry({ agentId: "main", sessionKey, storePath }),
          "authoritative checkpoint owner",
        );
        events.push("compaction");
        const accepted = await acceptCompactionSuccessor({
          currentTarget: { agentId: "main", sessionId: refreshed.sessionId, sessionKey, storePath },
          currentSessionFile: sessionKey,
          expectedEntry: {
            sessionId: refreshed.sessionId,
            lifecycleRevision: ownerEntry.lifecycleRevision,
            activeWriterRunId: ownerEntry.activeWriterRunId,
          },
          assertActive: () => params.abortSignal?.throwIfAborted(),
          onCommitted: params.onCompactionCommitted,
          result: {
            ok: true,
            compacted: true,
            result: { sessionId: successorId, tokensBefore: 90_000, tokensAfter: 42 },
          },
        });
        if (params.sessionStore) {
          params.sessionStore[sessionKey] = accepted.entry;
        }
        if (aborted) {
          controller.abort(abortError);
          params.abortSignal?.throwIfAborted();
        }
        params.onSessionIdChanged?.(accepted.sessionId);
        return accepted.entry;
      });
      attempt.mockImplementationOnce(async (params) => {
        events.push("attempt");
        await params.userTurnTranscriptRecorder?.persistApproved();
        return makeCompactionResult({
          sessionId: params.sessionId,
          text: "successor answer",
          runner: "embedded",
        });
      });

      const command = agentCommand({
        message: prompt,
        sessionId,
        sessionKey,
        oneShotCliRun: true,
        preserveUserFacingSessionModelState,
        abortSignal: controller.signal,
        onSessionIdChanged,
      });
      if (aborted) {
        await expect(command).rejects.toBe(abortError);
        expect(onSessionIdChanged.mock.calls).toEqual(
          abortStage === "memory" ? [] : [[successorId]],
        );
        expect(events).toEqual(
          abortStage === "compaction" ? ["checkpoint", "compaction"] : ["checkpoint"],
        );
        expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(
          abortStage === "memory" ? sessionId : successorId,
        );
        expect(attempt).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        return;
      }
      await command;

      expect(events).toEqual(["checkpoint", "compaction", "attempt"]);
      expect(memoryFlush).toHaveBeenCalledOnce();
      expect(preflight).toHaveBeenCalledOnce();
      expect(compact).not.toHaveBeenCalled();
      expect(attempt.mock.calls[0]?.[0]).toMatchObject({
        sessionId: successorId,
        sessionTarget: { agentId: "main", sessionId: successorId, sessionKey, storePath },
      });
      expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(successorId);
      expect(await transcript({ agentId: "main", sessionId: successorId, storePath })).toContain(
        prompt,
      );
      expect(await transcript({ agentId: "main", sessionId, storePath })).not.toContain(prompt);
      expectDelivered("successor answer", successorId);
    },
  );

  it("returns a completed Gateway reply before optional memory work finishes", async () => {
    const { sessionId, sessionKey } = sessionTarget("foreground-before-memory");
    const flush = createDeferred();
    const flushStarted = createDeferred();
    let foregroundCompleted = false;
    const requestBudget = {
      contextWindow: 32_768,
      reserveTokens: 8_192,
      fixedTokens: 9_500,
      pendingTokens: 512,
    };
    let flushParameters: Parameters<typeof memoryFlush>[0] | undefined;
    attempt.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      params.onCompactionRequestBudget?.(requestBudget);
      return answer(sessionId, "Completed foreground answer.");
    });
    memoryFlush.mockImplementationOnce(async (params) => {
      flushParameters = params;
      flushStarted.resolve();
      await flush.promise;
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });
    const command = agentCommandFromGatewayIngress(
      {
        message: "continue",
        sessionId,
        sessionKey,
        allowModelOverride: true,
        senderIsOwner: true,
        runContext: {
          messageChannel: "webchat",
          accountId: "primary",
          groupId: "group-42",
          groupChannel: "channel-42",
          groupSpace: "space-42",
        },
      },
      ...GATEWAY_INGRESS_ARGS,
    ).then((result) => {
      foregroundCompleted = true;
      return result;
    });
    try {
      await flushStarted.promise;
      expect(foregroundCompleted).toBe(true);
      expect(flushParameters?.followupRun.run).toMatchObject({
        messageProvider: "webchat",
        agentAccountId: "primary",
        groupId: "group-42",
        groupChannel: "channel-42",
        groupSpace: "space-42",
        senderIsOwner: false,
      });
      // Only the flush audience inherits the command's trusted owner status.
      expect(flushParameters?.followupRun.memoryAudienceSenderIsOwner).toBe(true);
      expectDelivered("Completed foreground answer.");
      expect(readCompactionLifecyclePhases()).toContain("end");
      expect(compact).not.toHaveBeenCalled();
    } finally {
      flush.resolve();
      await command;
      await waitForSessionMaintenance(sessionKey);
    }
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionRequestBudget: { ...requestBudget, pendingTokens: 0 },
      }),
    );
  });

  it.each(["cli", "embedded"] as const)(
    "preserves the %s one-shot compaction boundary before delivery",
    async (runner) => {
      const { sessionId, sessionKey } = sessionTarget(`one-shot-compaction-${runner}`);
      const compactionStarted = createDeferred();
      const releaseCompaction = createDeferred();
      const events: string[] = [];
      attempt.mockImplementationOnce(async (params) => {
        params.onSuccessfulAuthProfile?.({});
        return answer(sessionId, "one-shot answer", runner);
      });
      cliCompact.mockImplementationOnce(async (params) => {
        events.push("compaction started");
        compactionStarted.resolve();
        await releaseCompaction.promise;
        events.push("compaction completed");
        return params.sessionEntry;
      });
      deliver.mockImplementationOnce(async () => {
        events.push("delivery");
        return { deliverySucceeded: true };
      });
      const command = agentCommand({
        message: "complete once",
        sessionId,
        sessionKey,
        oneShotCliRun: true,
      });
      try {
        if (runner === "cli") {
          await expect(
            Promise.race([
              compactionStarted.promise.then(() => "compaction"),
              command.then(() => "command completed before compaction"),
            ]),
          ).resolves.toBe("compaction");
          expect(deliver).not.toHaveBeenCalled();
          releaseCompaction.resolve();
        }
        await command;
        await waitForSessionMaintenance(sessionKey);

        expect(events).toEqual(
          runner === "cli"
            ? ["compaction started", "compaction completed", "delivery"]
            : ["delivery"],
        );
        expect(cliCompact).toHaveBeenCalledTimes(runner === "cli" ? 1 : 0);
        expect(compact).not.toHaveBeenCalled();
        expect(memoryFlush).not.toHaveBeenCalled();
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        releaseCompaction.resolve();
        await Promise.allSettled([command]);
        await waitForSessionMaintenance(sessionKey);
      }
    },
  );
});
