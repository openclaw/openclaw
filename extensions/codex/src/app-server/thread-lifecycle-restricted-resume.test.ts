import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadStartResult as nativeThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { createCodexTestModel, useAutoCleanupTempDirTracker } from "./test-support.js";
import {
  createLeasedCodexLifecycleHarness,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";

let tempDir: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createThreadLifecycleParams(
  sessionFile: string,
  workspaceDir: string,
): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

function threadStartResult(threadId: string) {
  const result = nativeThreadStartResult(threadId, tempDir);
  return { ...result, thread: { ...result.thread, cliVersion: "0.149.0" } };
}

describe("restricted same-thread continuation with mock transport", () => {
  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-codex-restricted-resume-");
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts once, then resumes the same restricted thread for a separate delivery turn", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const firstAttempt = createThreadLifecycleParams(
      path.join(tempDir, "session.jsonl"),
      workspaceDir,
    );
    firstAttempt.pluginHarnessToolPolicyRestricted = true;
    firstAttempt.sourceReplyDeliveryMode = "automatic";
    const secondAttempt = {
      ...firstAttempt,
      prompt: "separate turn",
      runId: "run-2",
      sourceReplyDeliveryMode: "message_tool_only" as const,
    };
    let starts = 0;
    const respond = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(
          ++starts === 1 ? "thread-restricted-same" : "thread-restricted-legacy-transient",
        );
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-restricted-same");
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const common = {
      client: fixture.client,
      signal: new AbortController().signal,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
    };
    const first = await startOrResumeThread({ ...common, params: firstAttempt });
    expect(first).toMatchObject({
      threadId: "thread-restricted-same",
      lifecycle: { action: "started" },
    });
    await fixture.endTurn("thread-restricted-same");
    const second = await startOrResumeThread({ ...common, params: secondAttempt });
    expect(second).toMatchObject({
      threadId: "thread-restricted-same",
      lifecycle: { action: "resumed" },
    });
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      1,
    );
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(1);
    const identity = sessionBindingIdentity({
      sessionId: firstAttempt.sessionId,
      sessionKey: firstAttempt.sessionKey,
      agentId: firstAttempt.agentId,
      config: firstAttempt.config,
    });
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: "thread-restricted-same",
      nativeToolPolicyRestricted: true,
      restrictedThreadConfigFingerprint: expect.any(String),
    });
    const beforeMismatch = testCodexAppServerBindingStore.read(identity);
    await fixture.endTurn("thread-restricted-same");
    await expect(
      startOrResumeThread({
        ...common,
        params: {
          ...secondAttempt,
          runId: "run-3",
          pluginHarnessToolPolicySafeDeniedTools: ["image_generate"],
        },
      }),
    ).rejects.toThrow(/restricted|changed/);
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      1,
    );
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(testCodexAppServerBindingStore.read(identity)).toEqual(beforeMismatch);

    expect(
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId: "thread-restricted-same",
        patch: { restrictedThreadConfigFingerprint: undefined },
      }),
    ).toBe(true);
    const legacy = await startOrResumeThread({ ...common, params: secondAttempt });
    expect(legacy).toMatchObject({
      threadId: "thread-restricted-legacy-transient",
      lifecycle: { action: "started" },
    });
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      2,
    );
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(testCodexAppServerBindingStore.read(identity)?.threadId).toBe("thread-restricted-same");
  });

  it("reuses a loaded restricted incognito thread after validating its fingerprint", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const firstAttempt = createThreadLifecycleParams(
      path.join(tempDir, "session.jsonl"),
      workspaceDir,
    );
    firstAttempt.sessionKey = "agent:main:internal-session-effects:incognito-restricted-resume";
    firstAttempt.pluginHarnessToolPolicyRestricted = true;
    firstAttempt.sourceReplyDeliveryMode = "automatic";
    const secondAttempt = { ...firstAttempt, prompt: "separate incognito turn", runId: "run-2" };
    const respond = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-restricted-incognito");
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const common = {
      client: fixture.client,
      signal: new AbortController().signal,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
    };

    const first = await startOrResumeThread({ ...common, params: firstAttempt });
    await fixture.endTurn("thread-restricted-incognito");
    await retainCodexAppServerBindingSubscription(fixture.client, first.threadId, {
      configFingerprint: first.liveThreadConfigFingerprint,
      ephemeralPolicy: first.liveThreadEphemeralPolicy,
    });
    await expect(
      startOrResumeThread({
        ...common,
        params: {
          ...secondAttempt,
          runId: "run-policy-mismatch",
          pluginHarnessToolPolicySafeDeniedTools: ["image_generate"],
        },
      }),
    ).rejects.toThrow(/restricted|changed/);
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      1,
    );
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(0);

    const second = await startOrResumeThread({ ...common, params: secondAttempt });
    expect(second).toMatchObject({
      threadId: "thread-restricted-incognito",
      lifecycle: { action: "resumed" },
    });
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      1,
    );
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(0);
  });

  it("keeps the upstream transient start for an unrestricted binding", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    let starts = 0;
    const respond = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(++starts === 1 ? "thread-unrestricted" : "thread-transient");
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const common = {
      client: fixture.client,
      signal: new AbortController().signal,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };
    expect(await startOrResumeThread({ ...common, nativeCodeModeEnabled: true })).toMatchObject({
      threadId: "thread-unrestricted",
      lifecycle: { action: "started" },
    });
    await fixture.endTurn("thread-unrestricted");
    expect(await startOrResumeThread({ ...common, nativeCodeModeEnabled: false })).toMatchObject({
      threadId: "thread-transient",
      lifecycle: { action: "started" },
    });
    const identity = sessionBindingIdentity({
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      agentId: attempt.agentId,
      config: attempt.config,
    });
    expect(testCodexAppServerBindingStore.read(identity)?.threadId).toBe("thread-unrestricted");
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      2,
    );
  });
});
