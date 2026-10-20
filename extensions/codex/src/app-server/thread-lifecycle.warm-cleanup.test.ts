import path from "node:path";
import { describe, expect, it } from "vitest";
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
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
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
  const cwd = input.cwd ?? input.params?.workspaceDir ?? path.join(tempDir, "workspace");
  return startOrResumeAttemptThread({
    signal: new AbortController().signal,
    dynamicTools: [],
    appServer: { ...createAppServerOptions(), connectionClass: "local-loopback" },
    ...input,
    cwd,
  });
}

function createParams(sessionFile: string, workspaceDir: string) {
  const params = createRunAttemptParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  return params;
}

setupRunAttemptTestHooks({ isolateNativeSkillHome: true });

describe("Codex warm subscription cleanup", () => {
  it.for([false, true])(
    "recovers warm publication failure with background protection=%s",
    async (backgroundWork) => {
      const params = createParams(
        path.join(tempDir, "warm.jsonl"),
        path.join(tempDir, "workspace"),
      );
      const threadId = "warm-publication-thread";
      let starts = 0;
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: createLifecycleRequest(async (method) => {
          if (method === "thread/start") {
            starts += 1;
            return threadStartResult(starts === 1 ? threadId : "updated-policy-thread");
          }
          if (method === "thread/resume") {
            return threadStartResult(threadId);
          }
          throw new Error(`unexpected method: ${method}`);
        }),
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

        await expect(
          startOrResumeThread(
            backgroundWork
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

  it("keeps the original warm policy usable after rejecting rotation during native background work", async () => {
    const sessionFile = path.join(tempDir, "warm-background-policy-session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const threadId = "warm-background-policy-thread";
    let pluginFingerprint = "original-plugin-policy";
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: createLifecycleRequest(async (method) => {
        if (method === "thread/start") {
          return threadStartResult(threadId);
        }
        if (method === "app/installed") {
          return { apps: [{ id: "fixture-app", enabled: true, callable: true }] };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
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
      await expect(startOrResumeThread(common)).rejects.toThrow(
        `Codex thread ${threadId} is claimed by active work; stop it first.`,
      );
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(bindingBefore);
      expect(
        fixture.request.mock.calls.some(([method]) =>
          ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
        ),
      ).toBe(false);

      pluginFingerprint = "original-plugin-policy";
      await expect(startOrResumeThread(common)).resolves.toMatchObject({
        threadId,
        lifecycle: { action: "resumed" },
      });
      expect(
        fixture.request.mock.calls.some(([method]) =>
          ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
        ),
      ).toBe(false);
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      releaseProtection();
    }
  });
});
