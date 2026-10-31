import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

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

const model = makeProviderModelFixture({
  id: "grok-4.5",
  name: "Grok 4.5",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  contextWindow: 256_000,
  maxTokens: 8_192,
});

const openAIModel = {
  ...model,
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} satisfies Model;
const sourceText = "remember copper NORTH-SECRET-17";

function createSession(
  sessionModel: Model = model,
  providerReplay?: AssistantMessage["providerReplay"],
  userText = sourceText,
) {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({ role: "user", content: userText, timestamp: 1 });
  sessionManager.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "text", text: "remembered" }],
      api: sessionModel.api,
      provider: sessionModel.provider,
      model: sessionModel.id,
      providerReplay,
      timestamp: 2,
    }),
  );
  return { sessionManager, messages: branchMessages(sessionManager) };
}

function branchMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => structuredClone(entry.message) as AgentMessage);
}

function attempt(
  overrides: Partial<Parameters<typeof attemptServerEndpointCompaction>[0]> = {},
  session = createSession(overrides.model ?? model),
  systemPrompt = "system NORTH-SECRET-17",
) {
  return {
    session,
    result: attemptServerEndpointCompaction({
      trigger: "manual",
      streamFn: vi.fn(),
      model,
      context: { systemPrompt, messages: session.messages },
      sessionManager: session.sessionManager,
      extraParams: {},
      requestOptions: { apiKey: "test", sessionId: "session-1", timeoutMs: 1_000 },
      ...overrides,
    }),
  };
}

const compactionItem = () => ({ type: "compaction", id: "cmp_test", encrypted_content: "opaque" });
const compactionUsage = () => ({
  input_tokens: 1_000,
  output_tokens: 200,
  dropped_message_count: 1,
});
// The transport prices endpoint compaction like a normal Responses call.
const compactionModelUsage = () => ({
  input: 1_000,
  output: 200,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_200,
  usageReport: { state: "available" },
  cost: { input: 0.002, output: 0.0016, cacheRead: 0, cacheWrite: 0, total: 0.0036 },
});
function createCompactionResponse(responseModel: Model = model, userText = sourceText) {
  return {
    item: compactionItem(),
    output: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
      compactionItem(),
    ],
    historyMode: "retained-users",
    usage: compactionUsage(),
    modelUsage: compactionModelUsage(),
    model: responseModel,
    replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(responseModel, {
      sessionId: "session-1",
    }),
  };
}

function checkpointOwner(session: ReturnType<typeof createSession>) {
  const owner = session.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
    throw new Error("expected persisted assistant checkpoint owner");
  }
  return { id: owner.id, message: owner.message };
}

beforeEach(() => {
  requestPreparedCompactionMock.mockReset();
  requestPreparedCompactionMock.mockResolvedValue(createCompactionResponse());
});

it.each([
  ["default", undefined, true, undefined],
  ["disabled", { enabled: false }, false, undefined],
  ["explicit retries", { enabled: true, maxRetries: 2 }, true, 2],
] as const)("wires %s quality-guard settings", (_name, qualityGuard, enabled, maxRetries) => {
  const sessionManager = SessionManager.inMemory();
  const workspaceDir = "/tmp/openclaw-workspace";
  const factories = buildEmbeddedExtensionFactories({
    cfg: { agents: { defaults: { compaction: { mode: "safeguard", qualityGuard } } } },
    sessionManager,
    workspaceDir,
    model,
  });
  expect(factories).toContain(compactionSafeguardExtension);
  expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
    qualityGuardEnabled: enabled,
    qualityGuardMaxRetries: maxRetries,
    workspaceDir,
  });
});

describe("attemptServerEndpointCompaction", () => {
  it.each([
    { trigger: "manual", throws: false, model },
    { trigger: "manual", throws: true, model },
    { trigger: "manual", throws: false, model: openAIModel },
    { trigger: "budget", throws: false, model: openAIModel },
  ] as const)(
    "commits verbatim source text for $model.provider $trigger (observer throws=$throws)",
    async ({ trigger, throws, model: requestModel }) => {
      const warn = vi.spyOn(log, "warn").mockClear();
      const onUsage = vi.fn();
      requestPreparedCompactionMock.mockResolvedValueOnce(createCompactionResponse(requestModel));
      let committedOwner: ReturnType<SessionManager["getLeafEntry"]>;
      const observerError = new Error("committed observer failed");
      const onCompactionCommitted = vi.fn(() => {
        committedOwner = session.sessionManager.getLeafEntry();
        if (throws) {
          throw observerError;
        }
      });
      const request = { trigger, model: requestModel, onCompactionCommitted, onUsage };
      const { session, result } = attempt(request);

      if (throws) {
        await expect(result).rejects.toBe(observerError);
      } else {
        await expect(result).resolves.toMatchObject({
          item: compactionItem(),
          usage: compactionUsage(),
        });
      }
      const owner = checkpointOwner(session);
      expect(owner.message.content).toEqual([{ type: "text", text: "remembered" }]);
      expect(owner.message.providerReplay).toMatchObject({
        type: "openai-responses-retained-compaction",
        id: "cmp_test",
        data: "opaque",
        compactedWindow: {
          state: "ready",
          output: JSON.stringify(createCompactionResponse().output),
        },
      });
      expect(owner.message.providerReplay).not.toHaveProperty("replayIndex");
      expect(onUsage).toHaveBeenCalledExactlyOnceWith(compactionModelUsage());
      expect(warn).not.toHaveBeenCalled();
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
      ...createCompactionResponse(),
      output: [compactionItem()],
      historyMode: "compacted-prefix",
      usage: { input_tokens: 1_000, output_tokens: 200 },
    });
    const { session, result } = attempt();

    await expect(result).resolves.toBeDefined();
    expect(checkpointOwner(session).message.providerReplay?.replayIndex).toBe(1);
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

  it("does not call the endpoint during overflow recovery", async () => {
    const { result } = attempt({ trigger: "overflow" });
    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
  });

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
    const { result } = attempt({ trigger: "budget" }, session);

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

  it.each([
    ["fixed cost", false, 1_000, 0, 0],
    ["pending input", false, 0, 1_000, 0],
    ["output reserve", false, 0, 0, 1_000],
    ["covered history and fixed prompt", true, 1_000, 400, 400],
  ] as const)(
    "admits a returned window iff it fits after charging %s",
    async (_name, fits, fixedTokens, pendingTokens, reserveTokens) => {
      const userText = fits ? "old history ".repeat(4_000) : "source text ".repeat(400);
      const session = createSession(openAIModel, undefined, userText);
      const before = structuredClone(session.sessionManager.getBranch());
      const response = createCompactionResponse(openAIModel, fits ? sourceText : userText);
      requestPreparedCompactionMock.mockResolvedValueOnce(response);
      const onUsage = vi.fn();
      const onCompactionCommitted = vi.fn();
      const { result } = attempt(
        {
          trigger: "budget",
          model: openAIModel,
          requestBudget: {
            contextWindow: 2_000,
            fixedTokens,
            pendingTokens,
            reserveTokens,
          },
          onUsage,
          onCompactionCommitted,
        },
        session,
        fits ? "system ".repeat(400) : undefined,
      );

      const outcome = await result;
      expect(onUsage).toHaveBeenCalledOnce();
      if (fits) {
        expect(outcome).toBeDefined();
        expect(onCompactionCommitted).toHaveBeenCalledOnce();
        expect(session.sessionManager.getLeafEntry()).toMatchObject({
          type: "message",
          message: { providerReplay: { data: "opaque" } },
        });
      } else {
        expect(outcome).toBeUndefined();
        expect(onCompactionCommitted).not.toHaveBeenCalled();
        expect(session.sessionManager.getBranch()).toEqual(before);
      }
    },
  );

  it("does not compact transcript entries that remain after the checkpoint owner", async () => {
    const messages = createSession().messages.concat(makeUserMessage("trailing turn", 3));
    const { result } = attempt({ context: { systemPrompt: "system", messages } });

    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
  });
});
