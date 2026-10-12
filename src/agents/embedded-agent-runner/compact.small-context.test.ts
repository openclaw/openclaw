import type { Context, Model } from "@openclaw/llm-core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testing } from "../openai-transport-stream.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { createCompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  attemptServerEndpointCompactionMock,
  buildConfiguredAgentSystemPromptMock,
  limitHistoryTurnsMock,
  loadCompactHooksHarness,
  resolveContextWindowInfoMock,
  resolveModelMock,
} from "./compact.hooks.harness.js";
import { createCompactHooksResolvedModel } from "./compact.hooks.metadata.test-support.js";

const { compactEndpoint } = vi.hoisted(() => ({
  compactEndpoint:
    vi.fn<typeof import("@openclaw/ai/transports").requestPreparedOpenAIResponsesCompaction>(),
}));
vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  requestPreparedOpenAIResponsesCompaction: compactEndpoint,
}));

const sessionKey = "agent:main:small-window";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSessionDirect"];
let storePath: string;
let prepared: Awaited<ReturnType<typeof fixture.prepareSession>>;
registerAgentSessionLoopTestLifecycle();

beforeAll(async () => {
  compact = (await loadCompactHooksHarness()).compactEmbeddedAgentSessionDirect;
  storePath = await fixture.prepare();
});
beforeEach(async () => {
  prepared = await fixture.prepareSession();
  compactEndpoint.mockReset();
});

it("reclaims retained source turns when the endpoint cannot fit a small foreground window", async () => {
  const { guardSessionManager } = await import("../session-tool-result-guard-wrapper.js");
  const { createAgentSession } = await import("../sessions/sdk.js");
  const { resolveEmbeddedAgentStream } = await import("./stream-resolution.js");
  const { attachCompactionAccountingRecorder } =
    await import("./run/compaction-accounting-bridge.js");
  const { attemptServerEndpointCompaction } = await vi.importActual<
    typeof import("./server-endpoint-compaction.js")
  >("./server-endpoint-compaction.js");
  const model: Model = {
    ...testModel,
    provider: "openai",
    id: "gpt-5.6-sol",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 1_050_000,
    maxTokens: 1_024,
  };
  const contextTokens = 40_000;
  const systemPrompt = "Follow the project rules and preserve the code word.\n".repeat(1_100);
  let manager = SessionManager.inMemory(prepared.workspaceDir);
  const source = "The module implements a deterministic source transform.\n".repeat(600);
  for (let turn = 0; turn < 3; turn++) {
    manager.appendMessage({
      role: "user",
      content: `Remember code word copper. Document ${turn}.\n${source}`,
      timestamp: turn * 2 + 1,
    });
    manager.appendMessage(createAssistant(model, [{ type: "text", text: "ACK" }]));
  }
  const original = structuredClone(manager.getBranch());
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 20_000, reserveTokens: 10_000 },
    retry: { enabled: false },
  });
  resolveContextWindowInfoMock.mockReturnValue({ tokens: contextTokens });
  resolveModelMock.mockImplementation(() => ({ ...createCompactHooksResolvedModel(), model }));
  buildConfiguredAgentSystemPromptMock.mockReturnValue(systemPrompt);
  limitHistoryTurnsMock.mockImplementation((messages) => messages);
  vi.mocked(guardSessionManager).mockReturnValue(manager);
  vi.mocked(createAgentSession).mockImplementation(() =>
    createTestSession({ model, systemPrompt, sessionManager: manager, settingsManager }),
  );
  attemptServerEndpointCompactionMock.mockImplementation(attemptServerEndpointCompaction);
  compactEndpoint.mockImplementation(async (_stream, endpointModel: Model, context, options) => {
    const item = { type: "compaction" as const, id: "cmp_retained", encrypted_content: "opaque" };
    return {
      item,
      output: [
        ...context.messages
          .filter((message) => message.role === "user")
          .map((message) => ({
            type: "message" as const,
            role: "user" as const,
            content: [
              {
                type: "input_text" as const,
                text:
                  typeof message.content === "string"
                    ? message.content
                    : message.content
                        .filter((block) => block.type === "text")
                        .map((block) => block.text)
                        .join(""),
              },
            ],
          })),
        item,
      ],
      historyMode: "retained-users" as const,
      usage: { input_tokens: 45_000, output_tokens: 10 },
      model: endpointModel,
      replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(endpointModel, options),
    };
  });
  const summary = "The code word is copper. Three source documents were acknowledged.";
  const summaryStream = vi.fn((activeModel: Model) =>
    createAssistantResultStream(createAssistant(activeModel, [{ type: "text", text: summary }])),
  );
  vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
    streamFn: summaryStream,
    strategy: "session-custom",
  });
  const requestBudget = createCompactionRequestBudget({
    contextWindow: contextTokens,
    reserveTokens: 10_000,
    systemPrompt,
    pendingPrompt: "What is the code word?",
  });
  const contextEngineRuntimeContext = {};
  attachCompactionAccountingRecorder(contextEngineRuntimeContext, { requestBudget });
  const args: Parameters<typeof compact>[0] = {
    agentId: "main",
    sessionId: prepared.sessionId,
    sessionKey,
    sessionFile: sessionKey,
    sessionTarget: { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath },
    workspaceDir: prepared.workspaceDir,
    provider: model.provider,
    model: model.id,
    config: {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: model.id,
                name: model.name,
                contextWindow: model.contextWindow,
                contextTokens,
                maxTokens: model.maxTokens,
                reasoning: false,
                input: ["text"],
                cost: model.cost,
              },
            ],
          },
        },
      },
    },
  };

  // Focused manual compaction is the client control: the exact original history is compactable.
  const manual = await compact({
    ...args,
    trigger: "manual",
    customInstructions: "Preserve the code word.",
  });
  expect(manual, manual.reason).toMatchObject({ ok: true, compacted: true });
  expect(compactEndpoint).not.toHaveBeenCalled();
  expect(summaryStream).toHaveBeenCalled();
  manager = SessionManager.fromEntries([manager.getHeader(), ...original], prepared.workspaceDir);
  vi.mocked(guardSessionManager).mockReturnValue(manager);
  summaryStream.mockClear();

  const result = await compact({ ...args, trigger: "budget", contextEngineRuntimeContext });
  expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
  expect(result.result).toMatchObject({ summary: expect.stringContaining(summary) });
  expect(compactEndpoint).toHaveBeenCalledOnce();
  expect(summaryStream).toHaveBeenCalled();
  expect(
    manager.buildSessionContext().messages.filter((message) => message.role === "user").length,
  ).toBeLessThan(3);

  const requests: number[] = [];
  streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
    const tokens = Math.ceil(
      JSON.stringify({ system: context.systemPrompt, messages: context.messages }).length / 4,
    );
    requests.push(tokens);
    return createAssistantResultStream(
      createAssistant(activeModel, [{ type: "text", text: "copper" }], "stop", tokens),
    );
  });
  const { session } = await createTestSession({
    model,
    systemPrompt,
    sessionManager: manager,
    settingsManager,
  });
  await session.prompt("What is the code word?");
  await session.prompt("Reply with the code word again.");
  expect(session.getLastAssistantText()).toBe("copper");
  expect(requests).toHaveLength(2);
  expect(requests.every((tokens) => tokens < contextTokens - 10_000)).toBe(true);
});
