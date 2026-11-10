import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import type { Context } from "../../../llm/types.js";
import { normalizeInputProvenance } from "../../../sessions/input-provenance.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import {
  createBaseInput,
  sessionId as promptFixtureId,
} from "./attempt-prompt-submit.test-support.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearEmbeddedSessionPromptStates([promptFixtureId]);
  vi.restoreAllMocks();
});

it("continues the persisted task across Flex capacity and timeout retries without repeating its tool", async () => {
  vi.mocked(sleepWithAbort).mockClear();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  await withOpenClawTestState({ label: "flex-transcript-recovery" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "flex-transcript-recovery",
      sessionKey: "agent:main:flex-transcript-recovery",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = guardSessionManager(await SessionManager.openAsync(target, state.workspaceDir));
    const effects: string[] = [];
    const { session } = await createTestSession({
      sessionManager: manager,
      customTools: [
        {
          name: "record_effect",
          label: "Record effect",
          description: "Record one synthetic side effect",
          parameters: Type.Object({}),
          execute: async () => {
            effects.push("recorded");
            return { content: [{ type: "text", text: "effect recorded" }], details: {} };
          },
        },
      ],
    });
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      if (requests.length === 1) {
        return createAssistantResultStream(
          createAssistant(
            model,
            [{ type: "toolCall", id: "effect-1", name: "record_effect", arguments: {} }],
            "toolUse",
          ),
        );
      }
      if (requests.length <= 3) {
        return createAssistantResultStream({
          ...createAssistant(model, [], "error"),
          errorMessage: requests.length === 2 ? "429 Resource unavailable" : "Request timed out.",
          errorCode: requests.length === 2 ? "resource_unavailable" : "ETIMEDOUT",
        });
      }
      return createAssistantResultStream(createAssistant(model, "The effect was recorded."));
    });
    const task = "Record the effect once, then report its result.";
    await using promptState = await createEmbeddedRunSessionPromptState({
      runParams: {
        sessionId: target.sessionId,
        sessionFile: target.sessionKey,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionManager: manager,
        sessionPersistence: "detached",
        workspaceDir: state.workspaceDir,
        prompt: task,
        timeoutMs: 30 * 60_000,
        runId: "flex-transcript-recovery",
      },
      sessionAgentId: "main",
      resolvedSessionKey: target.sessionKey,
      lifecycleGeneration: "flex-transcript-recovery",
      onInterrupt: () => {},
    });
    const submit = () => {
      const base = createBaseInput();
      const prompt = promptState.activePrompt.override ?? task;
      return submitEmbeddedAttemptPrompt({
        ...base,
        attempt: {
          sessionId: target.sessionId,
          suppressNextUserMessagePersistence: promptState.suppressNextUserMessagePersistence,
        },
        activeSession: session,
        appendContext: undefined,
        prependContext: undefined,
        transcriptPrompt: prompt,
        modelPrompt: prompt,
        setNextUserMessagePersistence: manager.setNextUserMessagePersistence,
        promptActiveSession: (text, options) =>
          session.prompt(text, { ...options, expandPromptTemplates: false }),
      });
    };
    await submit();
    expect(effects).toEqual(["recorded"]);
    let retryController:
      | Awaited<ReturnType<typeof recoverAfterTransportDrop>>["failoverRetryController"]
      | undefined;
    for (let retry = 0; retry < 2; retry++) {
      const assistant = session.messages.findLast((message) => message.role === "assistant");
      expect(assistant?.stopReason).toBe("error");
      const attempt = makeEmbeddedRunnerAttempt({
        sessionIdUsed: target.sessionId,
        messagesSnapshot: [...session.messages],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        providerFlexProcessing: true,
        toolMetas:
          retry === 0
            ? [{ toolCallId: "effect-1", toolName: "record_effect", replaySafe: false }]
            : [],
        itemLifecycle: {
          startedCount: retry === 0 ? 1 : 0,
          completedCount: retry === 0 ? 1 : 0,
          activeCount: 0,
        },
      });
      const result = await recoverAfterTransportDrop({
        attempt,
        sessionPromptState: promptState,
        failoverRetryController: retryController,
      });
      retryController = result.failoverRetryController;
      expect(result.recovery.action).toBe("retry");
      await submit();
    }
    expect(vi.mocked(sleepWithAbort).mock.calls.map(([delay]) => delay)).toEqual([60_000, 120_000]);
    expect(requests).toHaveLength(4);
    for (const request of requests.slice(1)) {
      expect(request.filter((message) => message.role === "toolResult")).toHaveLength(1);
      expect(JSON.stringify(request)).toContain("effect recorded");
      expect(JSON.stringify(request).split(task)).toHaveLength(2);
    }
    expect(effects).toEqual(["recorded"]);
    session.dispose();
    const reopened = await SessionManager.openAsync(target, state.workspaceDir);
    const messages = reopened
      .getEntries()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    const humans = messages.filter(
      (message) =>
        message.role === "user" &&
        !(
          "provenance" in message &&
          normalizeInputProvenance(message.provenance)?.kind === "internal_system"
        ),
    );
    expect(humans).toMatchObject([{ content: [{ type: "text", text: task }] }]);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The effect was recorded." }],
    });
  });
});
