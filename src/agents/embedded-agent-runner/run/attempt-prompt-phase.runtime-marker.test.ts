import { afterEach, expect, it, vi } from "vitest";
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
  retainEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import { createFixture, mocks } from "./attempt-prompt-phase.test-support.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  clearEmbeddedSessionPromptStates(["phase-runtime-marker"]);
});

it("retains runtime-only input without attributing it to a human through the real prompt phase", async () => {
  const { input, promptState } = createFixture({ pendingPrompt: "", pendingImageCount: 0 });
  const markerSessionId = "phase-runtime-marker";
  const { prepareEmbeddedAttemptPromptContext } = await vi.importActual<
    typeof import("./attempt-prompt-build.js")
  >("./attempt-prompt-build.js");
  const { submitEmbeddedAttemptPrompt } = await vi.importActual<
    typeof import("./attempt-prompt-submit.js")
  >("./attempt-prompt-submit.js");
  mocks.preparePromptContext.mockImplementation(prepareEmbeddedAttemptPromptContext);
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
  const requests: string[] = [];
  streamMocks.streamSimple.mockImplementation((model, context) => {
    requests.push(JSON.stringify(context.messages));
    return createAssistantResultStream(createAssistant(model, "done"));
  });
  const guardedManager = guardSessionManager(SessionManager.inMemory(), {
    runId: "run-1",
    agentId: "main",
    trigger: "event",
  });
  const { session } = await createTestSession({ sessionManager: guardedManager });
  const sessionRuntime = input.prepared.sessionRuntime;
  sessionRuntime.agentSession.activeSession = session;
  sessionRuntime.sessionManager = guardedManager;
  using promptStateLease = retainEmbeddedSessionPromptState(markerSessionId);
  sessionRuntime.sessionPromptState = promptStateLease.state;
  sessionRuntime.toolResultPromptProjectionState = promptStateLease.state.toolResults;
  input.attempt = {
    ...input.attempt,
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
  input.preparedStreamRuntime.promptActiveSession = (prompt, options) =>
    session.prompt(prompt, options);

  await runEmbeddedAttemptPromptPhase(input, promptState);

  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("Continue the OpenClaw runtime event.");
  expect(requests[0]).toContain("room event payload: a runtime-only turn");
  const persistedUsers = () =>
    guardedManager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
      );
  expect(persistedUsers()).toMatchObject([
    {
      content: [{ type: "text", text: "Continue the OpenClaw runtime event." }],
      display: false,
      provenance: { kind: "internal_system" },
    },
  ]);

  input.attempt = {
    ...input.attempt,
    prompt: "actual user text",
    runtimeContextFragments: undefined,
  };
  await runEmbeddedAttemptPromptPhase(input, promptState);

  expect(requests.at(-1)).toContain("actual user text");
  const users = persistedUsers();
  expect(users).toHaveLength(2);
  expect(users.at(-1)).toMatchObject({
    content: [{ type: "text", text: "actual user text" }],
  });
  expect(users.at(-1)).not.toHaveProperty("display", false);
  expect(users.at(-1)).not.toHaveProperty("provenance");
});
