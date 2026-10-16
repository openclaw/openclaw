import path from "node:path";
import { streamOpenAICompletions, streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import { createOpenAIResponsesTransportStreamFn as responsesTransport } from "../../../../packages/ai/src/transports/openai-responses-client.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { loadTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import type { UserMessage } from "../../../llm/types.js";
import {
  buildLateMediaAttachedProjection,
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  type UserTurnInput,
} from "../../../sessions/user-turn-transcript.js";
import { persistUserTurnTranscript } from "../../../sessions/user-turn-transcript.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
  createCodeModeTools,
} from "../../code-mode.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  relocateCurrentRuntimeContextCarrierToTail as relocate,
} from "../../internal-runtime-context.js";
import { Agent, type AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { convertToLlm } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { textToolResult } from "../../test-helpers/sparse-transcript.test-support.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "../../tool-search-catalog.js";
import type { TranscriptPolicy } from "../../transcript-policy.types.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import {
  clearEmbeddedSessionPromptStates,
  persistSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
  prepareSessionSystemPrompt,
} from "../session-prompt-state.js";
import {
  installRuntimeContextMessageForPrompt as installContext,
  installModelPromptProjection,
  normalizeMessagesForLlmBoundary as normalize,
} from "./attempt-llm-boundary.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import {
  attachSteeringRuntimeContext,
  buildRuntimeContextCustomMessage as runtimeCarrier,
  buildSystemUpdateMessage,
} from "./runtime-context-prompt.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-99495-boundary-");
const TS = 1717570800000;
const options = { timezone: "UTC" };
const textBlock = (text: string) => ({ type: "text" as const, text });
const user = (text: string, timestamp = TS): UserMessage => ({
  role: "user",
  content: [textBlock(text)],
  timestamp,
});
const answer = makeAgentAssistantMessage({
  content: [textBlock("I understand.")],
  timestamp: TS + 1,
});
const model = makeProviderModelFixture<"openai-completions">({
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 128_000,
});

type TransportApi = "anthropic-messages" | "openai-responses";
type RequestContext = Parameters<ReturnType<typeof responsesTransport>>[1];
type BoundaryOptions = NonNullable<Parameters<typeof normalize>[1]>;
const llmHistory = (messages: AgentMessage[], opts: BoundaryOptions) =>
  convertToLlm(normalize(messages, opts));
const providerAnswer = (api: TransportApi | "openai-completions") => ({
  ...answer,
  api,
  provider: api === "anthropic-messages" ? "anthropic" : "openai",
  model: api === "anthropic-messages" ? "claude-opus-5" : model.id,
});
const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
const toolResult = (id: string, text: string, timestamp: number): AgentMessage => ({
  ...textToolResult(id, "read", text),
  isError: false,
  timestamp,
});
async function capturePayload(
  start: (
    onPayload: (payload: unknown) => void,
  ) => ReturnType<ReturnType<typeof responsesTransport>>,
) {
  let captured: Record<string, unknown> | undefined;
  const stream = await start((payload) => {
    captured = payload as Record<string, unknown>;
    throw new Error("stop after payload capture");
  });
  expect((await stream.result()).stopReason).toBe("error");
  return expectDefined(captured, "captured provider payload");
}
async function captureTransport(api: TransportApi, context: RequestContext) {
  if (api === "anthropic-messages") {
    return (
      await captureAnthropicRequest("transport", {
        model: { id: "claude-opus-5" },
        cacheRetention: "none",
        context,
      })
    ).payload;
  }
  return capturePayload((onPayload) =>
    responsesTransport()({ ...model, api, reasoning: true }, context, {
      apiKey: "fixture-transport-value",
      onPayload,
    }),
  );
}
const carrier = (content: string, timestamp = TS): AgentMessage => ({
  role: "custom",
  customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  content,
  display: false,
  details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  timestamp,
});
async function capture(
  api: "openai-completions" | "openai-responses",
  messages: AgentMessage[],
  boundaryOptions: BoundaryOptions = options,
) {
  const context = {
    systemPrompt: "Stable system prompt",
    messages: convertToLlm(relocate(normalize(messages, boundaryOptions))),
  };
  return capturePayload((onPayload) => {
    const opts = { apiKey: "fixture-transport-value", cacheRetention: "none" as const, onPayload };
    return api === "openai-completions"
      ? streamOpenAICompletions({ ...model, api }, context, opts)
      : streamOpenAIResponses({ ...model, api }, context, opts);
  });
}

describe("prompt-cache boundary regressions", () => {
  let env: ReturnType<typeof captureEnv>;
  beforeEach(() => {
    env = captureEnv(["OPENCLAW_PROMPT_CACHE_ASSERT"]);
    setTestEnvValue("OPENCLAW_PROMPT_CACHE_ASSERT", "1");
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    env.restore();
  });

  describe("in-history prompt updates", () => {
    registerParityHostLifecycle();
    it.each(["anthropic-messages", "openai-responses"] as const)(
      "%s preserves the request prefix across fresh attempts and refreshed prompt sections",
      async (api) => {
        const sessionId = `prompt-update-${api}`;
        const manager = SessionManager.inMemory();
        const requests: Record<string, unknown>[] = [];
        const stableSections = [
          "Skills",
          "Tooling",
          "Memory Recall",
          "Runtime Context",
          "Model Aliases",
          "Other",
        ];
        const dynamicSections = ["Conversation Context", "Subagent Context"];
        try {
          for (let turn = 0; turn < 3; turn++) {
            const catalogRef = createToolSearchCatalogRef();
            const toolContext = { config: { tools: { codeMode: true } }, catalogRef };
            const surface = applyCodeModeCatalog({
              ...toolContext,
              tools: [...createCodeModeTools(toolContext), createStubTool(`fixture_${turn}`)],
            });
            using lease = retainEmbeddedSessionPromptState(sessionId);
            const projection = prepareSessionSystemPrompt({
              state: lease.state,
              routeKey: api,
              systemPrompt:
                stableSections.map((section) => `## ${section}\n${section} ${turn}`).join("\n") +
                SYSTEM_PROMPT_CACHE_BOUNDARY +
                dynamicSections.map((section) => `## ${section}\n${section} ${turn}`).join("\n") +
                `\n## Code Mode Tools\n${buildCodeModeCatalogPrompt(toolContext, catalogRef.current!.entries)}`,
              entries: manager.getBranch(),
            });
            manager.appendMessage(user(`Turn ${turn}`, TS + turn * 60000));
            if (projection.update) {
              manager.appendMessage(projection.update);
            }
            const context = {
              systemPrompt: projection.systemPrompt,
              tools: surface.tools,
              messages: llmHistory(manager.buildSessionContext().messages, {
                inHistorySystemUpdates: true,
                includeTimestamp: false,
              }),
            };
            requests.push(await captureTransport(api, context));
            clearToolSearchCatalog({ catalogRef });
            projection.commit();
            await persistSessionSystemPrompt(lease.state, (customType, data) =>
              manager.appendCustomEntry(customType, data),
            );
            manager.appendMessage(providerAnswer(api));
          }
          const first = expectDefined(requests[0], "first request");
          const promptKey = api === "anthropic-messages" ? "system" : "instructions";
          const historyKey = api === "anthropic-messages" ? "messages" : "input";
          expect(first[promptKey]).toBeDefined();
          for (let turn = 1; turn < requests.length; turn++) {
            const previous = requests[turn - 1]!;
            const next = requests[turn]!;
            expect(next[promptKey]).toEqual(first[promptKey]);
            expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
            const before = previous[historyKey];
            const after = next[historyKey];
            if (!Array.isArray(before) || !Array.isArray(after)) {
              throw new Error("Expected request message arrays");
            }
            expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
            expect(after.at(-1)).toMatchObject({
              role: api === "anthropic-messages" ? "system" : "developer",
            });
            for (const section of [...stableSections, ...dynamicSections]) {
              expect(JSON.stringify(after.at(-1))).toContain(`${section} ${turn}`);
            }
            expect(JSON.stringify(after.at(-1))).toContain(`fixture_${turn}`);
          }
        } finally {
          clearEmbeddedSessionPromptStates([sessionId]);
        }
      },
    );
  });

  it("rejects unknown session projection versions before submitting history", () => {
    expect(() => normalize([], { sessionVersion: 99 })).toThrow(
      "Unsupported session prompt projection version",
    );
  });

  describe("cross-run failure and queued-input replay", () => {
    registerParityHostLifecycle();
    it.each([
      { api: "openai-responses", stopReason: "error", contentKind: "partial" },
      { api: "openai-responses", stopReason: "error", contentKind: "completed-tool" },
      { api: "openai-responses", stopReason: "error", contentKind: "unfinished-tool-only" },
      { api: "anthropic-messages", stopReason: "error", contentKind: "completed-tool" },
    ] as const)(
      "$api preserves $contentKind $stopReason history through cold replay",
      async ({ api, stopReason, contentKind }) => {
        const staged = user("Staged follow-up", TS + 2);
        const operator = {
          ...buildSystemUpdateMessage("Current operator facts", "runtime-context", true),
          timestamp: TS + 3,
        };
        const failed = {
          ...providerAnswer(api),
          stopReason,
          content: [
            ...(contentKind === "unfinished-tool-only" ? [] : [textBlock("Incomplete answer")]),
            ...(contentKind === "completed-tool" || contentKind === "unfinished-tool-only"
              ? [toolCall("call_fixture")]
              : []),
          ],
          errorMessage: "private provider diagnostic",
          __openclaw: { runId: "first-run", itemId: "first-item" },
        };
        const messages = [
          user("First question"),
          failed,
          ...(contentKind === "completed-tool"
            ? [toolResult("call_fixture", "Read result", TS + 1)]
            : []),
          {
            ...providerAnswer(api),
            content: [textBlock("Recovered reply.")],
            __openclaw: { runId: "recovered-run", itemId: "recovered-item" },
          },
          staged,
          operator,
        ];
        const boundaryOptions = {
          ...options,
          sessionVersion: 4,
          inHistorySystemUpdates: true,
          appendOnlyRuntimeContext: true,
        };
        const captureRequest = (history: AgentMessage[]) =>
          captureTransport(api, {
            systemPrompt: "Stable system prompt",
            messages: llmHistory(history, boundaryOptions),
          });
        const firstBoundary = llmHistory(messages, boundaryOptions);
        const first = await captureRequest(messages);
        const manager = SessionManager.inMemory();
        for (const message of messages) {
          manager.appendMessage(message);
        }
        manager.appendMessage(answer);
        manager.appendMessage(user("Next run", TS + 60000));
        const policy: TranscriptPolicy = {
          sanitizeMode: "images-only",
          sanitizeToolCallIds: false,
          preserveNativeAnthropicToolUseIds: api === "anthropic-messages",
          repairToolUseResultPairing: true,
          preserveSignatures: api === "anthropic-messages",
          appendOnlyRuntimeContext: true,
          inHistorySystemUpdates: true,
          dropThinkingBlocks: false,
          applyGoogleTurnOrdering: false,
          validateGeminiTurns: false,
          validateAnthropicTurns: api === "anthropic-messages",
          allowSyntheticToolResults: true,
        };
        const sanitized = await sanitizeSessionHistory({
          messages: manager.buildSessionContext().messages,
          modelApi: api,
          policy,
          sessionManager: manager,
          sessionId: `failed-replay-${api}`,
        });
        const replayed = await validateReplayTurns({ messages: sanitized, modelApi: api, policy });
        // Observation uses this sequence before provider encoding, so it must be
        // stable even when the transport omits an empty failed assistant.
        expect(llmHistory(replayed, boundaryOptions).slice(0, firstBoundary.length)).toEqual(
          firstBoundary,
        );
        const second = await captureRequest(replayed);
        const field = api === "anthropic-messages" ? "messages" : "input";
        const before = first[field] as unknown[];
        const after = second[field] as unknown[];
        expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
        expect(before).toContainEqual(
          expect.objectContaining({
            role: api === "anthropic-messages" ? "system" : "developer",
            content: [
              {
                type: api === "anthropic-messages" ? "text" : "input_text",
                text: "Current operator facts",
              },
            ],
          }),
        );
        expect(JSON.stringify(before)).toContain("Staged follow-up");
        expect(JSON.stringify([first, second])).not.toMatch(
          /private provider diagnostic|first-run|first-item|recovered-run|recovered-item/,
        );
        expect(failed.errorMessage).toBe("private provider diagnostic");
      },
    );
  });

  it("escapes literal delimiter mentions by session version without rewriting transcript bytes", () => {
    const text = `Quote ${INTERNAL_RUNTIME_CONTEXT_BEGIN} and ${INTERNAL_RUNTIME_CONTEXT_END} literally.`;
    const input: AgentMessage[] = [{ role: "user", content: text, timestamp: TS }];
    for (const sessionVersion of [3, 4]) {
      const boundaryOptions = {
        sessionVersion,
        appendOnlyRuntimeContext: true,
        includeTimestamp: false,
      };
      const expected =
        sessionVersion === 4
          ? "Quote [[OPENCLAW_INTERNAL_CONTEXT_BEGIN]] and [[OPENCLAW_INTERNAL_CONTEXT_END]] literally."
          : text;
      const current = normalize(input, boundaryOptions);
      const history = normalize([...input, user("next", TS + 60000)], boundaryOptions);
      expect(current[0]).toMatchObject({ role: "user", content: expected });
      expect(history[0]).toMatchObject({ role: "user", content: expected });
      expect(normalize(current, boundaryOptions)).toEqual(current);
    }
    expect(input).toEqual([{ role: "user", content: text, timestamp: TS }]);
  });

  it("keeps every sent fingerprint stable and appends one late-media turn", async () => {
    const dir = sessionDirs.make();
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      cwd: dir,
      sessionEntry: undefined,
      sessionId: "session-99495",
      sessionKey: "agent:main:cache-99495",
      storePath: path.join(dir, "sessions.json"),
    };
    const input = { text: "describe this", timestamp: TS, idempotencyKey: "cache-99495:user" };
    const started = createDeferred();
    const media = createDeferred<UserTurnInput>();
    const recorder = createUserTurnTranscriptRecorder({
      input,
      target,
      resolveInput: async () => {
        started.resolve();
        return await media.promise;
      },
    });
    const persistence = recorder.persistFallback();
    await started.promise;
    await persistUserTurnTranscript({ ...target, input });
    recorder.markRuntimePersisted(recorder.message);
    const runtimeMessage = mergePreparedUserTurnMessageForRuntime({
      runtimeMessage: user(input.text),
      preparedMessage: recorder.message,
    });
    const sent = normalize([runtimeMessage], options);
    recorder.markSentToProvider?.();
    const mediaPath = path.join(dir, "image.png");
    media.resolve({ ...input, media: [{ path: mediaPath, contentType: "image/png" }] });
    await persistence;
    const persisted = (await loadTranscriptEvents(target))
      .map((entry) => entry as { message?: AgentMessage })
      .flatMap((entry) => (entry.message ? [entry.message] : []));
    const next = normalize(persisted, options);
    const late = expectDefined(persisted.at(-1), "persisted late-media turn");
    expect(next).toHaveLength(sent.length + 1);
    expect(next.slice(0, sent.length)).toEqual(sent);
    expect(late).toMatchObject({ content: "", __openclaw: { lateMedia: true } });
    expect(next.at(-1)).toMatchObject({
      content: `${buildTimestampPrefix(new Date(TS), options)}[media attached: ${mediaPath}]`,
    });
    const projection = buildLateMediaAttachedProjection(late);
    expect(projection).toMatchObject({
      text: `[media attached: ${mediaPath}]`,
      media: [{ path: mediaPath, contentType: "image/png", kind: "image" }],
    });
  });

  it("preserves the full-history provider prefix through a completed tool loop on the next user turn", async () => {
    const active = [
      carrier("sender=Bob"),
      user("Check the deployment."),
      {
        ...providerAnswer("openai-completions"),
        stopReason: "toolUse" as const,
        content: [toolCall("call_1")],
        timestamp: TS + 1,
      },
      toolResult("call_1", "result 1", TS + 1),
    ];
    const previous = await capture("openai-completions", active);
    const next = await capture("openai-completions", [
      ...active,
      answer,
      carrier("new metadata", TS + 60000),
      user("next request", TS + 60000),
    ]);
    const previousMessages = previous.messages as unknown[];
    const nextMessages = next.messages as unknown[];
    expect(nextMessages.slice(0, previousMessages.length - 1)).toEqual(
      previousMessages.slice(0, -1),
    );
    expect(JSON.stringify(previousMessages.at(-1))).toContain("sender=Bob");
    expect(JSON.stringify(nextMessages)).not.toContain("sender=Bob");
  });

  it("keeps batched steering context with its owning user through Responses conversion", async () => {
    const steering = ["first", "second"].map((label, index) => {
      const message = user(`${label} steering user`, TS + (index + 1) * 60000);
      const text = `${label} steering context`;
      attachSteeringRuntimeContext(message, {
        text,
        fragments: [{ kind: "conversation-data", text }],
      });
      return message;
    });

    const request = await capture("openai-responses", [
      carrier("original context"),
      user("original question"),
      providerAnswer("openai-responses"),
      ...steering,
    ]);
    const input = JSON.stringify(request.input);
    const orderedText = [
      "original question",
      "I understand.",
      "first steering user",
      "first steering context",
      "second steering user",
      "second steering context",
    ];
    let previousIndex = -1;
    for (const text of orderedText) {
      const index = input.indexOf(text);
      expect(index, text).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it("keeps persisted group sender bytes identical from the active array form to historical replay", () => {
    const runtimeMessage = user("The launch is Friday");
    const transcriptMessage = {
      ...runtimeMessage,
      content: "The launch is Friday",
      __openclaw: { senderId: "alice-id", senderName: "Alice", senderUsername: "alice" },
    };
    const boundaryOptions = {
      ...options,
      userTranscriptContexts: [{ runtimeMessage, transcriptMessage }],
    };
    const current = normalize([runtimeMessage], boundaryOptions);
    const historical = normalize(
      [transcriptMessage, answer, user("Who said that?", TS + 60000)],
      options,
    );
    const currentContent = current[0]?.role === "user" ? current[0].content : undefined;
    const historicalContent = historical[0]?.role === "user" ? historical[0].content : undefined;
    expect(currentContent).toEqual(historicalContent);
    expect(current[0]).toMatchObject({ content: expect.stringContaining('"name":"Alice"') });
    expect(normalize(current, boundaryOptions)).toEqual(current);
  });
});

function createSession() {
  return {
    get messages() {
      return this.agent.state.messages;
    },
    agent: {
      state: { messages: [] as AgentMessage[] },
      continue: async () => undefined,
      transformContext: async (messages: AgentMessage[]) => messages,
    },
  };
}
const originalUser = (): UserMessage => ({ role: "user", content: "original", timestamp: 1 });
const steeringUser = (): UserMessage => ({ role: "user", content: "steering", timestamp: 1 });
function installPrompt(
  session: Parameters<typeof installContext>[0]["session"],
  persistedUserIdempotencyKey?: string,
) {
  const cleanupPrompt = installModelPromptProjection({
    session,
    transcriptPrompt: "original",
    prependContext: "before",
    shouldCapturePrompt: () => true,
  });
  const message = runtimeContext();
  const cleanupContext = installContext({
    session,
    message,
    ...(persistedUserIdempotencyKey ? { persistedUserIdempotencyKey } : {}),
  });
  const cleanup = () => {
    cleanupContext();
    cleanupPrompt();
  };
  return { message, cleanup };
}
const runtimeContext = () =>
  expectDefined(runtimeCarrier("original context"), "runtime context fixture");

describe("active prompt steering context", () => {
  it("restores the unkeyed source user after an existing context hook projects it", async () => {
    const original = originalUser();
    const steering = steeringUser();
    const session = createSession();
    session.agent.transformContext = async (messages) =>
      messages.map((message) =>
        message.role === "user" ? { ...message, content: "projected" } : message,
      );
    const originalTransform = session.agent.transformContext;
    const cleanupPrompt = installPrompt(session);
    const message = runtimeContext();
    const cleanup = installRuntimeContextMessageForPrompt({ session, message });
    session.agent.state.messages.push(original);
    normalizeMessagesForLlmBoundary(await session.agent.transformContext(session.messages));
    session.agent.state.messages = [original, steering];
    await session.agent.continue();
    const retry = session.messages;
    cleanup();
    cleanupPrompt();
    expect(retry).toEqual([message, original, steering]);
    expect(session.agent.transformContext).toBe(originalTransform);
    expect(session.messages).toEqual([original, steering]);
  });

  it("keeps steering context through tool use and retires it after a settled answer", () => {
    const quoted = (label: string, timestamp: number) => {
      const message = { ...steeringUser(), timestamp };
      attachSteeringRuntimeContext(message, { text: `${label} quoted context` });
      return message;
    };
    const first = quoted("first", 1);
    const second = quoted("second", 2);
    const toolUse = createAssistant(testModel, [], "toolUse");

    expect(JSON.stringify(normalize([first, toolUse]))).toContain("first quoted context");
    for (const stopReason of ["error", "aborted"] as const) {
      const failed = createAssistant(testModel, [], stopReason);
      const retry = JSON.stringify(normalize([first, second, failed]));
      expect(retry).toContain("first quoted context");
      expect(retry).toContain("second quoted context");
    }

    const settled = createAssistant(testModel, [textBlock("done")]);
    const third = quoted("third", 3);
    const next = JSON.stringify(normalize([first, second, settled, third]));
    expect(next).not.toMatch(/first quoted context|second quoted context/);
    expect(next).toContain("third quoted context");
  });

  it("keeps keyless context on the original prompt through pre-prompt rebuilding and initial steering", async () => {
    const manager = SessionManager.inMemory();
    const kept = manager.appendMessage({ role: "user", content: "older request", timestamp: 1 });
    const requests: string[] = [];
    const agent = new Agent({
      initialState: { model: testModel, messages: manager.buildSessionContext().messages },
      convertToLlm: (messages) => convertToLlm(normalize(messages)),
      streamFn: (activeModel, context) => {
        requests.push(JSON.stringify(context.messages));
        return createAssistantResultStream(createAssistant(activeModel, [textBlock("done")]));
      },
    });
    const session = {
      agent,
      get messages() {
        return agent.state.messages;
      },
    };
    const originalPrompt = agent.prompt.bind(agent);
    agent.prompt = originalPrompt;
    const { message, cleanup } = installPrompt(session);
    const retainedPrompt = agent.prompt.bind(agent);
    manager.appendCompaction("Older history summarized.", kept, 100);
    agent.state.messages = manager.buildSessionContext().messages;
    agent.steer({ role: "user", content: "steering", timestamp: 2 });
    await agent.prompt({ role: "user", content: "original", timestamp: 2 });
    const activeMessages = agent.state.messages;
    cleanup();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("before\\n\\noriginal");
    expect(requests[0]).not.toContain("before\\n\\nsteering");
    expect(activeMessages).toContain(message);
    expect(agent).toHaveProperty("prompt", originalPrompt);
    await retainedPrompt("later");
    expect(agent.state.messages).not.toContain(message);
  });

  it.each(["keyless", "rewritten key"])(
    "restores the original %s transcript user after actual compaction",
    async (mode) => {
      const original = originalUser();
      const manager = SessionManager.inMemory();
      const contexts = createUserTranscriptContextRegistry();
      const session = createSession();
      const { message, cleanup } = installPrompt(
        session,
        mode === "rewritten key" ? "before-hook-key" : undefined,
      );
      session.agent.state.messages.push(original);
      await session.agent.transformContext(session.messages);
      const capturedPrompt = session.messages.at(-1);
      if (capturedPrompt?.role !== "user") {
        throw new Error("Expected the captured source user prompt");
      }
      const persisted = manager.appendMessageWithTranscriptAnchor({
        ...capturedPrompt,
        ...(mode === "keyless" ? {} : { idempotencyKey: "canonical-key" }),
      });
      contexts.record(original, persisted.message);
      normalize(await session.agent.transformContext(session.messages), {
        userTranscriptContexts: contexts.list(),
      });
      const steering = manager.appendMessageWithTranscriptAnchor(steeringUser());
      manager.appendCompaction("Earlier context was summarized.", persisted.entryId, 100);
      session.agent.state.messages = manager.buildSessionContext().messages;
      await session.agent.continue();
      const retry = session.messages;
      const projected = normalize(await session.agent.transformContext(retry));
      cleanup();
      expect(persisted.message).not.toBe(original);
      expect(retry.slice(-3)).toEqual([message, persisted.message, steering.message]);
      expect(projected.at(-2)).toMatchObject({ content: "before\n\noriginal" });
      expect(projected.at(-1)).toBe(steering.message);
      expect(session.messages).not.toContain(message);
    },
  );

  it("does not adopt same-time steering after compaction removes the owned prompt", async () => {
    const original = originalUser();
    const session = createSession();
    const { cleanup } = installPrompt(session);
    session.agent.state.messages.push(original);
    await session.agent.transformContext(session.messages);
    const manager = SessionManager.inMemory();
    manager.appendMessage(original);
    const kept = manager.appendMessageWithTranscriptAnchor(steeringUser());
    manager.appendCompaction("Original request was summarized.", kept.entryId, 100);
    session.agent.state.messages = manager.buildSessionContext().messages;
    await session.agent.continue();
    const projected = await session.agent.transformContext(session.messages);
    cleanup();
    expect(projected.at(-1)).toBe(kept.message);
  });

  it("preserves user metadata through steering and runtime-context cleanup", () => {
    const session = createSession();
    const message = runtimeContext();
    const cleanup = installContext({ session, message });
    const promptText =
      'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"channel":"discord"}\n```\n\nOriginal ask';
    session.agent.state.messages.push({
      role: "user",
      content: promptText,
      timestamp: 1717574460000,
    });
    const boundaryOptions = {
      timezone: "UTC",
      currentUserTimestampOverride: { timestamp: 1717570800000, text: promptText },
    };
    const project = () => relocate(normalize(session.messages, boundaryOptions));
    const prefix = project();
    session.agent.state.messages.push(makeUserMessage("new requirement", 1717570860000));
    const steered = project();
    cleanup();
    expect(steered.slice(0, prefix.length)).toEqual(prefix);
    expect(steered.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("new requirement"),
    });
    expect(session.messages).not.toContain(message);
    expect(project()[0]).toMatchObject({ content: expect.stringContaining("Conversation info:") });
    session.agent.state.messages.unshift(message);
    expect(project()).not.toContain(message);
  });
});
