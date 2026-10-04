import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  readRuntimePromptImageOrder,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";
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
import { createSyntheticSourceInfo } from "./source-info.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession operator context ordering", () => {
  it("orders operator context and renews runtime facts after a later extension message", async () => {
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done" }]));
    });
    const extensionMessage = {
      customType: "extension.context",
      content: "Hook context",
      display: false,
    };
    const loader = createResourceLoader(
      new Map([["before_agent_start", [async () => ({ message: extensionMessage })]]]),
    );
    const { session, sessionManager } = await createTestSession({ resourceLoader: loader });
    installAttemptPermissionPrompt({
      activeSession: session,
      attempt: {},
      runAbortSignal: new AbortController().signal,
      setActiveSessionSystemPrompt: (systemPrompt) => {
        session.setBaseSystemPrompt(systemPrompt);
        return systemPrompt;
      },
      prepareSystemPromptUpdate: (systemPrompt) => ({ systemPrompt }),
    });
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
    const convertToLlm = session.agent.convertToLlm.bind(session.agent);
    session.agent.convertToLlm = (messages) =>
      convertToLlm(normalizeMessagesForLlmBoundary(messages, { inHistorySystemUpdates: true }));
    session[agentSessionQueuePromptContext](
      buildSystemUpdateMessage("Rules changed", "prompt-update", false),
    );
    await session.sendCustomMessage(
      { ...extensionMessage, content: "Queued context" },
      { deliverAs: "nextTurn" },
    );
    session[agentSessionQueuePromptContext](
      buildSystemUpdateMessage("Current facts", "runtime-context", true),
    );

    await session.prompt("Question");

    expect(requests[0]?.messages).toMatchObject([
      { role: "user", content: "Question" },
      { role: "user", content: [{ type: "text", text: "Queued context" }] },
      { role: "user", content: [{ type: "text", text: "Hook context" }] },
      { role: "user", content: "Rules changed", operatorMessage: { turnScoped: false } },
      { role: "user", content: "Current facts", operatorMessage: { turnScoped: true } },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(0, requests[0]!.messages.length)).toEqual(
      requests[0]?.messages,
    );
    expect(requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "user", content: [{ type: "text", text: "Later extension context" }] },
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
      const requests: Context[] = [];
      streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
        requests.push(context);
        return createAssistantResultStream(
          createAssistant(
            model,
            requests.length === 1
              ? [{ type: "toolCall", id: "refresh", name: "refresh", arguments: {} }]
              : [{ type: "text", text: "Done" }],
            requests.length === 1 ? "toolUse" : "stop",
          ),
        );
      });
      const { session } = await createTestSession({
        customTools: [
          {
            name: "refresh",
            label: "Refresh",
            description: "Refresh current permissions",
            parameters: Type.Object({}),
            execute: async () => {
              if (newUser) {
                session.agent.steer({
                  role: "user",
                  content: "Start a different task.",
                  timestamp: 2,
                });
              }
              for (const content of ["First extension context", "Second extension context"]) {
                await session.sendCustomMessage(
                  { customType: "extension.context", content, display: false },
                  { deliverAs: "steer" },
                );
              }
              return { content: [{ type: "text", text: "Refreshed" }], details: {} };
            },
          },
        ],
      });
      const convertToLlm = session.agent.convertToLlm.bind(session.agent);
      session.agent.convertToLlm = (messages) =>
        convertToLlm(normalizeMessagesForLlmBoundary(messages, { inHistorySystemUpdates: true }));
      session.agent.steeringMode = "all";
      session.agent.prepareNextTurn = () => {
        if (session.messages.at(-1)?.role !== "toolResult") {
          return undefined;
        }
        const cancel = session[agentSessionQueuePromptContext](
          buildSystemUpdateMessage("Withdrawn update", "prompt-update", false),
        );
        session[agentSessionQueuePromptContext](
          buildSystemUpdateMessage("Permissions changed", "prompt-update", false),
        );
        cancel();
        return undefined;
      };
      installAttemptPermissionPrompt({
        activeSession: session,
        attempt: {},
        runAbortSignal: new AbortController().signal,
        setActiveSessionSystemPrompt: (systemPrompt) => {
          session.setBaseSystemPrompt(systemPrompt);
          return systemPrompt;
        },
        prepareSystemPromptUpdate: (systemPrompt) => ({ systemPrompt }),
      });
      session[agentSessionQueuePromptContext](
        buildSystemUpdateMessage("Initial facts", "runtime-context", true),
      );

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
        { role: "user", content: [{ type: "text", text: "First extension context" }] },
        { role: "user", content: [{ type: "text", text: "Second extension context" }] },
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
});

describe("AgentSession quoted steering context", () => {
  it("keeps every context when all steering messages drain together", async () => {
    const requests: Context[] = [];
    const firstRequest = createDeferredCore();
    let finishInitialResponse = () => {};
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      requests.push(context);
      if (requests.length === 1) {
        const stream = createAssistantMessageEventStream();
        finishInitialResponse = () => {
          const message = createAssistant(model, [{ type: "text", text: "Initial answer" }]);
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        };
        firstRequest.resolve();
        return stream;
      }
      return createAssistantResultStream(
        createAssistant(model, [{ type: "text", text: "Steering received" }]),
      );
    });
    const { session } = await createTestSession();
    session.agent.steeringMode = "all";
    const convertToLlm = session.agent.convertToLlm.bind(session.agent);
    session.agent.convertToLlm = (messages) =>
      convertToLlm(normalizeMessagesForLlmBoundary(messages, { sessionVersion: 4 }));
    const initialPrompt = session.prompt("An unrelated discussion is active.");
    const deliveries: Array<ReturnType<typeof steerActiveSessionWithOptionalDeliveryWait>> = [];

    try {
      await Promise.race([firstRequest.promise, initialPrompt]);
      for (const subject of ["invitation", "poster"]) {
        const accepted = createDeferredCore<boolean>();
        const contextText = `Replied message (untrusted, for context): ${subject}`;
        deliveries.push(
          steerActiveSessionWithOptionalDeliveryWait(session, "Use the same color.", {
            isInboundUserMessage: true,
            onQueueAccepted: accepted.resolve,
            currentInboundContext: {
              text: contextText,
              fragments: [{ kind: "conversation-data", text: contextText }],
            },
          }),
        );
        expect(await accepted.promise).toBe(true);
      }
      finishInitialResponse();
      await Promise.all([initialPrompt, ...deliveries]);

      expect(requests).toHaveLength(2);
      const steeringRequest = JSON.stringify(requests[1]?.messages);
      expect(steeringRequest).toContain("invitation");
      expect(steeringRequest).toContain("poster");
    } finally {
      finishInitialResponse();
      await Promise.allSettled([initialPrompt, ...deliveries]);
    }
  });

  it("persists retained steering context through session reopen", async () => {
    const claudeModel = {
      ...testModel,
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      api: "anthropic-messages",
      provider: "anthropic",
    } satisfies Model;
    const requests: Context[] = [];
    const firstRequest = createDeferredCore();
    let finishInitialResponse = () => {};
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      requests.push(context);
      if (requests.length === 1) {
        const stream = createAssistantMessageEventStream();
        finishInitialResponse = () => {
          const message = createAssistant(model, [
            { type: "thinking", thinking: "signed thought", thinkingSignature: "signature" },
            { type: "text", text: "Initial answer" },
          ]);
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        };
        firstRequest.resolve();
        return stream;
      }
      return createAssistantResultStream(
        createAssistant(model, [
          { type: "thinking", thinking: "signed thought", thinkingSignature: "signature" },
          { type: "text", text: "Done" },
        ]),
      );
    });
    const { session, sessionManager } = await createTestSession({ model: claudeModel });
    setSteeringRuntimeContextRetention(session, true);
    const installBoundary = (target: typeof session) => {
      const convertToLlm = target.agent.convertToLlm.bind(target.agent);
      target.agent.convertToLlm = (messages) =>
        convertToLlm(
          normalizeMessagesForLlmBoundary(messages, {
            appendOnlyRuntimeContext: true,
            sessionVersion: 4,
          }),
        );
    };
    installBoundary(session);
    const initialPrompt = session.prompt("An unrelated discussion is active.");
    let delivery: ReturnType<typeof steerActiveSessionWithOptionalDeliveryWait> | undefined;

    try {
      await Promise.race([firstRequest.promise, initialPrompt]);
      const accepted = createDeferredCore<boolean>();
      const contextText = "Replied message (untrusted, for context): keep violet";
      delivery = steerActiveSessionWithOptionalDeliveryWait(session, "Use the same color.", {
        isInboundUserMessage: true,
        onQueueAccepted: accepted.resolve,
        currentInboundContext: {
          text: contextText,
          fragments: [{ kind: "conversation-data", text: contextText }],
        },
      });
      expect(await accepted.promise).toBe(true);
      finishInitialResponse();
      await Promise.all([initialPrompt, delivery]);
    } finally {
      finishInitialResponse();
      await Promise.allSettled([initialPrompt, delivery]);
    }

    session.dispose();
    const replayRequests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      replayRequests.push(context);
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done" }]));
    });
    const { session: reopened } = await createTestSession({ model: claudeModel, sessionManager });
    installBoundary(reopened);
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
      const loader = createResourceLoader();
      loader.getPrompts = () => ({
        prompts: [
          {
            name: "reuse-color",
            description: "Reuse the color",
            content: expandedPrompt,
            sourceInfo: createSyntheticSourceInfo("<test-prompt>", { source: "temporary" }),
            filePath: "/test/prompts/reuse-color.md",
          },
        ],
        diagnostics: [],
      });
      const requests: Context[] = [];
      const firstRequest = createDeferredCore();
      let finishInitialResponse = () => {};
      streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
        requests.push(context);
        if (requests.length === 1) {
          const stream = createAssistantMessageEventStream();
          finishInitialResponse = () => {
            finishInitialResponse = () => {};
            const message = createAssistant(model, [{ type: "text", text: "Initial answer" }]);
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
          };
          firstRequest.resolve();
          return stream;
        }
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "Quoted reply received" }]),
        );
      });
      const { session, sessionManager } = await createTestSession({ resourceLoader: loader });
      const queued = vi.spyOn(session.agent, "steer");
      const registry = createUserTranscriptContextRegistry();
      guardSessionManager(sessionManager, {
        onUserMessagePersisted: (persisted, runtime) => {
          if (runtime) {
            registry.record(runtime, persisted);
          }
        },
      });
      const boundaryOptions = () => ({ sessionVersion, userTranscriptContexts: registry.list() });
      const convertToLlm = session.agent.convertToLlm.bind(session.agent);
      session.agent.convertToLlm = (messages) =>
        convertToLlm(normalizeMessagesForLlmBoundary(messages, boundaryOptions()));
      const initialPrompt = session.prompt("An unrelated discussion is still active.");
      const deliveries: Array<ReturnType<typeof steerActiveSessionWithOptionalDeliveryWait>> = [];
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
      try {
        await Promise.race([firstRequest.promise, initialPrompt]);
        expect(requests).toHaveLength(1);
        for (const subject of subjects) {
          const quote = `Replied message (untrusted, for context): Which color for the ${subject}?`;
          const contextText = `${quote}\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${INTERNAL_RUNTIME_CONTEXT_END}`;
          const accepted = createDeferredCore<boolean>();
          deliveries.push(
            steerActiveSessionWithOptionalDeliveryWait(session, prompt, {
              isInboundUserMessage: true,
              waitForTranscriptCommit: useTemplate,
              onQueueAccepted: accepted.resolve,
              currentInboundContext: {
                text: contextText,
                ...(useTemplate
                  ? {}
                  : { fragments: [{ kind: "conversation-data", text: contextText }] }),
              },
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
            }),
          );
          expect(await accepted.promise).toBe(true);
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
            expect(readRuntimePromptImageOrder(messages[index]!)).toEqual([
              "offloaded",
              "offloaded",
            ]);
          }
        }
        finishInitialResponse();
        await Promise.all([initialPrompt, ...deliveries]);

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
            message: { content: images ? messages[index]?.content : prompt },
          });
        }
      } finally {
        finishInitialResponse();
        await Promise.allSettled([initialPrompt, ...deliveries]);
      }
    },
  );
});
