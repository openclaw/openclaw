import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  clearSessionStoreCacheForTest,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as computerUse from "./app-server/computer-use.js";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import * as models from "./app-server/models.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.test-support.js";
import * as threadOwnership from "./app-server/thread-ownership.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { codexDiagnosticsFeedbackState } from "./command-diagnostics-state.js";
import { handleCodexCommand as dispatchCodexCommand } from "./command-dispatch.js";
import type { CodexCommandDeps as CodexCommandHost } from "./command-handler-deps.js";
import { createCodexCommandHost } from "./command-host.test-support.js";
import * as commandRpc from "./command-rpc.js";
import * as conversationBindingData from "./conversation-binding-data.js";
import * as conversationControl from "./conversation-control.js";

export function useCodexCommandTestState(options: {
  onSetup: (tempDir: string) => void;
  beforeCleanup?: () => void;
}): void {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      options.beforeCleanup?.();
      restoreCodexCommandMocks();
      codexDiagnosticsFeedbackState.clear();
      resetSharedCodexAppServerClientForTests();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      clearRuntimeAuthProfileStoreSnapshots();
      clearRuntimeConfigSnapshot();
      clearSessionStoreCacheForTest();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );

  beforeEach(() => {
    resetCodexTestBindingStore();
    const tempDir = tempDirs.make("openclaw-codex-command-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    setRuntimeConfigSnapshot({});
    options.onSetup(tempDir);
  });
}

export function createThreadResumeResponse(params: {
  threadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  canAcceptDirectInput?: boolean | null;
}) {
  const cwd = params.cwd ?? "/repo";
  const modelProvider = params.modelProvider ?? "openai";
  return {
    thread: {
      id: params.threadId,
      sessionId: params.threadId,
      projectId: null,
      cliVersion: CODEX_APP_SERVER_VERSION,
      createdAt: 1,
      updatedAt: 1,
      cwd,
      ephemeral: false,
      modelProvider,
      preview: "",
      source: "appServer",
      ...(params.canAcceptDirectInput !== undefined
        ? { canAcceptDirectInput: params.canAcceptDirectInput }
        : {}),
      status: { type: "idle" },
      turns: [],
    },
    model: params.model ?? "gpt-5.4",
    modelProvider,
    cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };
}

export function createContext(
  args: string,
  sessionFile?: string,
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    senderIsOwner: true,
    senderId: "user-1",
    args,
    commandBody: `/codex ${args}`,
    config: {},
    sessionId: "session-1",
    sessionFile,
    requestConversationBinding: async () => ({ status: "error", message: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

export type SafeCodexControlRequestFn = (
  pluginConfig: Parameters<typeof commandRpc.safeCodexControlRequest>[0],
  method: Parameters<typeof commandRpc.safeCodexControlRequest>[1],
  requestParams: Parameters<typeof commandRpc.safeCodexControlRequest>[2],
  options?: Parameters<typeof commandRpc.safeCodexControlRequest>[3],
) => ReturnType<typeof commandRpc.safeCodexControlRequest>;

type CodexCommandFunctions = {
  codexControlRequest: (
    ...args: Parameters<typeof commandRpc.codexControlRequest>
  ) => ReturnType<typeof commandRpc.codexControlRequest>;
  listCodexAppServerModels: typeof models.listAllCodexAppServerModels;
  readCodexStatusProbes: typeof commandRpc.readCodexStatusProbes;
  requestOptions: typeof commandRpc.requestOptions;
  safeCodexControlRequest: SafeCodexControlRequestFn;
  readCodexComputerUseStatus: typeof computerUse.readCodexComputerUseStatus;
  installCodexComputerUse: typeof computerUse.installCodexComputerUse;
  resolveCodexDefaultWorkspaceDir: typeof conversationBindingData.resolveCodexDefaultWorkspaceDir;
  readCodexConversationActiveTurn: typeof conversationControl.readCodexConversationActiveTurn;
  setCodexConversationFastMode: typeof conversationControl.setCodexConversationFastMode;
  setCodexConversationModel: typeof conversationControl.setCodexConversationModel;
  setCodexConversationPermissions: typeof conversationControl.setCodexConversationPermissions;
  steerCodexConversationTurn: typeof conversationControl.steerCodexConversationTurn;
  stopCodexConversationTurn: typeof conversationControl.stopCodexConversationTurn;
};

export type CodexCommandDeps = CodexCommandHost & Partial<CodexCommandFunctions>;

const commandMocks = new Set<{ mockRestore: () => void }>();
const commandFixture = new AsyncLocalStorage<CodexCommandDeps>();
let defaultCommandFixture: CodexCommandDeps | undefined;

function restoreCodexCommandMocks(): void {
  for (const mock of commandMocks) {
    mock.mockRestore();
  }
  commandMocks.clear();
  defaultCommandFixture = undefined;
}

function currentCommandFixture(): CodexCommandDeps | undefined {
  return commandFixture.getStore() ?? defaultCommandFixture;
}

function ensureCodexCommandMocks(): void {
  if (commandMocks.size > 0) {
    return;
  }
  // Capture before spying so omitted fixture functions still take the real path.
  const original = {
    codexControlRequest: commandRpc.codexControlRequest,
    listCodexAppServerModels: models.listAllCodexAppServerModels,
    readCodexStatusProbes: commandRpc.readCodexStatusProbes,
    requestOptions: commandRpc.requestOptions,
    safeCodexControlRequest: commandRpc.safeCodexControlRequest,
    readCodexComputerUseStatus: computerUse.readCodexComputerUseStatus,
    installCodexComputerUse: computerUse.installCodexComputerUse,
    resolveCodexDefaultWorkspaceDir: conversationBindingData.resolveCodexDefaultWorkspaceDir,
    readCodexConversationActiveTurn: conversationControl.readCodexConversationActiveTurn,
    setCodexConversationFastMode: conversationControl.setCodexConversationFastMode,
    setCodexConversationModel: conversationControl.setCodexConversationModel,
    setCodexConversationPermissions: conversationControl.setCodexConversationPermissions,
    steerCodexConversationTurn: conversationControl.steerCodexConversationTurn,
    stopCodexConversationTurn: conversationControl.stopCodexConversationTurn,
  };
  commandMocks.add(
    vi
      .spyOn(commandRpc, "codexControlRequest")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.codexControlRequest ?? original.codexControlRequest)(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(models, "listAllCodexAppServerModels")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.listCodexAppServerModels ?? original.listCodexAppServerModels)(
          ...args,
        ),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(commandRpc, "readCodexStatusProbes")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.readCodexStatusProbes ?? original.readCodexStatusProbes)(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(commandRpc, "requestOptions")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.requestOptions ?? original.requestOptions)(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(commandRpc, "safeCodexControlRequest")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.safeCodexControlRequest ?? original.safeCodexControlRequest)(
          ...args,
        ),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(computerUse, "readCodexComputerUseStatus")
      .mockImplementation((...args) =>
        (
          currentCommandFixture()?.readCodexComputerUseStatus ?? original.readCodexComputerUseStatus
        )(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(computerUse, "installCodexComputerUse")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.installCodexComputerUse ?? original.installCodexComputerUse)(
          ...args,
        ),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(conversationBindingData, "resolveCodexDefaultWorkspaceDir")
      .mockImplementation((...args) =>
        (
          currentCommandFixture()?.resolveCodexDefaultWorkspaceDir ??
          original.resolveCodexDefaultWorkspaceDir
        )(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(conversationControl, "readCodexConversationActiveTurn")
      .mockImplementation((...args) =>
        (
          currentCommandFixture()?.readCodexConversationActiveTurn ??
          original.readCodexConversationActiveTurn
        )(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(conversationControl, "setCodexConversationFastMode")
      .mockImplementation((...args) =>
        (
          currentCommandFixture()?.setCodexConversationFastMode ??
          original.setCodexConversationFastMode
        )(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(conversationControl, "setCodexConversationModel")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.setCodexConversationModel ?? original.setCodexConversationModel)(
          ...args,
        ),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(conversationControl, "setCodexConversationPermissions")
      .mockImplementation((...args) =>
        (
          currentCommandFixture()?.setCodexConversationPermissions ??
          original.setCodexConversationPermissions
        )(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(conversationControl, "steerCodexConversationTurn")
      .mockImplementation((...args) =>
        (
          currentCommandFixture()?.steerCodexConversationTurn ?? original.steerCodexConversationTurn
        )(...args),
      ),
  );
  commandMocks.add(
    vi
      .spyOn(conversationControl, "stopCodexConversationTurn")
      .mockImplementation((...args) =>
        (currentCommandFixture()?.stopCodexConversationTurn ?? original.stopCodexConversationTurn)(
          ...args,
        ),
      ),
  );
}

export function installCodexCommandMocks(deps: CodexCommandDeps): CodexCommandHost {
  ensureCodexCommandMocks();
  // Direct command-handler fixtures install once per test, outside a dispatch scope.
  if (!commandFixture.getStore()) {
    defaultCommandFixture = deps;
  }
  return {
    bindingStore: deps.bindingStore,
    listCodexCliSessionsOnNode: deps.listCodexCliSessionsOnNode,
    resolveCodexCliSessionForBindingOnNode: deps.resolveCodexCliSessionForBindingOnNode,
    codexPluginsManagementIo: deps.codexPluginsManagementIo,
  };
}

export function createDeps(overrides: Partial<CodexCommandDeps> = {}): CodexCommandDeps {
  return {
    ...createCodexCommandHost(),
    codexControlRequest: vi.fn(),
    listCodexAppServerModels: vi.fn(),
    readCodexStatusProbes: vi.fn(),
    requestOptions: vi.fn(
      (
        _pluginConfig: unknown,
        limit: number,
        config?: Parameters<NonNullable<CodexCommandDeps["requestOptions"]>>[2],
        _agentDir?: string,
      ) => ({
        limit,
        timeoutMs: 1000,
        startOptions: {
          transport: "stdio",
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
          headers: {},
        } satisfies CodexAppServerStartOptions,
        config,
        agentDir: _agentDir,
      }),
    ),
    safeCodexControlRequest: vi.fn(),
    ...overrides,
  };
}

export async function writeTestBinding(
  identity: Parameters<typeof testCodexAppServerBindingStore.mutate>[0],
  binding: CodexAppServerThreadBinding,
): Promise<void> {
  await testCodexAppServerBindingStore.mutate(identity, { kind: "set", binding });
}

export function supervisedTestBinding(threadId = "thread-supervised"): CodexAppServerThreadBinding {
  return {
    threadId,
    connectionScope: "supervision",
    supervisionSourceThreadId: threadId,
    appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
    cwd: "/repo",
    model: "gpt-5.5",
    modelProvider: "openai",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
  };
}

export function readDiagnosticsConfirmationToken(
  result: PluginCommandResult,
  commandPrefix = "/codex diagnostics",
): string {
  const text = result.text ?? "";
  const token = new RegExp(`${escapeRegExp(commandPrefix)} confirm ([a-f0-9]{12})`).exec(text)?.[1];
  if (!token) {
    throw new Error(`expected ${commandPrefix} confirmation token in command output`);
  }
  return token;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function requireResultText(result: PluginCommandResult): string {
  if (typeof result.text !== "string") {
    throw new Error("expected command result text");
  }
  return result.text;
}

export function expectResultTextContains(result: PluginCommandResult, expected: string): void {
  expect(requireResultText(result)).toContain(expected);
}

const requireRecord = createRequireRecord("record", "message");

function mockCall(mockFn: ReturnType<typeof vi.fn>, callIndex = 0): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call;
}

export function mockArg(mockFn: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  return mockCall(mockFn, callIndex)[argIndex];
}

export function mutatingCodexRequestMethods(
  calls: ReadonlyArray<readonly [method: string, ...args: unknown[]]>,
): string[] {
  return calls.map(([method]) => method).filter((method) => method !== "thread/read");
}

export function requestParams(
  mockFn: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, unknown> {
  return requireRecord(mockArg(mockFn, callIndex, 2), "expected request params object");
}

export function expectedDiagnosticsTargetBlock(params: {
  index?: number;
  channel?: string;
  sessionKey?: string;
  sessionId?: string;
  threadId: string;
}): string[] {
  return [
    `Session ${params.index ?? 1}`,
    ...(params.channel ? [`Channel: ${params.channel}`] : []),
    ...(params.sessionKey ? [`OpenClaw session key: \`${params.sessionKey}\``] : []),
    ...(params.sessionId ? [`OpenClaw session id: \`${params.sessionId}\``] : []),
    `Codex thread id: \`${params.threadId}\``,
    `Inspect locally: \`codex resume ${params.threadId}\``,
  ];
}

export async function createCodexRuntimeContextOverrides(
  tempDir: string,
  sessionKey = "agent:main:test:codex-compact",
): Promise<{
  config: PluginCommandContext["config"];
  sessionKey: string;
  sessionTarget: NonNullable<PluginCommandContext["sessionTarget"]>;
}> {
  const storePath = path.join(tempDir, "codex-runtime-sessions.json");
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      agentHarnessId: "codex",
    },
  });
  return {
    config: { session: { store: storePath } },
    sessionKey,
    sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
  };
}

export function runCommand(
  args: string,
  deps: Partial<CodexCommandDeps> = {},
  context: Partial<PluginCommandContext> = {},
  options: Omit<Parameters<typeof dispatchCodexCommand>[1], "deps"> = {},
) {
  return dispatchCodexCommandForTest(createContext(args, undefined, context), {
    ...options,
    deps: createDeps(deps),
  });
}

export function dispatchCodexCommandForTest(
  ctx: Parameters<typeof dispatchCodexCommand>[0],
  options: Omit<Parameters<typeof dispatchCodexCommand>[1], "deps"> & { deps: CodexCommandDeps },
) {
  // Keep each fixture selected through awaits, including overlapping dispatches.
  return commandFixture.run(options.deps, () =>
    dispatchCodexCommand(ctx, { ...options, deps: installCodexCommandMocks(options.deps) }),
  );
}

export function holdCodexThreadQueue(threadId: string) {
  const blocked = createDeferred<void>();
  const queue = threadOwnership.withCodexAppServerThreadMutation(threadId, () => blocked.promise);
  const queued =
    createDeferred<Parameters<typeof threadOwnership.withExclusiveCodexAppServerThread>[0]>();
  const withExclusiveThread = threadOwnership.withExclusiveCodexAppServerThread;
  const observer = vi
    .spyOn(threadOwnership, "withExclusiveCodexAppServerThread")
    .mockImplementation((params) => {
      // The real owner enqueues synchronously, after session adoption has settled.
      const pending = withExclusiveThread(params);
      queued.resolve(params);
      return pending;
    });
  return {
    waitFor: (command: Promise<PluginCommandResult>) =>
      Promise.race([
        queued.promise,
        command.then((result) => {
          throw new Error(`Resume completed before joining the native queue: ${result.text}`);
        }),
      ]),
    async release() {
      observer.mockRestore();
      blocked.resolve();
      await queue;
    },
  };
}

export function oauthProfile(email: string, now: number) {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: now + 60 * 60 * 1000,
    email,
  };
}
