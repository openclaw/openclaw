import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";

const { requestPreparedCompactionMock } = vi.hoisted(() => ({
  requestPreparedCompactionMock: vi.fn(),
}));

vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  requestPreparedOpenAIResponsesCompaction: requestPreparedCompactionMock,
}));

import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { testing } from "../openai-transport-stream.test-support.js";
import { log } from "./logger.js";
import { attemptServerEndpointCompaction } from "./server-endpoint-compaction.js";

const model = {
  id: "grok-4.5",
  name: "Grok 4.5",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model;

const openAIModel = {
  ...model,
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} satisfies Model;

function createSession(
  sessionModel: Model = model,
  providerReplay?: AssistantMessage["providerReplay"],
  userText = "remember copper",
) {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({ role: "user", content: userText, timestamp: 1 });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "remembered" }],
    api: sessionModel.api,
    provider: sessionModel.provider,
    model: sessionModel.id,
    providerReplay,
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: 2,
  });
  const messages = sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => structuredClone(entry.message) as AgentMessage);
  return { sessionManager, messages };
}

function attempt(overrides: Partial<Parameters<typeof attemptServerEndpointCompaction>[0]> = {}) {
  const session = createSession(overrides.model ?? model);
  return {
    session,
    result: attemptServerEndpointCompaction({
      trigger: "manual",
      streamFn: vi.fn(),
      model,
      context: { systemPrompt: "system", messages: session.messages },
      sessionManager: session.sessionManager,
      extraParams: {},
      requestOptions: { apiKey: "test", sessionId: "session-1", timeoutMs: 1_000 },
      ...overrides,
    }),
  };
}

function createCompactionResponse(responseModel: Model = model) {
  return {
    item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
    output: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "remember copper" }] },
      { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
    ],
    historyMode: "retained-users",
    usage: { input_tokens: 1_000, output_tokens: 200, dropped_message_count: 1 },
    model: responseModel,
    replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(responseModel, {
      sessionId: "session-1",
    }),
  };
}

beforeEach(() => {
  requestPreparedCompactionMock.mockReset();
  requestPreparedCompactionMock.mockResolvedValue(createCompactionResponse());
});

describe("attemptServerEndpointCompaction", () => {
  it.each([
    { trigger: "manual", throws: false, model },
    { trigger: "manual", throws: true, model },
    { trigger: "budget", throws: false, model },
    { trigger: "manual", throws: false, model: openAIModel },
    { trigger: "budget", throws: false, model: openAIModel },
  ] as const)(
    "reports a committed $model.provider $trigger rewrite without fallback when observer throws=$throws",
    async ({ trigger, throws, model: requestModel }) => {
      requestPreparedCompactionMock.mockResolvedValueOnce(createCompactionResponse(requestModel));
      let committedOwner: ReturnType<SessionManager["getLeafEntry"]>;
      const observerError = new Error("committed observer failed");
      const onCompactionCommitted = vi.fn(() => {
        committedOwner = session.sessionManager.getLeafEntry();
        if (throws) {
          throw observerError;
        }
      });
      const request = { trigger, model: requestModel, onCompactionCommitted };
      const { session, result } = attempt(request);

      if (throws) {
        await expect(result).rejects.toBe(observerError);
      } else {
        await expect(result).resolves.toMatchObject({
          item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
          usage: { input_tokens: 1_000, output_tokens: 200, dropped_message_count: 1 },
        });
      }
      const owner = session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
        throw new Error("expected persisted assistant checkpoint owner");
      }
      expect(owner.message.content).toEqual([{ type: "text", text: "remembered" }]);
      expect(owner.message.providerReplay).toMatchObject({
        type: "openai-responses-retained-compaction",
        id: "cmp_test",
        data: "opaque",
        compactedWindow: {
          state: "ready",
          output: JSON.stringify([
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "remember copper" }],
            },
            { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
          ]),
        },
      });
      expect(owner.message.providerReplay).not.toHaveProperty("replayIndex");
      expect(onCompactionCommitted).toHaveBeenCalledExactlyOnceWith(1_000);
      expect(committedOwner).toMatchObject({
        id: owner.id,
        message: {
          providerReplay: { type: "openai-responses-retained-compaction", data: "opaque" },
        },
      });
    },
  );

  it("marks a checkpoint-only response at the assistant content boundary", async () => {
    requestPreparedCompactionMock.mockResolvedValueOnce({
      item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
      output: [{ type: "compaction", id: "cmp_test", encrypted_content: "opaque" }],
      historyMode: "compacted-prefix",
      usage: { input_tokens: 1_000, output_tokens: 200 },
      model,
      replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
        sessionId: "session-1",
      }),
    });
    const { session, result } = attempt();

    await expect(result).resolves.toBeDefined();
    const owner = session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
      throw new Error("expected persisted assistant checkpoint owner");
    }
    expect(owner.message.providerReplay?.replayIndex).toBe(1);
  });

  it("aborts a pending endpoint request at the compaction timeout", async () => {
    let requestAborted = false;
    requestPreparedCompactionMock.mockImplementationOnce(
      async (
        _streamFn: unknown,
        _model: unknown,
        _context: unknown,
        options: { signal?: AbortSignal },
      ) =>
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(
                options.signal?.reason instanceof Error
                  ? options.signal.reason
                  : new Error("request aborted"),
              );
            },
            { once: true },
          );
        }),
    );

    const { result } = attempt({ requestOptions: { apiKey: "test", timeoutMs: 10 } });

    await expect(result).resolves.toBeUndefined();
    expect(requestAborted).toBe(true);
  });

  const redactSecrets = { logging: { redactPatterns: ["NORTH-SECRET-\\d+"] } };

  it.each([
    { source: "user message", systemPrompt: "system", userText: "token NORTH-SECRET-17" },
    // xAI has no instructions field, so its compact input carries the system prompt.
    { source: "system prompt", systemPrompt: "session NORTH-SECRET-17", userText: "remember" },
  ])(
    "compacts source text verbatim when its $source contains a configured pattern",
    async (testCase) => {
      const warn = vi.spyOn(log, "warn").mockClear();
      const session = createSession(model, undefined, testCase.userText);
      const onUsage = vi.fn();
      requestPreparedCompactionMock.mockResolvedValueOnce(createCompactionResponse(model));
      const { result } = attempt({
        sessionManager: session.sessionManager,
        context: { systemPrompt: testCase.systemPrompt, messages: session.messages },
        config: redactSecrets,
        onUsage,
      });

      await expect(result).resolves.toBeDefined();
      expect(requestPreparedCompactionMock).toHaveBeenCalledOnce();
      expect(onUsage).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("compacts through instructions when only the OpenAI system prompt holds a secret", async () => {
    const session = createSession(openAIModel);
    requestPreparedCompactionMock.mockResolvedValueOnce(createCompactionResponse(openAIModel));
    const onCompactionCommitted = vi.fn();
    const { result } = attempt({
      model: openAIModel,
      sessionManager: session.sessionManager,
      context: { systemPrompt: "session NORTH-SECRET-17", messages: session.messages },
      config: redactSecrets,
      onCompactionCommitted,
    });

    await expect(result).resolves.toBeDefined();
    expect(requestPreparedCompactionMock).toHaveBeenCalledOnce();
    expect(onCompactionCommitted).toHaveBeenCalledOnce();
  });

  it("preserves secret-shaped source text in returned compaction windows", async () => {
    const warn = vi.spyOn(log, "warn").mockClear();
    const session = createSession();
    const response = createCompactionResponse();
    response.output[0] = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "remember NORTH-SECRET-17" }],
    };
    requestPreparedCompactionMock.mockResolvedValueOnce(response);
    const onUsage = vi.fn();
    const onCompactionCommitted = vi.fn();
    const { result } = attempt({
      sessionManager: session.sessionManager,
      context: { systemPrompt: "system", messages: session.messages },
      config: redactSecrets,
      onUsage,
      onCompactionCommitted,
    });

    await expect(result).resolves.toBeDefined();
    expect(onUsage).toHaveBeenCalledWith({
      input_tokens: 1_000,
      output_tokens: 200,
      dropped_message_count: 1,
    });
    expect(JSON.stringify(session.sessionManager.getBranch())).toContain("NORTH-SECRET-17");
    expect(onCompactionCommitted).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([model, openAIModel])(
    "does not call the $provider endpoint during overflow recovery",
    async (requestModel) => {
      const { result } = attempt({ trigger: "overflow", model: requestModel });

      await expect(result).resolves.toBeUndefined();
      expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
    },
  );

  it("leaves a missing canonical checkpoint window to client budget compaction", async () => {
    const owner: Pick<AssistantMessage, "providerReplay"> = {};
    captureOpenAIResponsesCompaction(
      owner,
      { type: "compaction", id: "cmp_legacy", encrypted_content: "opaque-legacy" },
      "retained-users",
      model,
      testing.buildOpenAIResponsesReasoningReplayMetadata(model, { sessionId: "session-1" }),
    );
    const session = createSession(model, owner.providerReplay);
    const before = structuredClone(session.sessionManager.getBranch());
    const { result } = attempt({
      trigger: "budget",
      sessionManager: session.sessionManager,
      context: { systemPrompt: "system", messages: session.messages },
    });

    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
    expect(session.sessionManager.getBranch()).toEqual(before);
  });

  it("preserves the transcript for client recovery when the budget endpoint rejects", async () => {
    requestPreparedCompactionMock.mockRejectedValueOnce(new Error("Context window exceeded"));
    const onCompactionCommitted = vi.fn();
    const { session, result } = attempt({ trigger: "budget", onCompactionCommitted });
    const before = structuredClone(session.sessionManager.getBranch());

    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).toHaveBeenCalledOnce();
    expect(onCompactionCommitted).not.toHaveBeenCalled();
    expect(session.sessionManager.getBranch()).toEqual(before);
  });

  it.each(["fixedTokens", "pendingTokens", "reserveTokens"] as const)(
    "leaves an oversized retained-user window to client compaction after charging %s",
    async (reservedField) => {
      const userText = "source text ".repeat(400);
      const session = createSession(openAIModel, undefined, userText);
      const before = structuredClone(session.sessionManager.getBranch());
      const response = createCompactionResponse(openAIModel);
      response.output[0] = {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      };
      requestPreparedCompactionMock.mockResolvedValueOnce(response);
      const onUsage = vi.fn();
      const onCompactionCommitted = vi.fn();
      const { result } = attempt({
        trigger: "budget",
        model: openAIModel,
        sessionManager: session.sessionManager,
        context: { systemPrompt: "system", messages: session.messages },
        requestBudget: {
          contextWindow: 2_000,
          fixedTokens: 0,
          pendingTokens: 0,
          reserveTokens: 0,
          [reservedField]: 1_000,
        },
        onUsage,
        onCompactionCommitted,
      });

      await expect(result).resolves.toBeUndefined();
      expect(onUsage).toHaveBeenCalledOnce();
      expect(onCompactionCommitted).not.toHaveBeenCalled();
      expect(session.sessionManager.getBranch()).toEqual(before);
    },
  );

  it("admits the returned window without recharging its covered transcript or fixed prompt", async () => {
    const session = createSession(openAIModel, undefined, "old history ".repeat(4_000));
    requestPreparedCompactionMock.mockResolvedValueOnce(createCompactionResponse(openAIModel));
    const onCompactionCommitted = vi.fn();
    const { result } = attempt({
      trigger: "budget",
      model: openAIModel,
      sessionManager: session.sessionManager,
      context: { systemPrompt: "system ".repeat(400), messages: session.messages },
      requestBudget: {
        contextWindow: 2_000,
        fixedTokens: 1_000,
        pendingTokens: 400,
        reserveTokens: 400,
      },
      onCompactionCommitted,
    });

    await expect(result).resolves.toBeDefined();
    expect(onCompactionCommitted).toHaveBeenCalledOnce();
    expect(session.sessionManager.getLeafEntry()).toMatchObject({
      type: "message",
      message: { providerReplay: { data: "opaque" } },
    });
  });

  it.each([model, openAIModel])(
    "preserves $provider custom instructions by falling back to client compaction",
    async (requestModel) => {
      const { result } = attempt({
        model: requestModel,
        customInstructions: "Retain the security caveats.",
      });

      await expect(result).resolves.toBeUndefined();
      expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
    },
  );

  it("does not compact transcript entries that remain after the checkpoint owner", async () => {
    const messages = createSession().messages.concat(makeUserMessage("trailing turn", 3));
    const { result } = attempt({ context: { systemPrompt: "system", messages } });

    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
  });
});
