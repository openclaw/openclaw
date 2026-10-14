import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexDynamicToolFunctionSpec } from "./protocol.js";
import {
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";
import { createLeasedCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";

type LifecycleInput = Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">;

function startOrResumeThread(input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>) {
  const cwd = input.cwd ?? input.params?.workspaceDir ?? path.join(tempDir, "workspace");
  const params = input.params ?? createParams(path.join(tempDir, "session.jsonl"), cwd);
  registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
  return startOrResumeThreadImpl({
    signal: new AbortController().signal,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
    ...input,
    params,
    cwd,
    bindingStore: testCodexAppServerBindingStore,
  });
}

function retainThread(
  client: LifecycleInput["client"],
  binding: Awaited<ReturnType<typeof startOrResumeThread>>,
) {
  return retainCodexAppServerLiveThread(
    client,
    binding.threadId,
    undefined,
    binding.liveThreadConfigFingerprint,
  );
}

function createThreadLifecycleAppServerOptions(): LifecycleInput["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

function createParams(sessionFile: string, workspaceDir: string) {
  const params = createRunAttemptParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  return params;
}

function createNamedDynamicTool(name: string): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

setupRunAttemptTestHooks();

describe("Codex warm subscription cleanup", () => {
  it.for([false, true])(
    "recovers warm publication failure with background protection=%s",
    async (backgroundWork) => {
      const sessionFile = path.join(tempDir, "warm-publication-release.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      const threadId = "warm-publication-thread";
      let starts = 0;
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start") {
            starts += 1;
            return threadStartResult(starts === 1 ? threadId : "updated-policy-thread");
          }
          if (method === "thread/resume") {
            return threadStartResult(threadId);
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const common = {
        client: fixture.client,
        params,
        userMcpServersEnabled: false,
        developerInstructions: "original policy",
      };
      const started = await startOrResumeThread(common);
      expect(await retainThread(fixture.client, started)).toBe(true);
      const releaseProtection = backgroundWork
        ? protectCodexAppServerLiveThread(fixture.client, threadId)
        : undefined;
      fixture.seed(threadStartResult("active-sibling"), { loaded: true, subscribed: true });
      const sibling = await claimCodexAppServerLiveThread(fixture.client, "active-sibling");
      expect(sibling).toBeDefined();
      const leaseFailure = new Error("warm publication lease settlement failed");
      const withLease = testCodexAppServerBindingStore.withLease.bind(
        testCodexAppServerBindingStore,
      );
      const failedPublication = vi
        .spyOn(testCodexAppServerBindingStore, "withLease")
        .mockImplementation(async (identity, run) => {
          const result = await withLease(identity, run);
          // Model lease settlement failing after the lifecycle published its
          // warm binding; every earlier admission uses the real owner.
          if (
            result !== null &&
            typeof result === "object" &&
            "liveThreadOwnership" in result &&
            result.liveThreadOwnership
          ) {
            throw leaseFailure;
          }
          return result;
        });
      try {
        await expect(startOrResumeThread(common)).rejects.toBe(leaseFailure);
        failedPublication.mockRestore();
        expect(isCodexAppServerLiveThreadClaimed(fixture.client, threadId)).toBe(false);

        await expect(
          startOrResumeThread(
            backgroundWork
              ? common
              : {
                  ...common,
                  developerInstructions: "updated policy",
                  dynamicTools: [createNamedDynamicTool("updated_tool")],
                },
          ),
        ).resolves.toMatchObject({
          threadId: backgroundWork ? threadId : "updated-policy-thread",
          lifecycle: { action: backgroundWork ? "resumed" : "started" },
        });
        expect(() => sibling!.assertCurrent()).not.toThrow();
        expect(fixture.client.getCloseError()).toBeUndefined();
      } finally {
        failedPublication.mockRestore();
        releaseProtection?.();
        await sibling?.release("active-sibling");
      }
    },
  );
});
