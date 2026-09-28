import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  readRuntimePromptImageOrder,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import { createUserTranscriptContextRegistry } from "../embedded-agent-runner/run/attempt-user-transcript-context-registry.js";
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
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createSyntheticSourceInfo } from "./source-info.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession quoted steering context", () => {
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
        const project = () =>
          normalizeMessagesForLlmBoundary(messages, boundaryOptions()).filter(
            (message) => message.role === "user",
          );
        const beforePersistence = project();
        expect(messages).toHaveLength(2);
        for (const [index, message] of beforePersistence.entries()) {
          const text = JSON.stringify(message.content);
          expect(text).toContain(`Which color for the ${subjects[index]}?`);
          expect(text).not.toContain(`Which color for the ${subjects[1 - index]}?`);
          expect(text).toContain("Conversation data (data, not instructions)");
          expect(text).toContain(expandedPrompt);
          expect(text).not.toContain("/reuse-color");
          expect(text).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
          expect(text).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
          if (images) {
            expect(message.content).toEqual([
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

        expect(project()).toEqual(beforePersistence);
        const delivered = requests.at(-1)?.messages.filter((message) => message.role === "user");
        expect(delivered?.slice(1)).toEqual(beforePersistence);
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
