import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import {
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
  createLeasedCodexLifecycleHarness,
  startOrResumeAttemptThreadWithoutSkills as startOrResumeAttemptThread,
  type CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";
import {
  failNextWarmPublication,
  retainWarmThread,
  warmPluginConfig,
} from "./thread-lifecycle.warm-cleanup.test-support.js";

function startOrResumeThread(
  input: Pick<LifecycleInput, "client" | "params"> & Partial<LifecycleInput>,
) {
  return startOrResumeAttemptThread({
    signal: new AbortController().signal,
    dynamicTools: [],
    appServer: { ...createAppServerOptions(), connectionClass: "local-loopback" },
    ...input,
    cwd: input.params.workspaceDir,
  });
}

const fixtureParams = (name: string) => ({
  ...createRunAttemptParams(path.join(tempDir, name), path.join(tempDir, "workspace")),
  disableTools: false,
  config: undefined,
});
const createFixture = (respond: Parameters<typeof createLifecycleRequest>[0]) =>
  createLeasedCodexLifecycleHarness({
    agentDir: path.join(tempDir, "agent"),
    respond: createLifecycleRequest(respond),
  });
function expectNoLifecycleRequests(fixture: Awaited<ReturnType<typeof createFixture>>) {
  expect(
    fixture.request.mock.calls.some(([method]) =>
      ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
    ),
  ).toBe(false);
}

setupRunAttemptTestHooks({ isolateNativeSkillHome: true });

describe("Codex warm subscription cleanup", () => {
  it("releases a warm claim when lease settlement fails after preparation", async () => {
    const params = {
      ...createRunAttemptParams(
        path.join(tempDir, "warm-lease-loss.jsonl"),
        path.join(tempDir, "workspace"),
      ),
      disableTools: false,
      config: undefined,
    };
    const threadId = "warm-lease-loss-thread";
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: createLifecycleRequest(async (method) => {
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult(threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    });
    const common = { client: fixture.client, params, userMcpServersEnabled: false };
    const started = await startOrResumeThread(common);
    expect(await retainWarmThread(fixture.client, started)).toBe(true);
    const resumesBeforeFailure = fixture.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    ).length;

    const withLease = testCodexAppServerBindingStore.withLease.bind(testCodexAppServerBindingStore);
    const lostLease = new Error("Lease settlement failed after warm preparation");
    const fault = vi
      .spyOn(testCodexAppServerBindingStore, "withLease")
      .mockImplementationOnce(async (identity, run, options) => {
        const prepared = await withLease(identity, run, options);
        // Prove the failure lands after warm ownership transfers, not on a cold resume.
        expect(isCodexAppServerLiveThreadClaimed(fixture.client, threadId)).toBe(true);
        expect(prepared).toMatchObject({ liveThreadOwnership: expect.any(Object) });
        throw lostLease;
      });
    try {
      await expect(startOrResumeThread(common)).rejects.toBe(lostLease);
    } finally {
      fault.mockRestore();
    }
    expect(isCodexAppServerLiveThreadClaimed(fixture.client, threadId)).toBe(false);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(resumesBeforeFailure);
    const retry = await startOrResumeThread(common);
    expect(retry).toMatchObject({ threadId, lifecycle: { action: "resumed" } });
    await retry.liveThreadOwnership?.release(threadId);
    expect(isCodexAppServerLiveThreadClaimed(fixture.client, threadId)).toBe(false);
  });
  it.for([false, true])(
    "recovers warm publication failure with background protection=%s",
    async (backgroundWork) => {
      const params = fixtureParams("warm.jsonl");
      const threadId = "warm-publication-thread";
      let starts = 0;
      const fixture = await createFixture(async (method) => {
        if (method === "thread/start") {
          starts += 1;
          return threadStartResult(starts === 1 ? threadId : "updated-policy-thread");
        }
        if (method === "thread/resume") {
          return threadStartResult(threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const common = {
        client: fixture.client,
        params,
        userMcpServersEnabled: false,
        developerInstructions: "original policy",
      };
      const started = await startOrResumeThread(common);
      expect(await retainWarmThread(fixture.client, started)).toBe(true);
      const releaseProtection = backgroundWork
        ? protectCodexAppServerLiveThread(fixture.client, threadId)
        : undefined;
      fixture.seed(threadStartResult("active-sibling"), { loaded: true, subscribed: true });
      const sibling = await claimCodexAppServerLiveThread(fixture.client, "active-sibling");
      expect(sibling).toBeDefined();
      const readerFailure = new Error("warm publication reader release failed");
      const failedPublication = failNextWarmPublication(readerFailure);
      try {
        await expect(startOrResumeThread(common)).rejects.toBe(readerFailure);
        failedPublication.mockRestore();
        expect(isCodexAppServerLiveThreadClaimed(fixture.client, threadId)).toBe(false);

        const retry: Parameters<typeof startOrResumeThread>[0] = backgroundWork
          ? common
          : {
              ...common,
              developerInstructions: "updated policy",
              dynamicTools: [
                {
                  type: "function",
                  name: "updated_tool",
                  description: "updated_tool test tool",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            };
        await expect(startOrResumeThread(retry)).resolves.toMatchObject({
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

  it("keeps the original warm policy usable after rejecting rotation during native background work", async () => {
    const sessionFile = path.join(tempDir, "warm-background-policy-session.jsonl");
    const params = fixtureParams("warm-background-policy-session.jsonl");
    const threadId = "warm-background-policy-thread";
    let pluginFingerprint = "original-plugin-policy";
    const fixture = await createFixture(async (method) => {
      if (method === "thread/start") {
        return threadStartResult(threadId);
      }
      if (method === "app/installed") {
        return { apps: [{ id: "fixture-app", enabled: true, callable: true }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      client: fixture.client,
      params,
      userMcpServersEnabled: false,
      pluginThreadConfig: warmPluginConfig(() => pluginFingerprint, ["fixture-app"]),
    };
    const started = await startOrResumeThread(common);
    expect(await retainWarmThread(fixture.client, started)).toBe(true);
    const bindingBefore = await readCodexAppServerBinding(sessionFile);
    const releaseProtection = protectCodexAppServerLiveThread(fixture.client, threadId);
    fixture.request.mockClear();
    try {
      pluginFingerprint = "changed-plugin-policy";
      const failure = await startOrResumeThread(common).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AgentHarnessPreflightError);
      expect(failure).toMatchObject({
        scope: undefined,
        message: `Codex thread ${threadId} is claimed by active work; stop it first.`,
      });
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(bindingBefore);
      expectNoLifecycleRequests(fixture);

      pluginFingerprint = "original-plugin-policy";
      await expect(startOrResumeThread(common)).resolves.toMatchObject({
        threadId,
        lifecycle: { action: "resumed" },
      });
      expectNoLifecycleRequests(fixture);
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      releaseProtection();
    }
  });
});
