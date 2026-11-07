import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import {
  createAgentLifecycleHarness,
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
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
  createAgentLifecycleHarness({
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
  it.for(
    (["settlement", "cancellation", "deadline"] as const)
      .flatMap((scenario) =>
        ["cold resume", "context-engine rotation"].map((transition) => ({ scenario, transition })),
      )
      .concat([
        { scenario: "settlement", transition: "deferred physical release" },
        { scenario: "settlement", transition: "deferred cold resume" },
      ]),
  )(
    "joins background cleanup before $transition: $scenario",
    { timeout: 15_000 },
    async ({ scenario, transition }) => {
      const rotating =
        transition === "context-engine rotation" || transition === "deferred physical release";
      const params = fixtureParams("background-cold-resume.jsonl");
      params.contextEngine = {
        info: { id: "test", name: "Test", ownsCompaction: true },
        ingest: vi.fn(),
        assemble: vi.fn(),
        compact: vi.fn(),
      };
      const threadId = "background-cold-resume";
      let starts = 0;
      const fixture = await createFixture(async (method) => {
        if (method === "thread/start") {
          return threadStartResult(++starts === 1 ? threadId : `${threadId}-successor`);
        }
        if (method === "thread/resume") {
          return threadStartResult(threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      });
      let pluginBuilds = 0;
      let pluginFingerprint = "original-plugin-policy";
      const common = {
        client: fixture.client,
        params,
        userMcpServersEnabled: false,
        contextEngineProjection: {
          mode: "thread_bootstrap" as const,
          epoch: "before",
          fingerprint: "before",
        },
        pluginThreadConfig: warmPluginConfig(() => {
          pluginBuilds++;
          return pluginFingerprint;
        }),
      };
      const started = await startOrResumeThread(common);
      expect(await retainWarmThread(fixture.client, started)).toBe(true);
      const bindingBefore = await readCodexAppServerBinding(params.sessionFile);
      const releaseProtection = protectCodexAppServerLiveThread(fixture.client, threadId);
      if (transition.startsWith("deferred")) {
        const claim = await claimCodexAppServerLiveThread(fixture.client, threadId);
        expect(claim).toBeDefined();
        await claim?.release(threadId);
      }
      fixture.request.mockClear();
      const controller = new AbortController();
      const buildsBefore = pluginBuilds;
      if (rotating) {
        pluginFingerprint = "changed-plugin-policy";
      }
      const resumed = startOrResumeThread({
        ...common,
        ...(rotating
          ? {
              contextEngineProjection: {
                mode: "thread_bootstrap" as const,
                epoch: "after",
                fingerprint: "after",
              },
            }
          : { developerInstructions: "updated policy" }),
        signal: controller.signal,
      });
      let failure: unknown;
      const outcome = resumed.catch((error: unknown) => {
        failure = error;
        return error;
      });
      try {
        await vi.waitFor(() => {
          expect(failure).toBeUndefined();
          return rotating
            ? expect(pluginBuilds).toBeGreaterThan(buildsBefore)
            : expect(fixture.request.mock.calls.map(([method]) => method)).toContain("thread/read");
        });
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
          expect(await outcome).toMatchObject({
            threadId: rotating ? `${threadId}-successor` : threadId,
            lifecycle: { action: rotating ? "started" : "resumed" },
          });
          if (rotating) {
            const next = await readCodexAppServerBinding(params.sessionFile);
            expect(next?.contextEngine?.projection?.epoch).toBe("after");
            expect(next?.contextEngine?.policyFingerprint).toBe(
              bindingBefore?.contextEngine?.policyFingerprint,
            );
          }
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain(
            "thread/unsubscribe",
          );
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain(
            rotating ? "thread/start" : "thread/resume",
          );
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
        message: `Codex thread ${threadId} still has background work or live resources after waiting for cleanup; wait for them to settle or release the owning resources and retry.`,
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
