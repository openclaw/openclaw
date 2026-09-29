import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
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
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { codexDiagnosticsFeedbackState } from "./command-diagnostics-state.js";
import { handleCodexCommand as dispatchCodexCommand } from "./command-dispatch.js";
import type { CodexCommandDepsOverride } from "./command-handlers.js";

export function useCodexCommandTestState(options: {
  onSetup: (tempDir: string) => void;
  beforeCleanup?: () => void;
}): void {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      options.beforeCleanup?.();
      codexDiagnosticsFeedbackState.clear();
      resetSharedCodexAppServerClientForTests();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      clearRuntimeAuthProfileStoreSnapshots();
      clearSessionStoreCacheForTest();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );

  beforeEach(() => {
    resetCodexTestBindingStore();
    const tempDir = tempDirs.make("openclaw-codex-command-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
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

export type CodexCommandDeps = CodexCommandDepsOverride & Record<string, unknown>;

export function createDeps(overrides: Partial<CodexCommandDeps> = {}): CodexCommandDepsOverride {
  return {
    bindingStore: testCodexAppServerBindingStore,
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
  return dispatchCodexCommand(createContext(args, undefined, context), {
    ...options,
    deps: createDeps(deps),
  });
}
