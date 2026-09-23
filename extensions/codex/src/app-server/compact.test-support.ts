import path from "node:path";
import { expect } from "vitest";
import type { maybeCompactCodexAppServerSession } from "./compact.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

export async function writeCompactionTestBinding(
  tempDir: string,
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
  sessionKey = "agent:main:session-1",
): Promise<string> {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const identity = sessionBindingIdentity({ sessionId: "session-1", sessionKey });
  registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey, identity.agentId);
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-1",
    cwd: tempDir,
    ...options,
  });
  return sessionFile;
}

export async function writeSupervisedTestBinding(
  tempDir: string,
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
): Promise<string> {
  return writeCompactionTestBinding(tempDir, {
    connectionScope: "supervision",
    supervisionSourceThreadId: "source-thread-1",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
    model: "gpt-5.4",
    modelProvider: "openai",
    appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
      resolveCodexSupervisionAppServerRuntimeOptions({
        pluginConfig: { supervision: { enabled: true } },
      }),
    ),
    ...options,
  });
}

export function createSandboxedCompactionParams(tempDir: string, sessionFile: string) {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  } satisfies Parameters<typeof maybeCompactCodexAppServerSession>[0];
}

export function createRemoteExecCompactionParams(tempDir: string, sessionFile: string) {
  const params: Parameters<typeof maybeCompactCodexAppServerSession>[0] & {
    sandbox: ReturnType<typeof createSandboxContext> & {
      placementExecutionMode: "remote-exec";
    };
  } = {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    sandbox: {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec",
    },
  };
  return params;
}

export function createNodeExecCompactionParams(tempDir: string, sessionFile: string) {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    config: { tools: { exec: { host: "node", node: "worker-1" } } },
  } satisfies Parameters<typeof maybeCompactCodexAppServerSession>[0];
}

type CompactResult = NonNullable<Awaited<ReturnType<typeof maybeCompactCodexAppServerSession>>>;

export function requireCompactResult(result: CompactResult | undefined): CompactResult {
  if (!result) {
    throw new Error("expected compaction result");
  }
  return result;
}

export function compactDetails(result: CompactResult): Record<string, unknown> {
  return (result.result?.details ?? {}) as Record<string, unknown>;
}

export async function flushAsyncTasks(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export async function expectExternalMutationBlockedDuringNativeRequest(params: {
  releaseExternalMutation: () => void;
  isExternalMutationStarted: () => boolean;
  isExternalMutationFinished: () => boolean;
}): Promise<Record<string, never>> {
  params.releaseExternalMutation();
  await flushAsyncTasks();
  expect(params.isExternalMutationStarted()).toBe(true);
  expect(params.isExternalMutationFinished()).toBe(false);
  return {};
}
