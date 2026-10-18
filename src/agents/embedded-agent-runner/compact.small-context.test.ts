import type { Model } from "@openclaw/llm-core";
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
import { extractTextContent } from "../sessions/agent-session-utils.js";
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
let manager: SessionManager;
let model: Model;
let settingsManager: SettingsManager;
let systemPrompt: string | undefined;
let args: Parameters<typeof compact>[0];
const summary = "The code word is copper.";
const summaryStream = vi.fn((activeModel: Model) =>
  createAssistantResultStream(createAssistant(activeModel, [{ type: "text", text: summary }])),
);
registerAgentSessionLoopTestLifecycle();

beforeAll(async () => {
  compact = (await loadCompactHooksHarness()).compactEmbeddedAgentSessionDirect;
  storePath = await fixture.prepare();
});
beforeEach(async () => {
  const { guardSessionManager } = await import("../session-tool-result-guard-wrapper.js");
  const { createAgentSession } = await import("../sessions/sdk.js");
  const { resolveEmbeddedAgentStream } = await import("./stream-resolution.js");
  prepared = await fixture.prepareSession();
  compactEndpoint.mockReset();
  summaryStream.mockClear();
  model = { ...testModel, contextWindow: 32_768, maxTokens: 1_024 };
  manager = SessionManager.inMemory(prepared.workspaceDir);
  systemPrompt = undefined;
  settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 300, reserveTokens: 1_024 },
    retry: { enabled: false },
  });
  resolveContextWindowInfoMock.mockImplementation(() => ({ tokens: model.contextWindow }));
  resolveModelMock.mockImplementation(() => ({ ...createCompactHooksResolvedModel(), model }));
  limitHistoryTurnsMock.mockImplementation((messages) => messages);
  vi.mocked(guardSessionManager).mockImplementation(() => manager);
  vi.mocked(createAgentSession).mockImplementation((options) =>
    createTestSession({
      model: options.model,
      systemPrompt,
      sessionManager: manager,
      settingsManager,
    }),
  );
  vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
    streamFn: summaryStream,
    strategy: "session-custom",
  });
  args = {
    agentId: "main",
    sessionId: prepared.sessionId,
    sessionKey,
    sessionFile: sessionKey,
    sessionTarget: { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath },
    workspaceDir: prepared.workspaceDir,
    config: {},
    provider: model.provider,
    model: model.id,
  };
});

function appendDocuments(count: number, source: string) {
  for (let turn = 0; turn < count; turn++) {
    manager.appendMessage({
      role: "user",
      content: `Remember code word copper. Document ${turn}.\n${source}`,
      timestamp: turn * 2 + 1,
    });
    manager.appendMessage(createAssistant(model, [{ type: "text", text: "ACK" }]));
  }
}

it("summarizes with the model window instead of a smaller session token budget", async () => {
  appendDocuments(8, "older context ".repeat(200));
  const result = await compact({
    ...args,
    trigger: "manual",
    force: true,
    tokenBudget: 512,
  });

  expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
  expect(manager.buildSessionContext().messages[0]).toMatchObject({
    role: "compactionSummary",
    summary: expect.stringContaining(summary),
  });
});

it("reclaims retained source turns when the endpoint cannot fit a small foreground window", async () => {
  const { attachCompactionAccountingRecorder } =
    await import("./run/compaction-accounting-bridge.js");
  const { attemptServerEndpointCompaction } = await vi.importActual<
    typeof import("./server-endpoint-compaction.js")
  >("./server-endpoint-compaction.js");
  model = {
    ...testModel,
    provider: "openai",
    id: "gpt-5.6-sol",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 1_050_000,
    maxTokens: 1_024,
  };
  const contextTokens = 40_000;
  systemPrompt = "Follow the project rules and preserve the code word.\n".repeat(1_100);
  appendDocuments(3, "The module implements a deterministic source transform.\n".repeat(600));
  const original = structuredClone(manager.getBranch());
  settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 20_000, reserveTokens: 10_000 },
    retry: { enabled: false },
  });
  resolveContextWindowInfoMock.mockReturnValue({ tokens: contextTokens });
  buildConfiguredAgentSystemPromptMock.mockReturnValue(systemPrompt);
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
                text: extractTextContent(message.content),
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
  const requestBudget = createCompactionRequestBudget({
    contextWindow: contextTokens,
    reserveTokens: 10_000,
    systemPrompt,
    pendingPrompt: "What is the code word?",
  });
  const contextEngineRuntimeContext = {};
  attachCompactionAccountingRecorder(contextEngineRuntimeContext, { requestBudget });
  const { provider: _provider, api: _api, baseUrl, ...configuredModel } = model;
  args = {
    ...args,
    provider: model.provider,
    model: model.id,
    config: {
      models: {
        providers: {
          openai: {
            baseUrl,
            models: [{ ...configuredModel, contextTokens, reasoning: false, input: ["text"] }],
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
  streamMocks.streamSimple.mockImplementation((activeModel, context) => {
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
