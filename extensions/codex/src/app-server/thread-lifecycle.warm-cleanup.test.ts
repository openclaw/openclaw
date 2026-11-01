import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
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
  it.for(["settlement", "cancellation", "deadline"] as const)(
    "joins background cleanup before cold resume: %s",
    { timeout: 15_000 },
    async (scenario) => {
      const params = fixtureParams("background-cold-resume.jsonl");
      const threadId = "background-cold-resume";
      const fixture = await createFixture(async (method) => {
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult(threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const common = { client: fixture.client, params, userMcpServersEnabled: false };
      const started = await startOrResumeThread(common);
      expect(await retainWarmThread(fixture.client, started)).toBe(true);
      const releaseProtection = protectCodexAppServerLiveThread(fixture.client, threadId);
      fixture.request.mockClear();
      const controller = new AbortController();
      const resumed = startOrResumeThread({
        ...common,
        developerInstructions: "updated policy",
        signal: controller.signal,
      });
      const outcome = resumed.catch((error: unknown) => error);
      try {
        await vi.waitFor(() =>
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain("thread/read"),
        );
        await setImmediate();
        expectNoLifecycleRequests(fixture);
        if (scenario === "cancellation") {
          const reason = new Error("cancel background cleanup wait");
          controller.abort(reason);
          expect(await outcome).toBe(reason);
          expectNoLifecycleRequests(fixture);
        } else if (scenario === "deadline") {
          expect(await outcome).toMatchObject({
            message: expect.stringContaining("still has background work"),
          });
          expectNoLifecycleRequests(fixture);
        } else {
          releaseProtection();
          expect(await outcome).toMatchObject({ threadId, lifecycle: { action: "resumed" } });
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain(
            "thread/unsubscribe",
          );
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain("thread/resume");
        }
      } finally {
        releaseProtection();
        await outcome;
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
