import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { AssistantMessageEvent } from "../llm/types.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import * as mocks from "./btw.mocks.test-support.js";
import { guardModelFixtureWorkspace } from "./embedded-agent-runner/model.fixture.test-support.js";
import { resetModelGenerationFixtureState } from "./embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentHarness } from "./harness/types.js";
import { createUsageFixture } from "./test-helpers/usage-fixtures.js";
export let state: OpenClawTestState;
let workspaceGuard: ReturnType<typeof guardModelFixtureWorkspace>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "btw-model" });
});
beforeEach(() => {
  workspaceGuard = guardModelFixtureWorkspace(state.root);
});
afterEach(() => {
  try {
    workspaceGuard.verify();
  } finally {
    workspaceGuard.spy.mockRestore();
  }
});
afterAll(async () => {
  defaultPluginMetadataSnapshot = undefined;
  await state.cleanup();
});

const { runBtwSideQuestion } = await import("./btw.js");
const { clearAgentHarnesses, registerAgentHarness } = await import("./harness/registry.js");
type RunBtwSideQuestionParams = Parameters<typeof runBtwSideQuestion>[0];

export const DEFAULT_AGENT_DIR = "/tmp/agent";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_REASONING_LEVEL = "off";
export const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_STORE_PATH = "/tmp/sessions.json";
export const DEFAULT_QUESTION = "What changed?";
const MATH_QUESTION = "What is 17 * 19?";
export const MATH_ANSWER = "323";
let defaultPluginMetadataSnapshot: ReturnType<typeof resolvePluginMetadataSnapshot> | undefined;

const DEFAULT_USAGE = createUsageFixture(1, 2, 3);

export function makeAsyncEvents(events: unknown[]) {
  // Minimal async iterable that matches provider stream shape without loading
  // real model/runtime infrastructure.
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

export function createSessionEntry(overrides: Partial<SessionEntry> = {}) {
  return {
    sessionId: "session-1",
    sessionFile: "session-1.jsonl",
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function createDoneEvent(text: string): Extract<AssistantMessageEvent, { type: "done" }> {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      provider: DEFAULT_PROVIDER,
      api: "anthropic-messages",
      model: DEFAULT_MODEL,
      stopReason: "stop",
      usage: DEFAULT_USAGE,
      timestamp: Date.now(),
    },
  };
}

export function mockDoneAnswer(text: string) {
  mocks.streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent(text)]));
}

export function createCliRuntimeConfig(): Parameters<typeof runBtwSideQuestion>[0]["cfg"] {
  return createRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli");
}

export function createRuntimeConfig(model: string, id: string) {
  return { agents: { defaults: { models: { [model]: { agentRuntime: { id } } } } } };
}

export function createOpenAIModel(subscription = false) {
  return {
    provider: "openai",
    id: "gpt-5.5",
    api: subscription ? ("openai-chatgpt-responses" as const) : ("openai-responses" as const),
    baseUrl: subscription ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
  };
}

export function mockResolvedModel(model: ReturnType<typeof createOpenAIModel>) {
  mocks.resolveModelWithRegistryMock.mockReturnValue(model);
  mocks.resolveModelAsyncMock.mockResolvedValue({ model });
}

export function mockCliOutput(output: { text: string; rawText?: string }) {
  const cleanup = vi.fn(async () => undefined);
  const prepared = { prepared: true, preparedBackend: { cleanup } };
  mocks.prepareCliRunContextMock.mockResolvedValueOnce(prepared);
  mocks.executePreparedCliRunMock.mockResolvedValueOnce(output);
  return { cleanup, prepared };
}

export function registerCodexSideQuestionHarness(
  overrides: Partial<
    Pick<AgentHarness, "authBootstrap" | "supports" | "resolveSessionRuntimeOwnershipAsync">
  > = {},
) {
  const runHarnessSideQuestion = vi.fn().mockResolvedValue({ text: "Codex side answer." });
  registerAgentHarness({
    id: "codex",
    label: "Codex test harness",
    supports: () => ({ supported: true, priority: 100 }),
    runAttempt: vi.fn(),
    runSideQuestion: runHarnessSideQuestion,
    ...overrides,
  });
  return runHarnessSideQuestion;
}

export function supportsPreparedOpenAIAuth(ctx: Parameters<AgentHarness["supports"]>[0]) {
  if (ctx.provider !== "openai") {
    return { supported: false as const, reason: "Codex only supports OpenAI providers" };
  }
  const preparedAuth = ctx.modelProvider?.preparedAuth;
  if (preparedAuth?.requirement === "subscription") {
    return preparedAuth.source === "profile" &&
      (preparedAuth.mode === "oauth" || preparedAuth.mode === "token")
      ? { supported: true as const, priority: 100 }
      : { supported: false as const, reason: "subscription auth is not reproducible" };
  }
  if (preparedAuth?.requirement === "api-key") {
    return preparedAuth.source !== "none" &&
      preparedAuth.source !== "harness" &&
      (preparedAuth.mode === "api-key" || preparedAuth.mode === "api_key")
      ? { supported: true as const, priority: 100 }
      : { supported: false as const, reason: "Platform auth is not reproducible" };
  }
  return { supported: true as const, priority: 100 };
}

export function createSideQuestionParams(
  overrides: Partial<RunBtwSideQuestionParams> = {},
): RunBtwSideQuestionParams {
  return {
    cfg: { agents: { entries: { main: {} } } },
    agentId: "main",
    agentDir: DEFAULT_AGENT_DIR,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    question: DEFAULT_QUESTION,
    sessionEntry: createSessionEntry(),
    sessionKey: DEFAULT_SESSION_KEY,
    storePath: DEFAULT_STORE_PATH,
    resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
    opts: {},
    isNewSession: false,
    ...overrides,
  };
}

export function runSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runBtwSideQuestion(createSideQuestionParams(overrides));
}

export function runMathSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runSideQuestion({ question: MATH_QUESTION, ...overrides });
}

export function clearBuiltSessionMessages() {
  mocks.buildSessionContextMock.mockReturnValue({ messages: [] });
}

export function createUserTranscriptMessage(content: unknown[] = [{ type: "text", text: "seed" }]) {
  return { role: "user", content, timestamp: 1 };
}

export function createAssistantTranscriptMessage(
  content: unknown,
  overrides: {
    stopReason?: string;
    output?: number;
    timestamp?: number;
  } = {},
) {
  return {
    role: "assistant",
    content,
    provider: DEFAULT_PROVIDER,
    api: "anthropic-messages",
    model: DEFAULT_MODEL,
    stopReason: overrides.stopReason ?? "stop",
    usage: {
      ...DEFAULT_USAGE,
      output: overrides.output ?? DEFAULT_USAGE.output,
      totalTokens: 1 + (overrides.output ?? DEFAULT_USAGE.output),
    },
    timestamp: overrides.timestamp ?? 2,
  };
}

export function createTranscriptEntry({
  id,
  parentId = null,
  message,
}: {
  id: string;
  parentId?: string | null;
  message: unknown;
}) {
  return { type: "message", id, parentId, message };
}

export function mockTranscriptEntries(entries: unknown[]) {
  mocks.parseSessionEntriesMock.mockReturnValue(entries);
  mocks.loadTranscriptEventsMock.mockResolvedValue(entries);
}

export function mockActiveTranscript(messages: unknown[]) {
  mocks.getActiveEmbeddedRunSnapshotMock.mockReturnValue({
    transcriptLeafId: "assistant-1",
    messages,
  });
}

export function mockCall(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex + 1}`);
  }
  return call;
}

export function mockArg(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex: number,
  argIndex: number,
): unknown {
  return mockCall(mockFn, callIndex)[argIndex];
}

export function harnessParams(mock: Parameters<typeof mockArg>[0]) {
  return mockArg(mock, 0, 0) as Parameters<NonNullable<AgentHarness["runSideQuestion"]>>[0];
}

export function expectPreparedAuthSupport(
  mock: Parameters<typeof mockArg>[0],
  preparedAuth: Record<string, unknown>,
) {
  expect(mock).toHaveBeenCalledWith(
    expect.objectContaining({ modelProvider: expect.objectContaining({ preparedAuth }) }),
  );
}

export async function runMathSideQuestionAndCaptureContext() {
  mockDoneAnswer(MATH_ANSWER);
  await runMathSideQuestion();
  return mockArg(mocks.streamSimpleMock, 0, 1);
}

export function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function streamContext(callIndex = 0): {
  messages?: Array<Record<string, unknown>>;
  systemPrompt?: unknown;
} {
  return (mockArg(mocks.streamSimpleMock, callIndex, 1) ?? {}) as {
    messages?: Array<Record<string, unknown>>;
    systemPrompt?: unknown;
  };
}

export function contextMessages(context: unknown): Array<Record<string, unknown>> {
  const messages = (context as { messages?: Array<Record<string, unknown>> }).messages;
  if (!messages) {
    throw new Error("Expected BTW context messages");
  }
  return messages;
}

export function expectTextBlockContains(block: unknown, text: string): void {
  expectRecordFields(block, { type: "text", text: expect.stringContaining(text) });
}

export function expectNoAssistantMessages(context: unknown) {
  expect(
    (context as { messages?: Array<{ role?: string }> }).messages?.filter(
      (message) => message.role === "assistant",
    ),
  ).toHaveLength(0);
}

export function expectSanitizedAssistantContext(context: unknown, text: string) {
  expect(contextMessages(context)).toEqual([
    expect.objectContaining({ role: "user" }),
    expect.objectContaining({ role: "assistant", content: [{ type: "text", text }] }),
    expect.objectContaining({ role: "user" }),
  ]);
}

export function expectSeedOnlyUserContext(context: unknown) {
  expect(contextMessages(context)).toEqual([
    expect.objectContaining({ role: "user", content: [{ type: "text", text: "seed" }] }),
    expect.objectContaining({ role: "user" }),
  ]);
}

export function mockOpenAIPlatformProfile(): void {
  mocks.ensureAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      "profile-1": createApiKeyCredential("openai", "platform-key"),
    },
    order: { openai: ["profile-1"] },
  });
}

export function setupBtwTestHooks() {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelGenerationFixtureState();
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (vi.isMockFunction(mock)) {
        mock.mockReset();
      }
    }
    mocks.snapshotResources.acquire = undefined;
    mocks.getModelRegistryRuntimeMock.mockReturnValue({
      apiRegistry: {},
      llmRuntime: { streamSimple: mocks.streamSimpleMock },
    });
    mocks.listSessionEntriesCoreMock.mockReturnValue([]);
    mocks.loadSessionEntryMock.mockReturnValue(undefined);
    mocks.shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
    mocks.hasUsableCustomProviderApiKeyMock.mockReturnValue(false);
    mocks.resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "none" });
    clearAgentHarnesses();
    if (!defaultPluginMetadataSnapshot) {
      defaultPluginMetadataSnapshot = resolvePluginMetadataSnapshot({
        config: {},
        workspaceDir: state.workspaceDir,
        allowCurrent: false,
      });
      expect(workspaceGuard.spy).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: state.workspaceDir }),
      );
    }
    mocks.preparedRuntimeSnapshotState.snapshot = {
      metadataSnapshot: defaultPluginMetadataSnapshot,
    };
    mocks.preparedRuntimeSnapshotState.useSnapshotPluginRegistry = false;

    mocks.loadTranscriptEventsMock.mockResolvedValue([]);
    mockTranscriptEntries([
      createTranscriptEntry({
        id: "user-1",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      }),
      createTranscriptEntry({
        id: "assistant-1",
        parentId: "user-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          timestamp: 2,
        },
      }),
    ]);
    mocks.buildSessionContextMock.mockImplementation(
      (entries: Array<{ message?: unknown }> = []) => {
        return { messages: entries.flatMap((entry) => (entry.message ? [entry.message] : [])) };
      },
    );
    mocks.resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    mocks.resolveModelAsyncMock.mockImplementation(async () => ({
      model: mocks.resolveModelWithRegistryMock(),
    }));
    mocks.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    mocks.ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      version: 1,
      profiles: {},
    });
    mocks.getApiKeyForModelMock.mockImplementation(async (params: { profileId?: string } = {}) => ({
      apiKey: "secret",
      mode: "api-key",
      source: params.profileId ? `profile:${params.profileId}` : "test",
      ...(params.profileId ? { profileId: params.profileId } : {}),
    }));
    mocks.requireApiKeyMock.mockReturnValue("secret");
    mocks.resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-1",
      source: "auto",
      routeRequirement: undefined,
    });
    mocks.getActiveEmbeddedRunSnapshotMock.mockReturnValue(undefined);
    mocks.resolveSessionAgentIdMock.mockReturnValue("main");
    mocks.resolveSessionAgentIdsMock.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "main",
    });
    mocks.resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    mocks.listAgentEntriesMock.mockReturnValue([]);
    mocks.prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
    mocks.registerProviderStreamForModelMock.mockReturnValue(undefined);
    mocks.resolveEmbeddedAgentStreamMock.mockImplementation(
      (params: { currentStreamFn: unknown; providerStreamFn?: unknown }) => {
        return {
          streamFn: params.providerStreamFn ?? params.currentStreamFn,
          strategy: "session-custom",
        };
      },
    );
  });
}

export * from "./btw.mocks.test-support.js";

export { runBtwSideQuestion };

export { registerAgentHarness };
