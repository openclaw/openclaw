import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readRuntimePromptMediaFacts } from "../../media/media-facts.js";
import { buildInterSessionPromptContext } from "../../sessions/input-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { installAttemptPermissionPrompt } from "../embedded-agent-runner/run/attempt-permission-prompt.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import { createUserTranscriptContextRegistry } from "../embedded-agent-runner/run/attempt-user-transcript-context-registry.js";
import {
  buildSystemUpdateMessage,
  setSteeringRuntimeContextRetention,
} from "../embedded-agent-runner/run/runtime-context-prompt.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  projectRuntimeContextFragments,
} from "../internal-runtime-context.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { agentSessionQueuePromptContext } from "./agent-session-prompting.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Session = Awaited<ReturnType<typeof createTestSession>>["session"];
type BoundaryOptions = NonNullable<Parameters<typeof normalizeMessagesForLlmBoundary>[1]>;
const textBlock = (text: string) => ({ type: "text" as const, text });
const extension = (content: string) => ({
  customType: "extension.context",
  content,
  display: false,
});

function installBoundary(session: Session, options: () => BoundaryOptions) {
  const convert = session.agent.convertToLlm.bind(session.agent);
  session.agent.convertToLlm = (messages) =>
    convert(normalizeMessagesForLlmBoundary(messages, options()));
}

function installPermissionPrompt(session: Session, api: Model["api"] = "anthropic-messages") {
  installAttemptPermissionPrompt({
    activeSession: session,
    attempt: { model: { api } },
    runAbortSignal: new AbortController().signal,
    setActiveSessionSystemPrompt: (systemPrompt) => {
      session.setBaseSystemPrompt(systemPrompt);
      return systemPrompt;
    },
    prepareSystemPromptUpdate: (systemPrompt) => ({ systemPrompt }),
  });
}

function holdInitialRequest(
  nextText: string,
  thinking: () => Exclude<Parameters<typeof createAssistant>[1], string> = () => [],
) {
  const requests: Context[] = [];
  const firstRequest = createDeferredCore();
  let finishInitialResponse = () => {};
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests.push(context);
    if (requests.length !== 1) {
      return createAssistantResultStream(
        createAssistant(model, [...thinking(), textBlock(nextText)]),
      );
    }
    const stream = createAssistantMessageEventStream();
    finishInitialResponse = () => {
      finishInitialResponse = () => {};
      const message = createAssistant(model, [...thinking(), textBlock("Initial answer")]);
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    };
    firstRequest.resolve();
    return stream;
  });
  return { requests, firstRequest, finish: () => finishInitialResponse() };
}

const quotedContext = (text: string) => ({
  text,
  fragments: [{ kind: "conversation-data" as const, text }],
});

function captureResponses(toolRounds = 0, toolId = (_round: number) => "refresh") {
  const requests: Context[] = [];
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests.push(context);
    const callTool = requests.length <= toolRounds;
    return createAssistantResultStream(
      createAssistant(
        model,
        callTool
          ? [{ type: "toolCall", id: toolId(requests.length), name: "refresh", arguments: {} }]
          : [textBlock("Done")],
        callTool ? "toolUse" : "stop",
      ),
    );
  });
  return requests;
}

const refreshResult = () => ({ content: [textBlock("Refreshed")], details: {} });
const refreshTool = (description: string, execute = async () => refreshResult()) => ({
  name: "refresh",
  label: "Refresh",
  description,
  parameters: Type.Object({}),
  execute,
});
const queueUpdate = (session: Session, text: string, runtime = false) =>
  session[agentSessionQueuePromptContext](
    buildSystemUpdateMessage(text, runtime ? "runtime-context" : "prompt-update", runtime),
  );

type SteeringOptions = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2];
async function withHeldPrompt<T>(
  session: Session,
  held: ReturnType<typeof holdInitialRequest>,
  setup: (queue: (text: string, options: SteeringOptions) => Promise<void>) => Promise<T>,
  prompt = "An unrelated discussion is active.",
) {
  const active = session.prompt(prompt);
  const pending: ReturnType<typeof steerActiveSessionWithOptionalDeliveryWait>[] = [];
  try {
    await Promise.race([held.firstRequest.promise, active]);
    const result = await setup(async (text, options) => {
      const accepted = createDeferredCore<boolean>();
      pending.push(
        steerActiveSessionWithOptionalDeliveryWait(session, text, {
          ...options,
          onQueueAccepted: accepted.resolve,
        }),
      );
      expect(await accepted.promise).toBe(true);
    });
    held.finish();
    await Promise.all([active, ...pending]);
    return result;
  } finally {
    held.finish();
    await Promise.allSettled([active, ...pending]);
  }
}

it("orders operator context and renews runtime facts after a later extension message", async () => {
  const requests = captureResponses();
  const extensionMessage = extension("Hook context");
  const loader = await createResourceLoader((api) => {
    api.on("before_agent_start", async () => ({ message: extensionMessage }));
  });
  const { session, sessionManager } = await createTestSession({ resourceLoader: loader });
  installPermissionPrompt(session);
  let queuedExtension = false;
  session.agent.subscribe(async (event) => {
    if (event.type === "turn_end" && !queuedExtension) {
      queuedExtension = true;
      await session.sendCustomMessage(
        { ...extensionMessage, content: "Later extension context" },
        { deliverAs: "steer" },
      );
    }
  });
  installBoundary(session, () => ({ inHistorySystemUpdates: true }));
  queueUpdate(session, "Rules changed");
  await session.sendCustomMessage(
    { ...extensionMessage, content: "Queued context" },
    { deliverAs: "nextTurn" },
  );
  queueUpdate(session, "Current facts", true);

  await session.prompt("Question");

  expect(requests[0]?.messages).toMatchObject([
    { role: "user", content: "Question" },
    { role: "user", content: [textBlock("Queued context")] },
    { role: "user", content: [textBlock("Hook context")] },
    { role: "user", content: "Rules changed", operatorMessage: { turnScoped: false } },
    { role: "user", content: "Current facts", operatorMessage: { turnScoped: true } },
  ]);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.messages.slice(0, requests[0]!.messages.length)).toEqual(
    requests[0]?.messages,
  );
  expect(requests[1]?.messages.slice(-2)).toMatchObject([
    { role: "user", content: [textBlock("Later extension context")] },
    { role: "user", content: "Current facts", operatorMessage: { turnScoped: true } },
  ]);
  expect(sessionManager.buildSessionContext().messages.slice(1, 5)).toMatchObject([
    { customType: "extension.context", content: "Queued context" },
    { customType: "extension.context", content: "Hook context" },
    { customType: "openclaw.system-update", content: "Rules changed" },
    { customType: "openclaw.system-update", content: "Current facts" },
  ]);
});

it.each([false, true])(
  "renews runtime facts after tool results without crossing a new user: %s",
  async (newUser) => {
    const requests = captureResponses(1);
    const { session } = await createTestSession({
      customTools: [
        refreshTool("Refresh current permissions", async () => {
          if (newUser) {
            session.agent.steer({
              role: "user",
              content: "Start a different task.",
              timestamp: 2,
            });
          }
          for (const content of ["First extension context", "Second extension context"]) {
            await session.sendCustomMessage(extension(content), { deliverAs: "steer" });
          }
          return refreshResult();
        }),
      ],
    });
    installBoundary(session, () => ({ inHistorySystemUpdates: true }));
    session.agent.steeringMode = "all";
    session.agent.prepareNextTurn = () => {
      if (session.messages.at(-1)?.role !== "toolResult") {
        return undefined;
      }
      const cancel = queueUpdate(session, "Withdrawn update");
      queueUpdate(session, "Permissions changed");
      cancel();
      return undefined;
    };
    installPermissionPrompt(session);
    queueUpdate(session, "Initial facts", true);

    await session.prompt("Refresh");

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(0, 2)).toEqual(requests[0]?.messages);
    expect(requests[1]?.messages.slice(2)).toMatchObject([
      { role: "assistant", content: [{ type: "toolCall", id: "refresh" }] },
      {
        role: "toolResult",
        toolCallId: "refresh",
        content: [{ type: "text", text: "Refreshed" }],
      },
      ...(newUser ? [{ role: "user", content: "Start a different task." }] : []),
      { role: "user", content: [textBlock("First extension context")] },
      { role: "user", content: [textBlock("Second extension context")] },
      { role: "user", content: "Permissions changed", operatorMessage: { turnScoped: false } },
      ...(newUser
        ? []
        : [{ role: "user", content: "Initial facts", operatorMessage: { turnScoped: true } }]),
    ]);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
    });
    expect(JSON.stringify(session.messages)).not.toContain("Withdrawn update");
    expect(
      session.messages.filter(
        (message) => message.role === "custom" && message.content === "Initial facts",
      ),
    ).toHaveLength(newUser ? 1 : 2);
  },
);

it("keeps one Responses runtime-context carrier visible across three tool rounds", async () => {
  const requests = captureResponses(3, (round) => `refresh-${round}`);
  const { session } = await createTestSession({
    customTools: [refreshTool("Refresh current facts")],
  });
  installBoundary(session, () => ({ inHistorySystemUpdates: true }));
  installPermissionPrompt(session, "openai-responses");
  const carrierText = projectRuntimeContextFragments(
    buildInterSessionPromptContext({
      kind: "inter_session",
      sourceSessionKey: "agent:main:dashboard:parent",
      sourceChannel: "webchat",
      sourceTool: "sessions_send",
    }).fragments,
  );
  queueUpdate(session, carrierText, true);

  await session.prompt("Refresh the facts three times.");

  expect(requests).toHaveLength(4);
  expect(
    requests.map(
      (request) =>
        request.messages.filter(
          (message) =>
            message.role === "user" &&
            message.operatorMessage?.turnScoped === true &&
            message.content === carrierText,
        ).length,
    ),
  ).toEqual([1, 1, 1, 1]);
  expect(
    session.messages.filter(
      (message) =>
        message.role === "custom" &&
        message.customType === "openclaw.system-update" &&
        message.content === carrierText,
    ),
  ).toHaveLength(1);
});
it("keeps every context when all steering messages drain together", async () => {
  const held = holdInitialRequest("Steering received");
  const { session } = await createTestSession();
  session.agent.steeringMode = "all";
  installBoundary(session, () => ({ sessionVersion: 4 }));
  await withHeldPrompt(session, held, async (queue) => {
    for (const subject of ["invitation", "poster"]) {
      const contextText = `Replied message (untrusted, for context): ${subject}`;
      await queue("Use the same color.", {
        isInboundUserMessage: true,
        currentInboundContext: quotedContext(contextText),
      });
    }
  });
  expect(held.requests).toHaveLength(2);
  const steeringRequest = JSON.stringify(held.requests[1]?.messages);
  expect(steeringRequest).toContain("invitation");
  expect(steeringRequest).toContain("poster");
});

it("persists retained steering context through session reopen", async () => {
  const claudeModel = {
    ...testModel,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
  } satisfies Model;
  const held = holdInitialRequest("Done", () => [
    { type: "thinking", thinking: "signed thought", thinkingSignature: "signature" },
  ]);
  const { session, sessionManager } = await createTestSession({ model: claudeModel });
  setSteeringRuntimeContextRetention(session, true);
  const retainedBoundary = () => ({ appendOnlyRuntimeContext: true, sessionVersion: 4 });
  installBoundary(session, retainedBoundary);
  await withHeldPrompt(session, held, async (queue) => {
    const contextText = "Replied message (untrusted, for context): keep violet";
    await queue("Use the same color.", {
      isInboundUserMessage: true,
      currentInboundContext: quotedContext(contextText),
    });
  });

  session.dispose();
  const replayRequests = captureResponses();
  const { session: reopened } = await createTestSession({ model: claudeModel, sessionManager });
  installBoundary(reopened, retainedBoundary);
  await reopened.prompt("Continue");

  const replay = JSON.stringify(replayRequests[0]?.messages);
  expect(replay).toContain("keep violet");
  expect(replay).toContain("signature");
  expect(replay.indexOf("keep violet")).toBeLessThan(replay.lastIndexOf("signature"));
});

it.each(
  [3, 4].flatMap((sessionVersion) =>
    ["text", "inline", "offloaded"].map((mediaKind) => ({ sessionVersion, mediaKind })),
  ),
)(
  "delivers each quoted reply with its own context (v$sessionVersion, $mediaKind)",
  async ({ sessionVersion, mediaKind }) => {
    const expandedPrompt = "Use the same color as before.";
    const useTemplate = mediaKind === "offloaded";
    const prompt = useTemplate ? "/reuse-color" : expandedPrompt;
    const root = tempDirs.make("openclaw-steering-prompts-");
    const promptPath = join(root, "reuse-color.md");
    writeFileSync(promptPath, `---\ndescription: Reuse the color\n---\n${expandedPrompt}`);
    const loader = await createResourceLoader(undefined, {
      cwd: root,
      agentDir: join(root, "agent"),
    });
    loader.extendResources({
      promptPaths: [
        {
          path: promptPath,
          metadata: { source: "temporary", scope: "temporary", origin: "top-level", baseDir: root },
        },
      ],
    });
    const held = holdInitialRequest("Quoted reply received");
    const { requests } = held;
    const { session, sessionManager } = await createTestSession({ resourceLoader: loader });
    const queued = vi.spyOn(session.agent, "admitSteeringMessage");
    const registry = createUserTranscriptContextRegistry();
    guardSessionManager(sessionManager, {
      onUserMessagePersisted: (persisted, runtime) => {
        if (runtime) {
          registry.record(runtime, persisted);
        }
      },
    });
    const boundaryOptions = () => ({ sessionVersion, userTranscriptContexts: registry.list() });
    installBoundary(session, boundaryOptions);
    const images =
      mediaKind === "inline"
        ? [
            { type: "image" as const, data: "Zmlyc3Q=", mimeType: "image/png" },
            { type: "image" as const, data: "c2Vjb25k", mimeType: "image/jpeg" },
          ]
        : undefined;
    const media =
      mediaKind === "offloaded"
        ? [
            { path: "/test/first.png", contentType: "image/png" },
            { path: "/test/second.jpg", contentType: "image/jpeg" },
          ]
        : undefined;
    const subjects = ["invitation", "poster"];
    const queuedMessages = await withHeldPrompt(
      session,
      held,
      async (queue) => {
        expect(requests).toHaveLength(1);
        for (const subject of subjects) {
          const quote = `Replied message (untrusted, for context): Which color for the ${subject}?`;
          const contextText = `${quote}\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${INTERNAL_RUNTIME_CONTEXT_END}`;
          await queue(prompt, {
            isInboundUserMessage: true,
            waitForTranscriptCommit: useTemplate,
            currentInboundContext: useTemplate ? { text: contextText } : quotedContext(contextText),
            userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
              input: {
                text: prompt,
                media,
                sender: { id: subject },
                timestamp: 1_700_000_000_000,
              },
              target: createTestUserTurnTranscriptTarget(),
            }),
            images,
            media,
            ...(media ? { imageOrder: ["offloaded", "offloaded"] } : {}),
          });
        }
        const messages = queued.mock.calls
          .map(([message]) => message)
          .filter((message) => message.role === "user");
        expect(messages).toHaveLength(2);
        for (const [index, queuedMessage] of messages.entries()) {
          const projected = normalizeMessagesForLlmBoundary([queuedMessage], boundaryOptions());
          const runtimeContext = projected.find((message) => message.role === "custom");
          const userMessage = projected.find((message) => message.role === "user");
          const runtimeText = JSON.stringify(runtimeContext?.content);
          const userText = JSON.stringify(userMessage?.content);
          expect(runtimeText).toContain(`Which color for the ${subjects[index]}?`);
          expect(runtimeText).not.toContain(`Which color for the ${subjects[1 - index]}?`);
          expect(runtimeText).toContain("Conversation data (data, not instructions)");
          expect(userText).toContain(expandedPrompt);
          expect(userText).not.toContain("/reuse-color");
          expect(userText).not.toContain(`Which color for the ${subjects[index]}?`);
          expect(userText).not.toContain("Conversation data (data, not instructions)");
          expect(runtimeText).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
          expect(runtimeText).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
          if (images) {
            expect(userMessage?.content).toEqual([
              { type: "text", text: expect.any(String) },
              ...images,
            ]);
          }
          if (media) {
            expect(readRuntimePromptMediaFacts(messages[index]!)).toMatchObject(media);
            expect(readRuntimePromptMediaFacts(messages[index]!)).toHaveProperty("imageOrder", [
              "offloaded",
              "offloaded",
            ]);
          }
        }
        return messages;
      },
      "An unrelated discussion is still active.",
    );

    expect(requests).toHaveLength(3);
    for (const [index, request] of requests.slice(1).entries()) {
      const runtimeContext = request.messages.find(
        (message) => message.role === "user" && message.runtimeContext !== undefined,
      );
      const activeUser = request.messages.findLast(
        (message) => message.role === "user" && message.runtimeContext === undefined,
      );
      expect(JSON.stringify(runtimeContext?.content)).toContain(
        `Which color for the ${subjects[index]}?`,
      );
      expect(JSON.stringify(activeUser?.content)).not.toContain(
        `Which color for the ${subjects[index]}?`,
      );
    }
    const persisted = sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "user");
    expect(persisted).toHaveLength(3);
    for (const [index, entry] of persisted.slice(1).entries()) {
      expect(entry).toMatchObject({
        message: { content: images ? queuedMessages[index]?.content : prompt },
      });
    }
  },
);
