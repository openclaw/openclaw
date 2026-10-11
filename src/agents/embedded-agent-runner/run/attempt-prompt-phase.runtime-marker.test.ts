import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import { createFixture, mocks } from "./attempt-prompt-phase.test-support.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  clearEmbeddedSessionPromptStates(["phase-runtime-marker"]);
});

describe("runEmbeddedAttemptPromptPhase runtime-only persistence", () => {
  it("keeps the runtime-only marker out of the transcript through the real prompt phase", async () => {
    const fixture = createFixture({ pendingPrompt: "", pendingImageCount: 0 });
    const markerSessionId = "phase-runtime-marker";
    // Real runtime-only derivation and real submission: the remaining fixture mocks
    // are prompt assembly shape, preflight/observation, and hook/error plumbing.
    const { prepareEmbeddedAttemptPromptContext } = await vi.importActual<
      typeof import("./attempt-prompt-build.js")
    >("./attempt-prompt-build.js");
    const { submitEmbeddedAttemptPrompt } = await vi.importActual<
      typeof import("./attempt-prompt-submit.js")
    >("./attempt-prompt-submit.js");
    mocks.preparePromptContext.mockImplementation(
      async (...args: Parameters<typeof prepareEmbeddedAttemptPromptContext>) =>
        await prepareEmbeddedAttemptPromptContext(...args),
    );
    const assembly = mocks.preparePromptAssembly.getMockImplementation()!;
    mocks.preparePromptAssembly.mockImplementation(async (...args: Parameters<typeof assembly>) => {
      const [assemblyInput] = args;
      return {
        ...(await assembly(...args)),
        effectivePrompt: assemblyInput.attempt.prompt,
        effectiveTranscriptPrompt: assemblyInput.attempt.prompt,
      };
    });
    mocks.submitPrompt.mockImplementation(submitEmbeddedAttemptPrompt);
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
    });
    const guardedManager = guardSessionManager(SessionManager.inMemory(), {
      runId: "run-1",
      agentId: "main",
      trigger: "event",
    });
    const { session } = await createTestSession({ sessionManager: guardedManager });
    const sessionRuntime = fixture.input.prepared.sessionRuntime;
    sessionRuntime.agentSession.activeSession = session;
    sessionRuntime.sessionManager = guardedManager;
    const sessionPromptState = getEmbeddedSessionPromptState(markerSessionId);
    sessionRuntime.sessionPromptState = sessionPromptState;
    sessionRuntime.toolResultPromptProjectionState = sessionPromptState.toolResults;
    sessionRuntime.transcriptPolicy.appendOnlyRuntimeContext = true;
    fixture.input.attempt = {
      ...fixture.input.attempt,
      model: testModel,
      provider: testModel.provider,
      modelId: testModel.id,
      config: {},
      sessionId: markerSessionId,
      prompt: "",
      runtimeContextFragments: [
        { kind: "conversation-data", text: "room event payload: a runtime-only turn" },
      ],
    };
    fixture.input.preparedStreamRuntime.promptActiveSession = (prompt, options) =>
      session.prompt(prompt, options);

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("Continue the OpenClaw runtime event.");
    expect(JSON.stringify(requests[0])).toContain("room event payload: a runtime-only turn");
    const persistedUserTexts = () =>
      guardedManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user"
            ? [JSON.stringify(entry.message.content)]
            : [],
        );
    expect(persistedUserTexts()).toEqual([]);

    // The next user-authored turn through the same real phase persists normally.
    fixture.input.attempt = {
      ...fixture.input.attempt,
      prompt: "actual user text",
      runtimeContextFragments: undefined,
    };
    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(JSON.stringify(requests.at(-1))).toContain("actual user text");
    expect(persistedUserTexts()).toEqual([
      JSON.stringify([{ type: "text", text: "actual user text" }]),
    ]);
  });
});
