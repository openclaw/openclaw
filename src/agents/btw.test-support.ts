import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import {
  streamSimpleMock,
  readFileMock,
  parseSessionEntriesMock,
  migrateSessionEntriesMock,
  buildSessionContextMock,
  ensureOpenClawModelsJsonMock,
  loadPreparedModelRuntimeSnapshotMock,
  snapshotResources,
  discoverAuthStorageMock,
  discoverModelsMock,
  getModelRegistryRuntimeMock,
  resolveModelWithRegistryMock,
  ensureAuthProfileStoreMock,
  ensureAuthProfileStoreWithoutExternalProfilesMock,
  resolveModelAsyncMock,
  getApiKeyForModelMock,
  requireApiKeyMock,
  resolveSessionAuthSelectionMock,
  getActiveEmbeddedRunSnapshotMock,
  resolveSessionAgentIdMock,
  resolveSessionAgentIdsMock,
  resolveAgentWorkspaceDirMock,
  listAgentEntriesMock,
  prepareProviderRuntimeAuthMock,
  registerProviderStreamForModelMock,
  resolveEmbeddedAgentStreamMock,
  prepareCliRunContextMock,
  executePreparedCliRunMock,
  diagDebugMock,
  ensureSelectedAgentHarnessPluginMock,
  createAgentHarnessHostCapabilitiesMock,
  closeAgentHarnessHostCapabilitiesMock,
  listSessionEntriesCoreMock,
  loadSessionEntryMock,
  loadTranscriptEventsMock,
  shouldPreferExplicitConfigApiKeyAuthMock,
  hasUsableCustomProviderApiKeyMock,
  resolveProviderEntryApiKeyProfileReferenceMock,
  preparedRuntimeSnapshotState,
} from "./btw.mocks.test-support.js";
import { guardModelFixtureWorkspace } from "./embedded-agent-runner/model.fixture.test-support.js";
import { resetModelGenerationFixtureState } from "./embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentHarness } from "./harness/types.js";
let state: OpenClawTestState;
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

const DEFAULT_AGENT_DIR = "/tmp/agent";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_REASONING_LEVEL = "off";
const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_STORE_PATH = "/tmp/sessions.json";
const DEFAULT_QUESTION = "What changed?";
const MATH_QUESTION = "What is 17 * 19?";
const MATH_ANSWER = "323";
let defaultPluginMetadataSnapshot: ReturnType<typeof resolvePluginMetadataSnapshot> | undefined;

const DEFAULT_USAGE = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAsyncEvents(events: unknown[]) {
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

function createSessionEntry(overrides: Partial<SessionEntry> = {}) {
  return {
    sessionId: "session-1",
    sessionFile: "session-1.jsonl",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createAssistantDoneEvent(content: unknown[]) {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content,
      provider: DEFAULT_PROVIDER,
      api: "anthropic-messages",
      model: DEFAULT_MODEL,
      stopReason: "stop",
      usage: DEFAULT_USAGE,
      timestamp: Date.now(),
    },
  };
}

function createDoneEvent(text: string) {
  return createAssistantDoneEvent([{ type: "text", text }]);
}

function createThinkingOnlyDoneEvent(thinking: string) {
  return createAssistantDoneEvent([{ type: "thinking", thinking }]);
}

function mockDoneAnswer(text: string) {
  streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent(text)]));
}

function mockCliOutput(output: { text: string; rawText?: string }) {
  const cleanup = vi.fn(async () => undefined);
  const prepared = { prepared: true, preparedBackend: { cleanup } };
  prepareCliRunContextMock.mockResolvedValueOnce(prepared);
  executePreparedCliRunMock.mockResolvedValueOnce(output);
  return { cleanup, prepared };
}

function registerCodexSideQuestionHarness(
  overrides: Partial<Pick<AgentHarness, "authBootstrap" | "supports">> = {},
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

function supportsPreparedOpenAIAuth(ctx: Parameters<AgentHarness["supports"]>[0]) {
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

function createSideQuestionParams(
  overrides: Partial<RunBtwSideQuestionParams> = {},
): RunBtwSideQuestionParams {
  return {
    cfg: { agents: { entries: { main: { default: true } } } } as never,
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

function runSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runBtwSideQuestion(createSideQuestionParams(overrides));
}

function runMathSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runSideQuestion({
    question: MATH_QUESTION,
    ...overrides,
  });
}

function clearBuiltSessionMessages() {
  buildSessionContextMock.mockReturnValue({ messages: [] });
}

function createUserTranscriptMessage(content: unknown[] = [{ type: "text", text: "seed" }]) {
  return {
    role: "user",
    content,
    timestamp: 1,
  };
}

function createAssistantTranscriptMessage(
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

function createTranscriptEntry(params: { id: string; parentId?: string | null; message: unknown }) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    message: params.message,
  };
}

function mockTranscriptEntries(entries: unknown[]) {
  parseSessionEntriesMock.mockReturnValue(entries);
  loadTranscriptEventsMock.mockResolvedValue(entries);
}

function mockActiveTranscript(messages: unknown[]) {
  getActiveEmbeddedRunSnapshotMock.mockReturnValue({
    transcriptLeafId: "assistant-1",
    messages,
  });
}

function mockCall(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex + 1}`);
  }
  return call;
}

function mockArg(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex: number,
  argIndex: number,
): unknown {
  return mockCall(mockFn, callIndex)[argIndex];
}

async function runMathSideQuestionAndCaptureContext() {
  mockDoneAnswer(MATH_ANSWER);
  await runMathSideQuestion();
  const context = mockArg(streamSimpleMock, 0, 1);
  return context;
}

function expectRecordFields(
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

function streamContext(callIndex = 0): {
  messages?: Array<Record<string, unknown>>;
  systemPrompt?: unknown;
} {
  const call = streamSimpleMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected streamSimple call at index ${callIndex}`);
  }
  return (call[1] ?? {}) as {
    messages?: Array<Record<string, unknown>>;
    systemPrompt?: unknown;
  };
}

function contextMessages(context: unknown): Array<Record<string, unknown>> {
  const messages = (context as { messages?: Array<Record<string, unknown>> }).messages;
  if (!messages) {
    throw new Error("Expected BTW context messages");
  }
  return messages;
}

function expectTextBlockContains(block: unknown, text: string): void {
  const record = expectRecordFields(block, { type: "text" });
  expect(typeof record.text).toBe("string");
  expect(record.text).toContain(text);
}

function firstTextBlockIncludes(message: Record<string, unknown>, text: string): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  const [block] = message.content;
  const blockText = (block as { text?: unknown } | undefined)?.text;
  return typeof blockText === "string" && blockText.includes(text);
}

function expectNoAssistantMessages(context: unknown) {
  expect(
    (context as { messages?: Array<{ role?: string }> }).messages?.filter(
      (message) => message.role === "assistant",
    ),
  ).toHaveLength(0);
}

function expectSanitizedAssistantContext(context: unknown, text: string) {
  const messages = contextMessages(context);
  expect(messages).toHaveLength(3);
  expectRecordFields(messages[0], { role: "user" });
  expectRecordFields(messages[1], {
    role: "assistant",
    content: [{ type: "text", text }],
  });
  expectRecordFields(messages[2], { role: "user" });
}

function expectSeedOnlyUserContext(context: unknown) {
  const messages = contextMessages(context);
  expect(messages).toHaveLength(2);
  expectRecordFields(messages[0], {
    role: "user",
    content: [{ type: "text", text: "seed" }],
  });
  expectRecordFields(messages[1], { role: "user" });
}

function mockOpenAIPlatformProfile(): void {
  ensureAuthProfileStoreMock.mockReturnValue({
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
    streamSimpleMock.mockReset();
    readFileMock.mockReset();
    parseSessionEntriesMock.mockReset();
    migrateSessionEntriesMock.mockReset();
    buildSessionContextMock.mockReset();
    ensureOpenClawModelsJsonMock.mockReset();
    loadPreparedModelRuntimeSnapshotMock.mockReset();
    snapshotResources.acquire = undefined;
    discoverAuthStorageMock.mockReset();
    discoverModelsMock.mockReset();
    getModelRegistryRuntimeMock.mockReset();
    getModelRegistryRuntimeMock.mockReturnValue({
      apiRegistry: {},
      llmRuntime: { streamSimple: streamSimpleMock },
    });
    resolveModelAsyncMock.mockReset();
    resolveModelWithRegistryMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReset();
    getApiKeyForModelMock.mockReset();
    requireApiKeyMock.mockReset();
    resolveSessionAuthSelectionMock.mockReset();
    getActiveEmbeddedRunSnapshotMock.mockReset();
    resolveSessionAgentIdMock.mockReset();
    resolveSessionAgentIdsMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    listAgentEntriesMock.mockReset();
    prepareProviderRuntimeAuthMock.mockReset();
    registerProviderStreamForModelMock.mockReset();
    resolveEmbeddedAgentStreamMock.mockReset();
    prepareCliRunContextMock.mockReset();
    executePreparedCliRunMock.mockReset();
    diagDebugMock.mockReset();
    ensureSelectedAgentHarnessPluginMock.mockReset();
    createAgentHarnessHostCapabilitiesMock.mockReset();
    closeAgentHarnessHostCapabilitiesMock.mockReset();
    listSessionEntriesCoreMock.mockReset();
    listSessionEntriesCoreMock.mockReturnValue([]);
    loadSessionEntryMock.mockReset();
    loadSessionEntryMock.mockReturnValue(undefined);
    loadTranscriptEventsMock.mockReset();
    shouldPreferExplicitConfigApiKeyAuthMock.mockReset();
    shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
    hasUsableCustomProviderApiKeyMock.mockReset();
    hasUsableCustomProviderApiKeyMock.mockReturnValue(false);
    resolveProviderEntryApiKeyProfileReferenceMock.mockReset();
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "none" });
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
    preparedRuntimeSnapshotState.snapshot = {
      metadataSnapshot: defaultPluginMetadataSnapshot,
    };
    preparedRuntimeSnapshotState.useSnapshotPluginRegistry = false;

    readFileMock.mockResolvedValue("mock transcript");
    loadTranscriptEventsMock.mockResolvedValue([]);
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
    buildSessionContextMock.mockImplementation((entries: Array<{ message?: unknown }> = []) => {
      return { messages: entries.flatMap((entry) => (entry.message ? [entry.message] : [])) };
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    resolveModelAsyncMock.mockImplementation(async () => ({
      model: resolveModelWithRegistryMock(),
    }));
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({ version: 1, profiles: {} });
    getApiKeyForModelMock.mockImplementation(async (params: { profileId?: string } = {}) => ({
      apiKey: "secret",
      mode: "api-key",
      source: params.profileId ? `profile:${params.profileId}` : "test",
      ...(params.profileId ? { profileId: params.profileId } : {}),
    }));
    requireApiKeyMock.mockReturnValue("secret");
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-1",
      source: "auto",
      routeRequirement: undefined,
    });
    getActiveEmbeddedRunSnapshotMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("main");
    resolveSessionAgentIdsMock.mockReturnValue({ defaultAgentId: "main", sessionAgentId: "main" });
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    listAgentEntriesMock.mockReturnValue([]);
    prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
    registerProviderStreamForModelMock.mockReturnValue(undefined);
    resolveEmbeddedAgentStreamMock.mockImplementation(
      (params: { currentStreamFn: unknown; providerStreamFn?: unknown }) => {
        return {
          streamFn: params.providerStreamFn ?? params.currentStreamFn,
          strategy: "session-custom",
        };
      },
    );
  });
}

export {
  state,
  runBtwSideQuestion,
  registerAgentHarness,
  DEFAULT_AGENT_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_SESSION_KEY,
  DEFAULT_STORE_PATH,
  DEFAULT_QUESTION,
  MATH_QUESTION,
  MATH_ANSWER,
  makeAsyncEvents,
  createSessionEntry,
  createAssistantDoneEvent,
  createDoneEvent,
  createThinkingOnlyDoneEvent,
  mockDoneAnswer,
  mockCliOutput,
  registerCodexSideQuestionHarness,
  supportsPreparedOpenAIAuth,
  createSideQuestionParams,
  runSideQuestion,
  runMathSideQuestion,
  clearBuiltSessionMessages,
  createUserTranscriptMessage,
  createAssistantTranscriptMessage,
  createTranscriptEntry,
  mockTranscriptEntries,
  mockActiveTranscript,
  mockCall,
  mockArg,
  runMathSideQuestionAndCaptureContext,
  expectRecordFields,
  streamContext,
  contextMessages,
  expectTextBlockContains,
  firstTextBlockIncludes,
  expectNoAssistantMessages,
  expectSanitizedAssistantContext,
  expectSeedOnlyUserContext,
  mockOpenAIPlatformProfile,
};
export {
  streamSimpleMock,
  readFileMock,
  buildSessionContextMock,
  ensureOpenClawModelsJsonMock,
  loadPreparedModelRuntimeSnapshotMock,
  snapshotResources,
  discoverAuthStorageMock,
  discoverModelsMock,
  resolveModelWithRegistryMock,
  ensureAuthProfileStoreMock,
  ensureAuthProfileStoreWithoutExternalProfilesMock,
  resolveModelAsyncMock,
  getApiKeyForModelMock,
  requireApiKeyMock,
  resolveSessionAuthSelectionMock,
  getActiveEmbeddedRunSnapshotMock,
  resolveSessionAgentIdMock,
  resolveAgentWorkspaceDirMock,
  prepareProviderRuntimeAuthMock,
  registerProviderStreamForModelMock,
  resolveEmbeddedAgentStreamMock,
  prepareCliRunContextMock,
  executePreparedCliRunMock,
  diagDebugMock,
  ensureSelectedAgentHarnessPluginMock,
  createAgentHarnessHostCapabilitiesMock,
  closeAgentHarnessHostCapabilitiesMock,
  agentHarnessHostCapabilitiesMock,
  listSessionEntriesCoreMock,
  loadSessionEntryMock,
  loadTranscriptEventsMock,
  resolveProviderEntryApiKeyProfileReferenceMock,
  preparedRuntimeSnapshotState,
} from "./btw.mocks.test-support.js";
