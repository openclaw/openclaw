import path from "node:path";
import { streamOpenAICompletions, streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import { createOpenAIResponsesTransportStreamFn } from "../../../../packages/ai/src/transports/openai-responses-client.js";
import { resolveResponsesContinuationRequest } from "../../../../packages/ai/src/transports/openai-responses-continuation.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { loadTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import type { Model, UserMessage } from "../../../llm/types.js";
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
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  relocateCurrentRuntimeContextCarrierToTail,
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
import {
  clearEmbeddedSessionPromptStates,
  persistSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
  prepareSessionSystemPrompt,
} from "../session-prompt-state.js";
import {
  installRuntimeContextMessageForPrompt,
  installModelPromptTransform,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import {
  attachSteeringRuntimeContext,
  buildRuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-99495-boundary-");
const TS = 1717570800000;
const options = { timezone: "UTC" };
const user = (text: string, timestamp = TS): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});
const answer = makeAgentAssistantMessage({
  content: [{ type: "text", text: "I understand." }],
  timestamp: TS + 1,
});
const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;
const carrier = (content: string, timestamp = TS): AgentMessage => ({
  role: "custom",
  customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  content,
  display: false,
  details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  timestamp,
});
function toolRound(round: number, api: "openai-completions" | "openai-responses"): AgentMessage[] {
  const id = `call_${round}`;
  return [
    {
      ...answer,
      api,
      provider: model.provider,
      model: model.id,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      timestamp: TS + round,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: `result ${round}` }],
      isError: false,
      timestamp: TS + round,
    },
  ];
}
async function capture(api: "openai-completions" | "openai-responses", messages: AgentMessage[]) {
  let captured: Record<string, unknown> | undefined;
  const context = {
    systemPrompt: "Stable system prompt",
    messages: convertToLlm(
      relocateCurrentRuntimeContextCarrierToTail(
        normalizeMessagesForLlmBoundary(messages, options),
      ),
    ),
  };
  const streamOptions = {
    apiKey: ["fixture", "transport", "value"].join("-"),
    cacheRetention: "none" as const,
    onPayload(payload: unknown) {
      captured = payload as Record<string, unknown>;
      throw new Error("stop after payload capture");
    },
  };
  const stream =
    api === "openai-completions"
      ? streamOpenAICompletions({ ...model, api }, context, streamOptions)
      : streamOpenAIResponses({ ...model, api }, context, streamOptions);
  expect((await stream.result()).stopReason).toBe("error");
  return expectDefined(captured, "captured provider payload");
}

describe("prompt-cache boundary regressions", () => {
  let env: ReturnType<typeof captureEnv>;
  beforeEach(() => {
    env = captureEnv(["OPENCLAW_PROMPT_CACHE_ASSERT"]);
    setTestEnvValue("OPENCLAW_PROMPT_CACHE_ASSERT", "1");
  });
  afterEach(() => env.restore());

  describe("in-history prompt updates", () => {
    registerParityHostLifecycle();

    it.each(["anthropic-messages", "openai-responses"] as const)(
      "%s preserves the request prefix across fresh attempts and refreshed prompt sections",
      async (api) => {
        const sessionId = `prompt-update-${api}`;
        const manager = SessionManager.inMemory();
        const requests: Record<string, unknown>[] = [];
        try {
          for (let turn = 0; turn < 3; turn++) {
            using lease = retainEmbeddedSessionPromptState(sessionId);
            const projection = prepareSessionSystemPrompt({
              state: lease.state,
              routeKey: api,
              systemPrompt: `## Skills\nSkill ${turn}\n## Project Context\nMemory ${turn}${SYSTEM_PROMPT_CACHE_BOUNDARY}## Temporal Context\nDay ${turn}`,
              entries: manager.getBranch(),
            });
            manager.appendMessage(user(`Turn ${turn}`, TS + turn * 60000));
            if (projection.update) {
              manager.appendMessage(projection.update);
            }
            const context = {
              systemPrompt: projection.systemPrompt,
              messages: convertToLlm(
                normalizeMessagesForLlmBoundary(manager.buildSessionContext().messages, {
                  inHistorySystemUpdates: true,
                  includeTimestamp: false,
                }),
              ),
            };
            if (api === "anthropic-messages") {
              const request = await captureAnthropicRequest("transport", {
                model: { id: "claude-opus-5" },
                cacheRetention: "none",
                context,
              });
              requests.push(request.payload);
            } else {
              const result = await createOpenAIResponsesTransportStreamFn()(
                { ...model, api, reasoning: true },
                context,
                {
                  apiKey: "fixture-transport-value",
                  onPayload(payload) {
                    requests.push(payload as Record<string, unknown>);
                    throw new Error("stop after payload capture");
                  },
                },
              );
              expect((await result.result()).stopReason).toBe("error");
            }
            projection.commit();
            await persistSessionSystemPrompt(lease.state, (customType, data) =>
              manager.appendCustomEntry(customType, data),
            );
            manager.appendMessage({
              ...answer,
              api,
              provider: api === "anthropic-messages" ? "anthropic" : "openai",
              model: api === "anthropic-messages" ? "claude-opus-5" : model.id,
            });
          }
          const first = expectDefined(requests[0], "first request");
          const promptKey = api === "anthropic-messages" ? "system" : "instructions";
          const historyKey = api === "anthropic-messages" ? "messages" : "input";
          expect(first[promptKey]).toBeDefined();
          for (let turn = 1; turn < requests.length; turn++) {
            const previous = requests[turn - 1]!;
            const next = requests[turn]!;
            expect(next[promptKey]).toEqual(first[promptKey]);
            const before = previous[historyKey];
            const after = next[historyKey];
            if (!Array.isArray(before) || !Array.isArray(after)) {
              throw new Error("Expected request message arrays");
            }
            expect(after.slice(0, before.length)).toEqual(before);
            expect(after.at(-1)).toMatchObject({
              role: api === "anthropic-messages" ? "system" : "developer",
            });
            for (const section of ["Skill", "Memory", "Day"]) {
              expect(JSON.stringify(after.at(-1))).toContain(`${section} ${turn}`);
            }
          }
        } finally {
          clearEmbeddedSessionPromptStates([sessionId]);
        }
      },
    );
  });

  it("rejects unknown session projection versions before submitting history", () => {
    expect(() => normalizeMessagesForLlmBoundary([], { sessionVersion: 99 })).toThrow(
      "Unsupported session prompt projection version",
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
      const current = normalizeMessagesForLlmBoundary(input, boundaryOptions);
      const history = normalizeMessagesForLlmBoundary(
        [...input, user("next", TS + 60000)],
        boundaryOptions,
      );
      expect(current[0]).toMatchObject({ role: "user", content: expected });
      expect(history[0]).toMatchObject({ role: "user", content: expected });
      expect(normalizeMessagesForLlmBoundary(current, boundaryOptions)).toEqual(current);
    }
    expect(input).toEqual([{ role: "user", content: text, timestamp: TS }]);
  });

  it("keeps every sent fingerprint stable and appends one late-media turn", async () => {
    const dir = sessionDirs.make();
    const target = {
      agentId: "main",
      cwd: dir,
      sessionEntry: undefined,
      sessionId: "session-99495",
      sessionKey: "agent:main:cache-99495",
      storePath: path.join(dir, "sessions.json"),
    };
    const input = { text: "describe this", timestamp: TS, idempotencyKey: "cache-99495:user" };
    let resolveMedia!: (input: UserTurnInput) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const media = new Promise<UserTurnInput>((resolve) => {
      resolveMedia = resolve;
    });
    const recorder = createUserTurnTranscriptRecorder({
      input,
      target,
      resolveInput: async () => {
        markStarted();
        return await media;
      },
    });
    const persistence = recorder.persistFallback();
    await started;
    await persistUserTurnTranscript({ ...target, input });
    recorder.markRuntimePersisted(recorder.message);
    const runtimeMessage = mergePreparedUserTurnMessageForRuntime({
      runtimeMessage: user(input.text),
      preparedMessage: recorder.message,
    });
    const sent = normalizeMessagesForLlmBoundary([runtimeMessage], options);
    recorder.markSentToProvider?.();
    const mediaPath = path.join(dir, "image.png");
    resolveMedia({ ...input, media: [{ path: mediaPath, contentType: "image/png" }] });
    await persistence;
    const persisted = (await loadTranscriptEvents(target))
      .map((entry) => entry as { message?: AgentMessage })
      .flatMap((entry) => (entry.message ? [entry.message] : []));
    const next = normalizeMessagesForLlmBoundary(persisted, options);
    const late = expectDefined(persisted.at(-1), "persisted late-media turn");
    expect(next).toHaveLength(sent.length + 1);
    expect(next.slice(0, sent.length)).toEqual(sent);
    expect(late).toMatchObject({ content: "", __openclaw: { lateMedia: true } });
    expect(next.at(-1)).toMatchObject({
      content: `${buildTimestampPrefix(new Date(TS), options)}[media attached: ${mediaPath}]`,
    });
    const projection = buildLateMediaAttachedProjection(late);
    expect(projection.text).toBe(`[media attached: ${mediaPath}]`);
    expect(projection.media).toEqual([
      expect.objectContaining({ path: mediaPath, contentType: "image/png", kind: "image" }),
    ]);
  });

  it("preserves the full-history provider prefix through a completed tool loop on the next user turn", async () => {
    const active = [
      carrier("sender=Bob"),
      user("Check the deployment."),
      ...toolRound(1, "openai-completions"),
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

  it("continues Responses tool rounds without moving or losing cron prompt context", async () => {
    const metadata = "Conversation info:\nsender=Bob";
    const memory = "Context:\n<active_memory_plugin>\nsaved preference\n</active_memory_plugin>";
    const messages = [
      carrier(metadata),
      user(`${memory}\n\nCurrent time: 2026-06-05 10:30. Check the deployment.`),
    ];
    let previous = await capture("openai-responses", messages);
    expect(JSON.stringify(previous.input)).toContain("saved preference");
    expect(JSON.stringify(previous.input)).toContain(metadata.replaceAll("\n", "\\n"));
    for (const round of [1, 2]) {
      const callId = `call_${round}`;
      messages.push(...toolRound(round, "openai-responses"));
      const request = await capture("openai-responses", messages);
      const continuation = resolveResponsesContinuationRequest(
        {
          lastRequest: previous,
          lastResponseId: `resp_${round}`,
          lastResponseItems: [
            { type: "function_call", call_id: callId, name: "read", arguments: "{}" },
          ],
        },
        request,
      );
      expect(continuation.continuationStatus).toBe("continued");
      expect(continuation.request.input).toEqual([
        { type: "function_call_output", call_id: callId, output: `result ${round}` },
      ]);
      previous = request;
    }
    messages.push(answer, user("next request", TS + 60000));
    const next = await capture("openai-responses", messages);
    expect(JSON.stringify(next.input)).not.toContain("saved preference");
    expect(JSON.stringify(next.input)).not.toContain("sender=Bob");
    expect(
      resolveResponsesContinuationRequest(
        { lastRequest: previous, lastResponseId: "resp_final", lastResponseItems: [] },
        next,
      ).continuationStatus,
    ).toBe("history_changed");
  });

  it("keeps batched steering context with its owning user through Responses conversion", async () => {
    const firstSteering = user("first steering user", TS + 60000);
    attachSteeringRuntimeContext(firstSteering, {
      text: "first steering context",
      fragments: [{ kind: "conversation-data", text: "first steering context" }],
    });
    const secondSteering = user("second steering user", TS + 120000);
    attachSteeringRuntimeContext(secondSteering, {
      text: "second steering context",
      fragments: [{ kind: "conversation-data", text: "second steering context" }],
    });

    const request = await capture("openai-responses", [
      carrier("original context"),
      user("original question"),
      { ...answer, api: "openai-responses", provider: model.provider, model: model.id },
      firstSteering,
      secondSteering,
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
    const current = normalizeMessagesForLlmBoundary([runtimeMessage], boundaryOptions);
    const historical = normalizeMessagesForLlmBoundary(
      [transcriptMessage, answer, user("Who said that?", TS + 60000)],
      options,
    );
    const currentContent = current[0]?.role === "user" ? current[0].content : undefined;
    const historicalContent = historical[0]?.role === "user" ? historical[0].content : undefined;
    expect(currentContent).toEqual(historicalContent);
    expect(current[0]).toMatchObject({ content: expect.stringContaining('"name":"Alice"') });
    expect(normalizeMessagesForLlmBoundary(current, boundaryOptions)).toEqual(current);
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
const installPrompt = (session: Parameters<typeof installModelPromptTransform>[0]["session"]) =>
  installModelPromptTransform({
    session,
    transcriptPrompt: "original",
    prependContext: "before",
    shouldCapturePrompt: () => true,
  });
const runtimeContext = () =>
  expectDefined(buildRuntimeContextCustomMessage("original context"), "runtime context fixture");

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
    const first = steeringUser();
    attachSteeringRuntimeContext(first, { text: "first quoted context" });
    const second = { ...steeringUser(), timestamp: 2 };
    attachSteeringRuntimeContext(second, { text: "second quoted context" });
    const toolUse = createAssistant(testModel, []);
    toolUse.stopReason = "toolUse";

    expect(JSON.stringify(normalizeMessagesForLlmBoundary([first, toolUse]))).toContain(
      "first quoted context",
    );
    for (const stopReason of ["error", "aborted"] as const) {
      const failed = createAssistant(testModel, []);
      failed.stopReason = stopReason;
      const retry = JSON.stringify(normalizeMessagesForLlmBoundary([first, second, failed]));
      expect(retry).toContain("first quoted context");
      expect(retry).toContain("second quoted context");
    }

    const settled = createAssistant(testModel, [{ type: "text", text: "done" }]);
    const third = { ...steeringUser(), timestamp: 3 };
    attachSteeringRuntimeContext(third, { text: "third quoted context" });
    const next = JSON.stringify(normalizeMessagesForLlmBoundary([first, second, settled, third]));
    expect(next).not.toContain("first quoted context");
    expect(next).not.toContain("second quoted context");
    expect(next).toContain("third quoted context");
  });

  it("keeps keyless context on the original prompt through pre-prompt rebuilding and initial steering", async () => {
    const manager = SessionManager.inMemory();
    const kept = manager.appendMessage({ role: "user", content: "older request", timestamp: 1 });
    const requests: string[] = [];
    const agent = new Agent({
      initialState: { model: testModel, messages: manager.buildSessionContext().messages },
      streamFn: (activeModel, context) => {
        requests.push(JSON.stringify(context.messages));
        return createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "done" }]),
        );
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
    const cleanupPrompt = installPrompt(session);
    const message = runtimeContext();
    const cleanupCarrier = installRuntimeContextMessageForPrompt({ session, message });
    const retainedPrompt = agent.prompt.bind(agent);
    manager.appendCompaction("Older history summarized.", kept, 100);
    agent.state.messages = manager.buildSessionContext().messages;
    agent.steer({ role: "user", content: "steering", timestamp: 2 });
    await agent.prompt({ role: "user", content: "original", timestamp: 2 });
    const activeMessages = agent.state.messages;
    cleanupCarrier();
    cleanupPrompt();
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
      const message = runtimeContext();
      const cleanupPrompt = installPrompt(session);
      const cleanup = installRuntimeContextMessageForPrompt({
        session,
        message,
        ...(mode === "rewritten key" ? { persistedUserIdempotencyKey: "before-hook-key" } : {}),
      });
      session.agent.state.messages.push(original);
      const persisted = manager.appendMessageWithTranscriptAnchor({
        ...original,
        ...(mode === "keyless" ? {} : { idempotencyKey: "canonical-key" }),
      });
      contexts.record(original, persisted.message);
      normalizeMessagesForLlmBoundary(await session.agent.transformContext(session.messages), {
        userTranscriptContexts: contexts.list(),
      });
      const steering = manager.appendMessageWithTranscriptAnchor(steeringUser());
      manager.appendCompaction("Earlier context was summarized.", persisted.entryId, 100);
      session.agent.state.messages = manager.buildSessionContext().messages;
      await session.agent.continue();
      const retry = session.messages;
      const projected = await session.agent.transformContext(retry);
      cleanup();
      cleanupPrompt();
      expect(persisted.message).not.toBe(original);
      expect(retry.slice(-3)).toEqual([message, persisted.message, steering.message]);
      expect(projected.at(-2)).toMatchObject({ content: "before\n\noriginal" });
      expect(projected.at(-1)).toBe(steering.message);
      expect(session.messages).not.toContain(message);
    },
  );

  it.each([false, true])(
    "selects a carrierless keyless prompt from rehydrated history (same-time steering=%s)",
    async (ambiguous) => {
      const original = originalUser();
      const manager = SessionManager.inMemory();
      const session = createSession();
      const cleanup = installPrompt(session);
      await session.agent.transformContext([original]);
      const persisted = manager.appendMessageWithTranscriptAnchor(original);
      if (ambiguous) {
        manager.appendMessage(steeringUser());
      }
      manager.appendCompaction("Earlier context was summarized.", persisted.entryId, 100);
      const restored = SessionManager.fromEntries(manager.getPersistedEntries());
      const canonical = restored.buildSessionContext().messages;
      expect(canonical).not.toContain(original);
      const projected = await session.agent.transformContext(canonical);
      cleanup();
      if (ambiguous) {
        expect(projected).toEqual(canonical);
      } else {
        expect(projected.at(-1)).toMatchObject({
          content: "before\n\noriginal",
        });
      }
    },
  );

  it("does not adopt same-time steering after compaction removes the owned prompt", async () => {
    const original = originalUser();
    const session = createSession();
    const cleanupPrompt = installPrompt(session);
    const cleanupCarrier = installRuntimeContextMessageForPrompt({
      session,
      message: runtimeContext(),
    });
    session.agent.state.messages.push(original);
    await session.agent.transformContext(session.messages);
    const manager = SessionManager.inMemory();
    manager.appendMessage(original);
    const kept = manager.appendMessageWithTranscriptAnchor(steeringUser());
    manager.appendCompaction("Original request was summarized.", kept.entryId, 100);
    session.agent.state.messages = manager.buildSessionContext().messages;
    await session.agent.continue();
    const projected = await session.agent.transformContext(session.messages);
    cleanupCarrier();
    cleanupPrompt();
    expect(projected.at(-1)).toBe(kept.message);
  });

  it("preserves the active prompt prefix through steering and retires it on cleanup", () => {
    const session = createSession();
    const message = runtimeContext();
    const cleanup = installRuntimeContextMessageForPrompt({ session, message });
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
    const project = () =>
      relocateCurrentRuntimeContextCarrierToTail(
        normalizeMessagesForLlmBoundary(session.messages, boundaryOptions),
      );
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
    expect(project()[0]).toMatchObject({
      content: expect.not.stringContaining("Conversation info:"),
    });
    session.agent.state.messages.unshift(message);
    expect(project()).not.toContain(message);
  });
});
