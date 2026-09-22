import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  testCodexAppServerBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import type { CodexCommandDepsOverride } from "./command-handlers.js";

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
