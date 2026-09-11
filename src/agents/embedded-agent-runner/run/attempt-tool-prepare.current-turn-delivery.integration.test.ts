import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { assert, describe, expect, it } from "vitest";
import {
  withCurrentReplyIntegration,
  type CurrentReplyIntegration,
} from "../../../../test/helpers/agents/current-turn-delivery-integration.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import type { ToolOutcomeObservation } from "../../agent-tools.before-tool-call.js";
import { readCurrentTurnReplyCompletion } from "../../current-turn-reply-completion.js";
import type { AgentEvent } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { isAgentToolReplaySafe } from "../../tool-replay-safety.js";
import { readToolResultDetails } from "../../tool-result-error.js";
import { clearToolSearchCatalog, type ToolSearchCatalogToolExecutor } from "../../tool-search.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";
import {
  prepareEmbeddedAttemptAgentSession,
  prepareEmbeddedAttemptSessionManager,
} from "./attempt-session-prepare.js";
import { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";

type PreparedTurn = Awaited<ReturnType<typeof prepareTurn>>;

function readPersistedMessages(fixture: CurrentReplyIntegration) {
  return loadTranscriptEventsSync(fixture.scope).flatMap((event) => {
    const entry = asOptionalRecord(event);
    const message = asOptionalRecord(entry?.message);
    return entry?.type === "message" && message ? [{ entry, message }] : [];
  });
}

async function prepareTurn(fixture: CurrentReplyIntegration) {
  const turn = await fixture.createTurn();
  const attempt = turn.attempt;
  const outcomes: ToolOutcomeObservation[] = [];
  attempt.onToolOutcome = (outcome) => outcomes.push({ ...outcome });
  const trace = createDiagnosticTraceContext();
  const setup = await prepareEmbeddedAttemptSetup(attempt);
  const runAbortController = new AbortController();
  const sessionLock = await prepareEmbeddedAttemptTranscriptLifecycle({
    attempt,
    externalAbortController: {
      throwIfFiredAfterPrepCleanup: async () => turn.abortController.signal.throwIfAborted(),
    },
  });
  const { transcriptLifecycle, withOwnedTranscriptWrite } = sessionLock;
  let catalogExecutor: ToolSearchCatalogToolExecutor | undefined;
  const nestedCalls: Array<{
    toolName: string;
    toolCallId: string;
    parentToolCallId?: string;
  }> = [];
  // Match the attempt's late binding: controls are built before the real session
  // subscription owns nested execution and durable transcript acceptance.
  const executeTool: ToolSearchCatalogToolExecutor = (params) => {
    assert(catalogExecutor, "session subscription must own catalog execution");
    nestedCalls.push({
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      parentToolCallId: params.parentToolCallId,
    });
    return catalogExecutor(params);
  };
  let preparedBase: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
  let bundle: Awaited<ReturnType<typeof prepareEmbeddedAttemptBundleTools>> | undefined;
  let activeSession: AgentSession | undefined;
  let stream: ReturnType<typeof prepareEmbeddedAttemptStream> | undefined;
  let releaseResponses = () => {};
  const dispose = async () => {
    const errors: unknown[] = [];
    const cleanup = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    fixture.network.releaseAll();
    releaseResponses();
    activeSession?.agent.abort();
    runAbortController.abort();
    for (const runCleanup of preparedBase?.runCleanups ?? []) {
      await cleanup(() => runCleanup("cancel"));
    }
    await cleanup(() => fixture.waitForSettled());
    if (stream) {
      const current = stream;
      await cleanup(() => current.subscription.unsubscribe());
      await cleanup(() =>
        clearActiveEmbeddedRun(attempt.sessionId, current.queueHandle, attempt.sessionKey),
      );
    }
    await cleanup(() => transcriptLifecycle.beginCleanup());
    await cleanup(() => activeSession?.dispose());
    await cleanup(() => bundle?.bundleMcpRuntime?.dispose());
    await cleanup(() => bundle?.bundleLspRuntime?.dispose());
    if (preparedBase) {
      const current = preparedBase;
      await cleanup(() =>
        clearToolSearchCatalog({
          sessionId: attempt.sessionId,
          sessionKey: attempt.sessionKey,
          runId: attempt.runId,
          catalogRef: current.toolSearchCatalogRef,
        }),
      );
    }
    await cleanup(() => transcriptLifecycle.dispose());
    await cleanup(() => turn.closeHost());
    if (errors.length > 0) {
      throw new AggregateError(errors, "Embedded current reply cleanup failed");
    }
  };
  try {
    const base = await prepareEmbeddedAttemptToolBase({
      agentDir: fixture.state.agentDir(),
      attempt,
      setup,
      markCoreToolStage: () => {},
      onYield: () => {},
      runAbortController,
      runTrace: trace,
      skillUsagePaths: undefined,
      skillsSnapshot: undefined,
      codeModeSkills: [],
      toolSearchCatalogExecutor: executeTool,
    });
    preparedBase = base;
    bundle = await prepareEmbeddedAttemptBundleTools({
      agentDir: fixture.state.agentDir(),
      attempt,
      setup,
      isRawModelRun: false,
      preparedToolBase: base,
    });
    const catalog = prepareEmbeddedAttemptToolCatalog({
      attempt,
      setup,
      preparedToolBase: base,
      bundleTools: bundle,
      runTrace: trace,
      abortSignal: runAbortController.signal,
      executeCodeModeTool: executeTool,
    });
    const preparedManager = await prepareEmbeddedAttemptSessionManager({
      attempt,
      agentDir: fixture.state.agentDir(),
      effectiveCwd: setup.effectiveCwd,
      effectiveWorkspace: setup.effectiveWorkspace,
      onSessionManagerCreated: () => {},
      replayAllowedToolNames: catalog.toolSearchRunPlan.replayAllowedToolNames,
      resolveActiveContextEnginePluginId: () => undefined,
      sessionAgentId: setup.sessionAgentId,
      transcriptLifecycle,
      withOwnedTranscriptWrite,
    });
    const { sessionManager } = preparedManager;
    await withOwnedTranscriptWrite(() =>
      sessionManager.appendMessage({ role: "user", content: attempt.prompt, timestamp: 1 }),
    );
    const session = await prepareEmbeddedAttemptAgentSession({
      attempt,
      agentCoreThinkingLevel: setup.agentCoreThinkingLevel,
      agentDir: fixture.state.agentDir(),
      clientToolPreparation: {
        catalogToolHookContext: catalog.catalogToolHookContext,
        codeModeControlsEnabledForRun: base.codeModeControlsEnabledForRun,
        deferredDirectoryToolsCallable: catalog.deferredDirectoryToolsCallable,
        effectiveTools: catalog.effectiveTools,
        replaySafetyOptions: base.replaySafetyOptions,
        sandboxEnabled: Boolean(setup.sandbox?.enabled),
        sandboxSessionKey: setup.sandboxSessionKey,
        sessionAgentId: setup.sessionAgentId,
        toolSearchCatalogRef: base.toolSearchCatalogRef,
        toolSearchRuntimeConfig: base.toolSearchRuntimeConfig,
        uncompactedEffectiveTools: bundle.uncompactedEffectiveTools,
        clientTools: bundle.clientTools,
        getToolAbortSignal: () => base.toolAbortSignal,
      },
      effectiveCwd: setup.effectiveCwd,
      getCurrentAttemptPluginMetadataSnapshot: setup.getCurrentAttemptPluginMetadataSnapshot,
      initialSystemPrompt: "Complete the requested work and reply once.",
      markStage: () => {},
      onSessionCreated: (created) => {
        activeSession = created;
      },
      onSystemPromptChanged: () => {},
      runAbortSignal: runAbortController.signal,
      sessionAgentId: setup.sessionAgentId,
      transcriptLifecycle,
      sessionManager,
      assertInitialUserTurnReplay: preparedManager.assertInitialUserTurnReplay,
    });
    const promptPolicy = createPromptBuildToolPolicy({
      session: session.activeSession,
      effectiveTools: catalog.effectiveTools,
      uncompactedEffectiveTools: bundle.uncompactedEffectiveTools,
      tools: bundle.tools,
      catalogRef: base.toolSearchCatalogRef,
      codeModeControlsEnabled: base.codeModeControlsEnabledForRun,
      onApplied: (surface) =>
        catalog.applyPromptToolPolicy(
          new Set([
            ...surface.activeToolNames,
            ...surface.uncompactedEffectiveTools.map((tool) => tool.name),
          ]),
        ),
    });
    stream = prepareEmbeddedAttemptStream({
      attempt,
      applyPermissionMode: (mode, revokeApprovals) => {
        base.refreshPermissionMode(mode, revokeApprovals);
        bundle!.refreshTools();
        catalog.refreshTools();
        session.refreshTools();
        promptPolicy.refresh();
        session.setPermissionPromptPreparation(undefined);
      },
      activeSession: session.activeSession,
      hookRunner: session.hookRunner,
      hookAgentId: setup.sessionAgentId,
      diagnosticTrace: trace,
      clientToolCallSlots: session.clientToolCallSlots,
      nestedToolActivities: base.nestedToolActivities,
      currentTurnReplyCompletion: base.currentTurnReplyCompletion,
      isReplaySafeTool: (tool) => isAgentToolReplaySafe(tool, base.replaySafetyOptions),
      runAbortController,
      abortRun: () => runAbortController.abort(),
      markExternalAbort: () => {},
      getRunState: () => ({
        aborted: runAbortController.signal.aborted,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
      hasDeliveredSourceReply: session.hasDeliveredSourceReply,
      markSourceReplyDelivered: session.markSourceReplyDelivered,
      onBlockReply: undefined,
      onBlockReplyFlush: undefined,
      sandboxSessionKey: setup.sandboxSessionKey,
      builtinToolNames: session.builtinToolNames,
      coreBuiltinToolNames: session.coreBuiltinToolNames,
      replaySafeToolNames: session.replaySafeToolNames,
      codeModeExecToolNames: session.codeModeExecToolNames,
      sideEffectToolOwners: session.sideEffectToolOwners,
      diagnosticOwner: createDiagnosticEmbeddedRunOwner(attempt),
    });
    catalogExecutor = stream.toolSearchCatalogExecutor;
    const refresh = async (mode: "full" | "workspace") => {
      const handle = stream?.queueHandle;
      assert(handle?.applyPermissionMode, "expected the live permission-change entry point");
      expect(attempt.permissionMode).not.toBe(mode);
      const previousSignal = base.toolAbortSignal;
      let approvalsRevoked = false;
      const accepted = await handle.applyPermissionMode(mode, () => {
        expect(previousSignal.aborted).toBe(true);
        approvalsRevoked = true;
      });
      expect(accepted).toBe(true);
      expect(approvalsRevoked).toBe(true);
      expect(attempt.permissionMode).toBe(mode);
      expect(base.toolAbortSignal).not.toBe(previousSignal);
      expect(base.toolAbortSignal.aborted).toBe(false);
    };
    let started = false;
    return {
      turn,
      base,
      outcomes,
      nestedCalls,
      sessionManager,
      appendUser: (content: string) =>
        withOwnedTranscriptWrite(() =>
          sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() }),
        ),
      refresh,
      dispose,
      control: () => {
        const tool = session.activeSession.agent.state.tools.find(
          (candidate) => candidate.name === "exec",
        );
        assert(tool, "expected the real session's Code Mode control");
        return tool;
      },
      start: (programs: Array<{ id: string; code: string }>) => {
        assert(!started, "each prepared turn owns one real agent run");
        assert(programs.length > 0, "expected a bounded Code Mode response script");
        started = true;
        const agent = session.activeSession.agent;
        expect(agent.state.messages.at(-1)?.role).toBe("user");
        type ToolOutcome = Extract<AgentEvent, { type: "tool_execution_end" }>;
        const steps = programs.map((program) => ({
          ...program,
          ready: createDeferred(),
          outcome: createDeferred<ToolOutcome>(),
        }));
        releaseResponses = () => {
          for (const step of steps) {
            step.ready.resolve();
          }
        };
        const events: AgentEvent[] = [];
        const unsubscribe = agent.subscribe((event) => {
          events.push(event);
          if (event.type === "tool_execution_end") {
            steps.find((step) => step.id === event.toolCallId)?.outcome.resolve(event);
          }
          if (event.type === "turn_end" && event.message.role === "assistant") {
            const content = event.message.content;
            const index = steps.findIndex((step) =>
              content.some((item) => item.type === "toolCall" && item.id === step.id),
            );
            // Settle permission changes before the real next-turn owner captures
            // its tool snapshot, not after a scripted response has already started.
            if (index >= 0) {
              return steps[index + 1]?.ready.promise;
            }
          }
          return undefined;
        });
        const originalStream = agent.streamFn;
        let responseCount = 0;
        // Only model responses are scripted. The real loop owns execution,
        // outcome classification, event settlement, and AgentSession persistence.
        agent.streamFn = async () => {
          assert(responseCount <= steps.length, "unexpected extra model continuation");
          const step = steps[responseCount++];
          await step?.ready.promise;
          const message: AssistantMessage = {
            role: "assistant",
            content: step
              ? [{ type: "toolCall", id: step.id, name: "exec", arguments: { code: step.code } }]
              : [{ type: "text", text: "Script complete." }],
            api: attempt.model.api,
            provider: attempt.model.provider,
            model: attempt.model.id,
            usage: createZeroUsageFixture(),
            stopReason: step ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          const response = createAssistantMessageEventStream();
          queueMicrotask(() => {
            response.push({
              type: "done",
              reason: step ? "toolUse" : "stop",
              message,
            });
            response.end();
          });
          return response;
        };
        steps[0]!.ready.resolve();
        const done = fixture.track(
          withOwnedSessionTranscriptWrites(sessionLock.ownedTranscriptWriteContext, () =>
            agent.continue(),
          ).finally(() => {
            agent.streamFn = originalStream;
            unsubscribe();
          }),
        );
        const findStep = (id: string) => {
          const step = steps.find((candidate) => candidate.id === id);
          assert(step, `unknown scripted call: ${id}`);
          return step;
        };
        return {
          events,
          done,
          agent,
          respond: (id: string) => findStep(id).ready.resolve(),
          outcome: (id: string) =>
            Promise.race([
              findStep(id).outcome.promise,
              done.then(() => {
                const outcome = events.find(
                  (event): event is ToolOutcome =>
                    event.type === "tool_execution_end" && event.toolCallId === id,
                );
                assert(outcome, `agent ended before scripted call: ${id}`);
                return outcome;
              }),
            ]),
        };
      },
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Embedded current reply preparation failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

async function withPreparedTurn(
  fixture: CurrentReplyIntegration,
  run: (prepared: PreparedTurn) => Promise<void>,
) {
  const dispatcher = getGlobalDispatcher();
  let prepared: PreparedTurn | undefined;
  const errors: unknown[] = [];
  try {
    prepared = await prepareTurn(fixture);
    await run(prepared);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await prepared?.dispose();
    } catch (error) {
      errors.push(error);
    }
    const createdDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(dispatcher);
    if (createdDispatcher !== dispatcher) {
      try {
        await createdDispatcher.close();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Embedded current reply integration failed");
  }
}

describe("embedded current reply across real permission preparation", () => {
  it("allocates a new completion owner for the next genuine turn in the same session", async () => {
    await withCurrentReplyIntegration(async (fixture) => {
      let firstOwner: object | undefined;
      await withPreparedTurn(fixture, async (prepared) => {
        firstOwner = prepared.turn.owner;
        const held = fixture.network.hold("post");
        const code = 'return await send_current_reply({text:"first turn"});';
        const running = prepared.start([{ id: "first-turn", code }]);
        await held.wait();
        const before = readPersistedMessages(fixture);
        const outerCall = before.find(({ message }) => message.role === "assistant");
        assert(outerCall, "expected the persisted outer call before the physical reply");
        expect(outerCall.message.content).toEqual([
          { type: "toolCall", id: "first-turn", name: "exec", arguments: { code } },
        ]);
        expect(prepared.nestedCalls).toHaveLength(1);
        const originalNestedCall = prepared.nestedCalls[0]!;
        held.release.resolve();
        await running.done;
        const { result, isError } = await running.outcome("first-turn");
        await fixture.waitForSettled();
        expect(result).toMatchObject({ terminate: true });
        expect(isError).toBe(false);
        expect(running.agent.state.isStreaming).toBe(false);
        expect(running.agent.state.pendingToolCalls.size).toBe(0);
        expect(prepared.turn.completion()).toBe("confirmed");
        const persisted = readPersistedMessages(fixture);
        const mirrors = persisted.filter(({ message }) =>
          isOpenClawDeliveryMirrorAssistantMessage(message),
        );
        const activities = persisted.filter(({ message }) => readNestedToolActivity(message));
        const outerResults = persisted.filter(({ message }) => message.role === "toolResult");
        expect(mirrors).toHaveLength(1);
        expect(mirrors[0]?.message.content).toEqual([{ type: "text", text: "first turn" }]);
        expect(activities).toHaveLength(1);
        expect(outerResults).toHaveLength(1);
        expect(activities[0]?.message).toMatchObject({
          role: "custom",
          excludeFromContext: true,
          details: {
            ...originalNestedCall,
            parentToolCallId: "first-turn",
            afterEntryId: outerCall.entry.id,
            toolName: "send_current_reply",
            isError: false,
          },
        });
        expect(outerResults[0]?.message).toMatchObject({
          toolCallId: "first-turn",
          toolName: "exec",
          details: readToolResultDetails(result),
          isError: false,
        });
        expect(persisted.slice(0, before.length)).toEqual(before);
        expect(persisted.slice(before.length).map(({ entry }) => entry.id)).toEqual([
          mirrors[0]?.entry.id,
          activities[0]?.entry.id,
          outerResults[0]?.entry.id,
        ]);
        expect(activities[0]?.entry.parentId).toBe(mirrors[0]?.entry.id);
        expect(outerResults[0]?.entry.parentId).toBe(activities[0]?.entry.id);
        expect(
          prepared.sessionManager
            .buildSessionContext()
            .messages.some((message) => readNestedToolActivity(message) !== undefined),
        ).toBe(false);
      });
      fixture.network.allowNextTurn();
      await withPreparedTurn(fixture, async (prepared) => {
        expect(prepared.turn.owner).not.toBe(firstOwner);
        const running = prepared.start([
          { id: "second-turn", code: 'return await send_current_reply({text:"second turn"});' },
        ]);
        await running.done;
        await fixture.waitForSettled();
        const { result, isError } = await running.outcome("second-turn");
        expect(result).toMatchObject({ terminate: true });
        expect(isError).toBe(false);
        expect(prepared.turn.completion()).toBe("confirmed");
        expect(readCurrentTurnReplyCompletion(firstOwner)).toBe("confirmed");
        expect(fixture.network.counts.post).toBe(2);
      });
    });
  });

  it("rejects a held invocation's activity after the same prepared manager accepts a new user", async () => {
    await withCurrentReplyIntegration(async (fixture) => {
      await withPreparedTurn(fixture, async (prepared) => {
        const held = fixture.network.hold("post");
        const code = 'return await send_current_reply({text:"already delivered"});';
        const running = prepared.start([
          {
            id: "superseded-call",
            code,
          },
        ]);
        await held.wait();
        expect(prepared.turn.completion()).toBe("pending");
        const manager = prepared.sessionManager;
        const beforeNewUser = readPersistedMessages(fixture);
        const outerCall = beforeNewUser.find(({ message }) => message.role === "assistant");
        assert(outerCall, "expected the original assistant call while its reply is held");
        expect(outerCall.message.content).toEqual([
          { type: "toolCall", id: "superseded-call", name: "exec", arguments: { code } },
        ]);
        const newUserId = await prepared.appendUser("A new user turn owns this manager.");
        const beforeSettlement = readPersistedMessages(fixture);
        const newUser = beforeSettlement.find(({ entry }) => entry.id === newUserId);
        assert(newUser, "expected the new user to be persisted by the same prepared manager");
        // The guard closes the old call before the new user, not when its late
        // delivery settles. Preserve this repair without admitting a stale result.
        const repairedResults = beforeSettlement.filter(
          ({ message }) => message.role === "toolResult",
        );
        expect(repairedResults).toHaveLength(1);
        expect(repairedResults[0]?.message).toMatchObject({
          role: "toolResult",
          toolCallId: "superseded-call",
          toolName: "exec",
          content: [{ type: "text", text: "aborted" }],
          details: {
            openclawSyntheticMissingToolResult: true,
            reason: "missing_tool_result",
          },
          isError: true,
        });
        expect(repairedResults[0]?.entry.parentId).toBe(outerCall.entry.id);
        expect(newUser.entry.parentId).toBe(repairedResults[0]?.entry.id);
        expect(beforeSettlement.slice(0, beforeNewUser.length)).toEqual(beforeNewUser);
        expect(beforeSettlement.slice(beforeNewUser.length)).toEqual([repairedResults[0], newUser]);
        const selection = {
          leafId: manager.getLeafId(),
          appendParentId: manager.getAppendParentId(),
        };
        expect(selection).toEqual({ leafId: newUserId, appendParentId: newUserId });
        held.release.resolve();
        const [settlement] = await Promise.allSettled([running.done]);
        await fixture.waitForSettled();
        const persistenceFailure = `SQLite transcript changed while preparing rewrite for ${fixture.scope.sessionId}`;
        if (settlement.status === "rejected") {
          expect(settlement.reason).toMatchObject({ message: persistenceFailure });
        }
        expect(running.events).toContainEqual(
          expect.objectContaining({
            type: "message_start",
            message: expect.objectContaining({
              role: "assistant",
              stopReason: "error",
              errorMessage: persistenceFailure,
            }),
          }),
        );
        expect(running.agent.state.isStreaming).toBe(false);
        expect(running.agent.state.pendingToolCalls.size).toBe(0);

        // A confirmed delivery is not an aborted or absent send. Its bookkeeping
        // cannot authorize the old invocation to consume a later user turn.
        expect(prepared.turn.completion()).toBe("confirmed");
        expect(prepared.base.toolAbortSignal.aborted).toBe(false);
        expect(fixture.network.counts.post).toBe(1);
        expect(fixture.pendingToolExecutions()).toBe(0);
        expect(prepared.base.nestedToolActivities).toHaveLength(0);
        const persisted = readPersistedMessages(fixture);
        expect(persisted.filter(({ message }) => readNestedToolActivity(message))).toEqual([]);
        expect(persisted.filter(({ message }) => message.role === "toolResult")).toEqual(
          repairedResults,
        );
        expect(persisted.slice(0, beforeSettlement.length)).toEqual(beforeSettlement);
        const appended = persisted.slice(beforeSettlement.length);
        expect(appended).toHaveLength(1);
        expect(isOpenClawDeliveryMirrorAssistantMessage(appended[0]?.message)).toBe(true);
        expect(appended[0]?.message.content).toEqual([{ type: "text", text: "already delivered" }]);
        expect(persisted.find(({ entry }) => entry.id === newUserId)).toEqual(newUser);
        expect(manager.getEntry(newUserId)).toEqual(newUser.entry);
        expect({
          leafId: manager.getLeafId(),
          appendParentId: manager.getAppendParentId(),
        }).toEqual(selection);
      });
    });
  });

  it.each(["accepted", "lost response"] as const)(
    "continues a refreshed catalog after %s without replaying the earlier mutation or reply",
    async (acknowledgement) => {
      await withCurrentReplyIntegration(async (fixture) => {
        await withPreparedTurn(fixture, async (prepared) => {
          const held = fixture.network.hold("post");
          if (acknowledgement === "lost response") {
            fixture.network.loseFirstPostResponse();
          }
          const file = path.join(fixture.state.workspaceDir, "mutation.txt");
          const before = prepared.control();
          const running = prepared.start([
            {
              id: "before-refresh",
              code: `await write({path:${JSON.stringify(file)},content:"once"});
                return await send_current_reply({text:"held reply"});`,
            },
            {
              id: "after-refresh",
              code: 'return await send_current_reply({text:"must not send twice"});',
            },
            {
              id: "ordinary-continuation",
              code: `return await edit({path:${JSON.stringify(file)},edits:[{oldText:"once",newText:"continued"}]});`,
            },
          ]);
          await held.wait();
          expect(await fs.readFile(file, "utf8")).toBe("once");
          expect(prepared.turn.completion()).toBe("pending");
          const writeOutcomes = structuredClone(
            prepared.outcomes.filter((outcome) => outcome.toolName === "write"),
          );
          expect(writeOutcomes.map((outcome) => outcome.presentationOnly === true)).toEqual([
            false,
            true,
          ]);
          const previousSignal = prepared.base.toolAbortSignal;
          await prepared.refresh("workspace");
          expect(previousSignal.aborted).toBe(true);
          expect(prepared.base.toolAbortSignal.aborted).toBe(false);
          expect(prepared.control()).not.toBe(before);
          await running.outcome("before-refresh");
          running.respond("after-refresh");
          const second = await running.outcome("after-refresh");
          expect(JSON.stringify(second.result)).toContain("already been consumed");
          expect(second.isError).toBe(true);
          expect(fixture.network.counts.post).toBe(1);
          held.release.resolve();
          await expect.poll(prepared.turn.completion).toBe("ambiguous");

          running.respond("ordinary-continuation");
          await running.done;
          await fixture.waitForSettled();
          const continuation = await running.outcome("ordinary-continuation");
          expect(readToolResultDetails(continuation.result)).toMatchObject({ status: "completed" });
          expect(continuation.isError).toBe(false);
          expect(await fs.readFile(file, "utf8")).toBe("continued");
          expect(prepared.outcomes.filter((outcome) => outcome.toolName === "write")).toEqual(
            writeOutcomes,
          );
          expect(
            prepared.nestedCalls.map(({ toolName, parentToolCallId }) => ({
              toolName,
              parentToolCallId,
            })),
          ).toEqual([
            { toolName: "write", parentToolCallId: "before-refresh" },
            { toolName: "send_current_reply", parentToolCallId: "before-refresh" },
            { toolName: "send_current_reply", parentToolCallId: "after-refresh" },
            { toolName: "edit", parentToolCallId: "ordinary-continuation" },
          ]);
          expect(fixture.network.counts.post).toBe(1);
          await expect(before.execute("retained", { code: "return 1;" })).rejects.toThrow();
        });
      });
    },
  );

  it("keeps pre-handoff admission reserved until the old real Slack route lookup settles", async () => {
    await withCurrentReplyIntegration(
      async (fixture) => {
        await withPreparedTurn(fixture, async (prepared) => {
          const held = fixture.network.hold("route");
          const running = prepared.start([
            {
              id: "held-route",
              code: 'return await send_current_reply({text:"old generation"});',
            },
            {
              id: "before-settlement",
              code: 'return await send_current_reply({text:"still reserved"});',
            },
            {
              id: "authoritative-retry",
              code: 'return await send_current_reply({text:"new generation"});',
            },
          ]);
          await held.wait();
          expect(prepared.turn.completion()).toBeUndefined();
          await prepared.refresh("workspace");
          await running.outcome("held-route");
          running.respond("before-settlement");
          const refused = await running.outcome("before-settlement");
          expect(JSON.stringify(refused.result)).toContain("already been consumed");
          expect(refused.isError).toBe(true);
          expect(fixture.network.counts).toMatchObject({ route: 1, post: 0 });

          // The existing inner tool-outcome observer runs after producer settlement,
          // unlike the outer abort race, which already returned during refresh.
          const settledBefore = prepared.outcomes.filter(
            (outcome) => outcome.toolName === "send_current_reply" && !outcome.presentationOnly,
          ).length;
          held.release.resolve();
          await expect
            .poll(
              () =>
                prepared.outcomes.filter(
                  (outcome) =>
                    outcome.toolName === "send_current_reply" && !outcome.presentationOnly,
                ).length,
            )
            .toBeGreaterThan(settledBefore);
          expect(prepared.turn.completion()).toBeUndefined();
          await prepared.refresh("full");
          running.respond("authoritative-retry");
          await running.done;
          await fixture.waitForSettled();
          const retried = await running.outcome("authoritative-retry");
          expect(retried.result).toMatchObject({ terminate: true });
          expect(retried.isError).toBe(false);
          expect(prepared.turn.completion()).toBe("confirmed");
          expect(fixture.network.counts.post).toBe(1);
        });
      },
      { target: "D12345678" },
    );
  });
});
