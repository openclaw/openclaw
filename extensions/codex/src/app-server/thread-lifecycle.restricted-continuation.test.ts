// Real lifecycle and ownership with synthetic native responses and an in-memory binding store.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import { isJsonObject } from "./protocol.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeAttemptThreadWithoutSkills as startOrResumeThread,
  threadStartResult,
  type CodexAttemptThreadInput,
} from "./thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";
import { CodexIncognitoPolicyChangeError } from "./thread-policy.js";

let tempDir: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture(rejectStartNumber?: number) {
  const workspaceDir = path.join(tempDir, "workspace");
  const attempt = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
  attempt.disableTools = false;
  attempt.pluginHarnessToolPolicyRestricted = true;
  attempt.pluginHarnessToolPolicyScope = "conversation";
  let starts = 0;
  const fixture = await createLeasedCodexLifecycleHarness({
    agentDir: path.join(tempDir, "agent"),
    respond: async (method, params) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        if (++starts === rejectStartNumber) {
          throw new Error("synthetic restricted successor creation failed");
        }
        return threadStartResult(`restricted-${starts}`);
      }
      if (
        method === "thread/resume" &&
        isJsonObject(params) &&
        typeof params.threadId === "string"
      ) {
        return threadStartResult(params.threadId);
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/delete") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    },
  });
  const common = {
    client: fixture.client,
    params: attempt,
    cwd: workspaceDir,
    dynamicTools: [],
    appServer: { ...createAppServerOptions(), connectionClass: "local-loopback" as const },
    userMcpServersEnabled: false,
    nativeCodeModeEnabled: false,
  } satisfies CodexAttemptThreadInput;
  const identity = sessionBindingIdentity({
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    agentId: attempt.agentId,
    config: attempt.config,
  });
  const read = () => testCodexAppServerBindingStore.read(identity);
  const idle = async (
    binding: Awaited<ReturnType<typeof startOrResumeThread>>,
    mode: "warm" | "cold",
  ) => {
    if (mode === "cold") {
      await fixture.endTurn(binding.threadId);
    } else {
      expect(
        await retainCodexAppServerBindingSubscription(fixture.client, binding.threadId, {
          release: binding.liveThreadOwnership?.release,
          configFingerprint: binding.liveThreadConfigFingerprint,
          ephemeralPolicy: binding.liveThreadEphemeralPolicy,
        }),
      ).toBe(true);
    }
  };
  return { fixture, common, attempt, identity, read, idle };
}

describe("persistent restricted Codex continuation", () => {
  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-codex-restricted-continuation-");
    resetCodexTestBindingStore();
  });
  afterEach(() => {
    resetThreadLifecycleTestFixtures();
    vi.restoreAllMocks();
  });

  it.each(["warm", "cold"] as const)(
    "keeps the native ID across no-op wildcard changes for a %s owner",
    async (mode) => {
      const { fixture, common, attempt, read, idle } = await createFixture();
      const first = await startOrResumeThread(common);
      await idle(first, mode);
      const scheduled = await startOrResumeThread({
        ...common,
        params: { ...attempt, runId: "scheduled", toolsAllow: ["*"] },
      });
      expect(scheduled).toMatchObject({
        threadId: first.threadId,
        lifecycle: { action: "resumed" },
      });
      await idle(scheduled, mode);
      const next = await startOrResumeThread({
        ...common,
        params: { ...attempt, runId: "follow-up" },
      });
      expect(next).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
      expect(read()).toMatchObject({
        threadId: first.threadId,
        nativeToolPolicyRestricted: true,
        restrictedThreadConfigFingerprint: expect.any(String),
      });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(1);
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
      ).toHaveLength(mode === "cold" ? 2 : 0);
      await next.liveThreadOwnership?.release(next.threadId);
    },
  );

  it.each(["warm", "cold"] as const)(
    "recovers safe-denied image_generate drift from a %s owner",
    async (mode) => {
      const { fixture, common, attempt, read, idle } = await createFixture();
      const first = await startOrResumeThread(common);
      const previous = read();
      await idle(first, mode);
      const changed = {
        ...attempt,
        runId: "changed-policy",
        pluginHarnessToolPolicySafeDeniedTools: ["image_generate"],
      };
      const successor = await startOrResumeThread({ ...common, params: changed });
      expect(successor).toMatchObject({
        threadId: "restricted-2",
        lifecycle: { action: "started" },
      });
      expect(read()?.restrictedThreadConfigFingerprint).not.toBe(
        previous?.restrictedThreadConfigFingerprint,
      );
      await fixture.endTurn(successor.threadId);
      const next = await startOrResumeThread({
        ...common,
        params: { ...changed, runId: "recovered" },
      });
      expect(next).toMatchObject({
        threadId: successor.threadId,
        lifecycle: { action: "resumed" },
      });
      expect(read()?.threadId).toBe(successor.threadId);
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(2);
    },
  );

  it("keeps a protected warm policy usable after refusing the changed-deny trigger", async () => {
    const { fixture, common, attempt, read, idle } = await createFixture();
    const first = await startOrResumeThread(common);
    await idle(first, "warm");
    const previous = read();
    const unprotect = protectCodexAppServerLiveThread(fixture.client, first.threadId);
    fixture.request.mockClear();
    try {
      await expect(
        startOrResumeThread({
          ...common,
          params: { ...attempt, pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] },
        }),
      ).rejects.toThrow("claimed by active work");
      expect(read()).toEqual(previous);
      expect(isCodexAppServerLiveThreadClaimed(fixture.client, first.threadId)).toBe(false);
      const retry = await startOrResumeThread({
        ...common,
        params: { ...attempt, runId: "original-policy" },
      });
      expect(retry).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
      expect(
        fixture.request.mock.calls.some(([method]) =>
          ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
        ),
      ).toBe(false);
      expect(fixture.client.getCloseError()).toBeUndefined();
      unprotect();
      await retry.liveThreadOwnership?.release(retry.threadId);
    } finally {
      unprotect();
    }
  });

  it("replaces an unattested legacy owner once, then resumes its attested successor", async () => {
    const { fixture, common, attempt, read } = await createFixture();
    const first = await startOrResumeThread(common);
    await fixture.endTurn(first.threadId);
    await testCodexAppServerBindingStore.mutate(
      sessionBindingIdentity({
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: attempt.agentId,
        config: attempt.config,
      }),
      {
        kind: "patch",
        threadId: first.threadId,
        patch: { restrictedThreadConfigFingerprint: undefined },
      },
    );
    expect(read()?.restrictedThreadConfigFingerprint).toBeUndefined();
    const successor = await startOrResumeThread({
      ...common,
      params: { ...attempt, runId: "legacy-upgrade" },
    });
    expect(successor).toMatchObject({ threadId: "restricted-2", lifecycle: { action: "started" } });
    expect(read()?.restrictedThreadConfigFingerprint).toEqual(expect.any(String));
    await fixture.endTurn(successor.threadId);
    const next = await startOrResumeThread({
      ...common,
      params: { ...attempt, runId: "after-upgrade" },
    });
    expect(next).toMatchObject({ threadId: successor.threadId, lifecycle: { action: "resumed" } });
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      2,
    );
  });

  it("preserves the exact durable predecessor when a changed-policy fresh start fails", async () => {
    const { fixture, common, attempt, read } = await createFixture(2);
    const first = await startOrResumeThread(common);
    const previous = read();
    await fixture.endTurn(first.threadId);
    await expect(
      startOrResumeThread({
        ...common,
        params: { ...attempt, pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] },
      }),
    ).rejects.toThrow("synthetic restricted successor creation failed");
    expect(read()).toEqual(previous);
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      2,
    );
  });

  it.each([
    { restriction: "disabled tools", patch: { disableTools: true } },
    { restriction: "workspace-only work", patch: { requireWorkspaceOnly: true } },
    { restriction: "turn policy", patch: { pluginHarnessToolPolicyScope: "turn" } },
    {
      restriction: "temporary empty allowlist",
      patch: { toolsAllow: [], pluginHarnessToolPolicyScope: "turn" },
    },
    {
      restriction: "unscoped wildcard",
      patch: { toolsAllow: ["*"], pluginHarnessToolPolicyScope: undefined },
    },
  ] satisfies Array<{ restriction: string; patch: Partial<CodexAttemptThreadInput["params"]> }>)(
    "isolates initial and follow-up $restriction while retaining the durable conversation",
    async ({ patch }) => {
      const { fixture, common, attempt, read } = await createFixture();
      const initial = await startOrResumeThread({ ...common, params: { ...attempt, ...patch } });
      expect(initial.lifecycle.preserveExistingBinding).toBe(true);
      expect(read()).toBeUndefined();
      await fixture.endTurn(initial.threadId);
      const durable = await startOrResumeThread({
        ...common,
        params: { ...attempt, runId: "durable" },
      });
      const previous = read();
      await fixture.endTurn(durable.threadId);
      const temporary = await startOrResumeThread({
        ...common,
        params: { ...attempt, ...patch, runId: "temporary" },
      });
      expect(temporary.lifecycle.preserveExistingBinding).toBe(true);
      expect(temporary.threadId).not.toBe(durable.threadId);
      expect(read()).toEqual(previous);
      await fixture.endTurn(temporary.threadId);
      const next = await startOrResumeThread({
        ...common,
        params: { ...attempt, runId: "ordinary" },
      });
      expect(next).toMatchObject({ threadId: durable.threadId, lifecycle: { action: "resumed" } });
      expect(read()?.threadId).toBe(durable.threadId);
    },
  );

  it.each(["legacy", "native restoration", "temporary"] as const)(
    "keeps the bound local provider through %s",
    async (transition) => {
      const { fixture, common, attempt, identity } = await createFixture();
      attempt.provider = "codex";
      attempt.modelId = "local-model";
      const first = await startOrResumeThread(common);
      await fixture.endTurn(first.threadId);
      expect(
        await testCodexAppServerBindingStore.mutate(identity, {
          kind: "patch",
          threadId: first.threadId,
          patch: {
            model: "local-model",
            modelProvider: "lmstudio",
            ...(transition === "legacy" ? { restrictedThreadConfigFingerprint: undefined } : {}),
          },
        }),
      ).toBe(true);
      await startOrResumeThread({
        ...common,
        nativeCodeModeEnabled: transition === "native restoration",
        params: {
          ...attempt,
          runId: "provider-continuation",
          ...(transition === "native restoration"
            ? { pluginHarnessToolPolicyRestricted: false }
            : {}),
          ...(transition === "temporary" ? { pluginHarnessToolPolicyScope: "turn" as const } : {}),
        },
      });
      expect(
        fixture.request.mock.calls.findLast(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({ model: "local-model", modelProvider: "lmstudio" });
    },
  );

  it.each(["unchanged", "skills", "generic policy", "safe deny"] as const)(
    "preserves the restricted incognito owner for %s",
    async (change) => {
      const { fixture, common, attempt, idle } = await createFixture();
      attempt.sessionKey = "agent:main:dashboard:incognito-restricted";
      const original = {
        ...common,
        developerInstructions: "generic policy",
        refreshableInstructions: "original skills",
      };
      const first = await startOrResumeThread(original);
      await idle(first, "warm");
      const changed = {
        ...original,
        developerInstructions: change === "generic policy" ? "changed policy" : "generic policy",
        refreshableInstructions: change === "skills" ? "updated skills" : "original skills",
        params: {
          ...attempt,
          runId: "incognito-follow-up",
          ...(change === "safe deny"
            ? { pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] }
            : {}),
        },
      };
      if (change === "generic policy" || change === "safe deny") {
        await expect(startOrResumeThread(changed)).rejects.toBeInstanceOf(
          CodexIncognitoPolicyChangeError,
        );
        expect(hasCodexAppServerLiveThread(fixture.client, first.threadId)).toBe(true);
      }
      const next = await startOrResumeThread(
        change === "generic policy" || change === "safe deny" ? original : changed,
      );
      expect(next).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(1);
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
      ).toHaveLength(0);
      if (change === "skills") {
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "thread/inject_items"),
        ).toHaveLength(1);
      }
      await next.liveThreadOwnership?.release(next.threadId);
    },
  );

  it("isolates additive turn grants while native tools remain unrestricted", async () => {
    const { fixture, common, attempt, read } = await createFixture();
    const ordinary = {
      ...common,
      nativeCodeModeEnabled: true,
      params: { ...attempt, pluginHarnessToolPolicyRestricted: false },
    };
    const granted = {
      ...ordinary,
      params: { ...ordinary.params, pluginHarnessToolPolicyScope: "turn" as const },
      dynamicTools: [
        {
          type: "function" as const,
          name: "fixture_lookup",
          description: "Run-owned plugin tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
    const initial = await startOrResumeThread(granted);
    expect(initial.lifecycle.preserveExistingBinding).toBe(true);
    expect(read()).toBeUndefined();
    await fixture.endTurn(initial.threadId);
    const durable = await startOrResumeThread(ordinary);
    const previous = read();
    await fixture.endTurn(durable.threadId);
    const temporary = await startOrResumeThread(granted);
    expect(temporary.lifecycle.preserveExistingBinding).toBe(true);
    expect(temporary.threadId).not.toBe(durable.threadId);
    expect(read()).toEqual(previous);
    await fixture.endTurn(temporary.threadId);
    const next = await startOrResumeThread(ordinary);
    expect(next.threadId).toBe(durable.threadId);
  });

  it("does not isolate an unrestricted scheduled turn", async () => {
    const { fixture, common, attempt } = await createFixture();
    const params = { ...attempt, pluginHarnessToolPolicyRestricted: false };
    const ordinary = { ...common, params, nativeCodeModeEnabled: true };
    const first = await startOrResumeThread(ordinary);
    await fixture.endTurn(first.threadId);
    const next = await startOrResumeThread({
      ...ordinary,
      params: { ...params, pluginHarnessToolPolicyScope: "conversation", runId: "scheduled" },
    });
    expect(next).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
    expect(next.lifecycle.preserveExistingBinding).toBeUndefined();
  });

  it("persists and resumes an empty allowlist from conversation policy", async () => {
    const { fixture, common, attempt, read } = await createFixture();
    const configured = { ...attempt, toolsAllow: [] };
    const first = await startOrResumeThread({ ...common, params: configured });
    expect(first.lifecycle.preserveExistingBinding).toBeUndefined();
    expect(read()).toMatchObject({
      threadId: first.threadId,
      restrictedThreadConfigFingerprint: expect.any(String),
    });
    await fixture.endTurn(first.threadId);
    const next = await startOrResumeThread({
      ...common,
      params: { ...configured, runId: "empty-policy" },
    });
    expect(next).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
    expect(fixture.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      1,
    );
  });
});
