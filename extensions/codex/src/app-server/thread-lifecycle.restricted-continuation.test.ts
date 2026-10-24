import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
  createLifecycleRequest,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeAttemptThreadWithoutSkills as startOrResumeThread,
  threadStartResult,
  type CodexAttemptThreadInput,
} from "./thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";
import { CodexIncognitoPolicyChangeError } from "./thread-policy.js";

type ThreadBinding = Awaited<ReturnType<typeof startOrResumeThread>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture(rejectStartNumber?: number) {
  const tempDir = tempDirs.make("openclaw-codex-restricted-continuation-");
  resetCodexTestBindingStore();
  const workspaceDir = path.join(tempDir, "workspace");
  const attempt = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
  attempt.disableTools = false;
  attempt.pluginHarnessToolPolicyRestricted = true;
  attempt.pluginHarnessToolPolicyScope = "conversation";
  let starts = 0;
  const fixture = await createLeasedCodexLifecycleHarness({
    agentDir: path.join(tempDir, "agent"),
    respond: createLifecycleRequest(async (method, params) => {
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
    }),
  });
  const common = {
    client: fixture.client,
    cwd: workspaceDir,
    dynamicTools: [],
    appServer: { ...createAppServerOptions(), connectionClass: "local-loopback" as const },
    userMcpServersEnabled: false,
    nativeCodeModeEnabled: false,
  } satisfies Omit<CodexAttemptThreadInput, "params">;
  const identity = sessionBindingIdentity(attempt);
  const read = () => testCodexAppServerBindingStore.read(identity);
  const idle = async (binding: ThreadBinding, mode: "warm" | "cold") => {
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
  const start = (
    patch: Partial<CodexAttemptThreadInput["params"]> = {},
    overrides: Partial<Omit<CodexAttemptThreadInput, "params">> = {},
  ) => startOrResumeThread({ ...common, ...overrides, params: { ...attempt, ...patch } });
  const calls = (method: string) => fixture.request.mock.calls.filter(([name]) => name === method);
  const expectIsolation = async (
    temporaryStart: (initial: boolean) => ReturnType<typeof start>,
    durableStart: (runId: "durable" | "ordinary") => ReturnType<typeof start>,
  ) => {
    const initial = await temporaryStart(true);
    expect(initial.lifecycle.preserveExistingBinding).toBe(true);
    expect(read()).toBeUndefined();
    await fixture.endTurn(initial.threadId);
    const durable = await durableStart("durable");
    const previous = read();
    await fixture.endTurn(durable.threadId);
    const temporary = await temporaryStart(false);
    expect(temporary.lifecycle.preserveExistingBinding).toBe(true);
    expect(temporary.threadId).not.toBe(durable.threadId);
    expect(read()).toEqual(previous);
    await fixture.endTurn(temporary.threadId);
    const next = await durableStart("ordinary");
    expect(next).toMatchObject({ threadId: durable.threadId, lifecycle: { action: "resumed" } });
    expect(read()?.threadId).toBe(durable.threadId);
  };
  return { fixture, attempt, identity, read, idle, start, calls, expectIsolation };
}

afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

it.each([
  ["warm", "unchanged"],
  ["cold", "unchanged"],
  ["cold", "empty"],
  ["warm", "safe deny"],
  ["cold", "safe deny"],
  ["cold", "legacy"],
] as const)("continues a %s restricted conversation across %s policy", async (mode, change) => {
  const { identity, read, idle, start, calls } = await createFixture();
  const rotate = change === "safe deny" || change === "legacy";
  const policy = change === "empty" ? { toolsAllow: [] } : {};
  const first = await start(policy);
  expect(first.lifecycle.preserveExistingBinding).toBeUndefined();
  expect(read()).toMatchObject({
    threadId: first.threadId,
    restrictedThreadConfigFingerprint: expect.any(String),
  });
  const previous = read();
  await idle(first, mode);
  if (change === "legacy") {
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "patch",
      threadId: first.threadId,
      patch: { restrictedThreadConfigFingerprint: undefined },
    });
    expect(read()?.restrictedThreadConfigFingerprint).toBeUndefined();
  }
  const followup = {
    ...policy,
    ...(change === "safe deny"
      ? { pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] }
      : {}),
  };
  const second = await start({
    ...followup,
    ...(!rotate ? { toolsAllow: change === "empty" ? [] : ["*"] } : {}),
    runId: change === "legacy" ? "legacy-upgrade" : rotate ? "changed-policy" : "scheduled",
  });
  const expectedId = rotate ? "restricted-2" : first.threadId;
  expect(second).toMatchObject({
    threadId: expectedId,
    lifecycle: { action: rotate ? "started" : "resumed" },
  });
  if (change === "safe deny") {
    expect(read()?.restrictedThreadConfigFingerprint).not.toBe(
      previous?.restrictedThreadConfigFingerprint,
    );
  } else if (change === "legacy") {
    expect(read()?.restrictedThreadConfigFingerprint).toEqual(expect.any(String));
  }
  await idle(second, rotate ? "cold" : mode);
  const next = await start({
    ...followup,
    runId: change === "legacy" ? "after-upgrade" : rotate ? "recovered" : "follow-up",
  });
  expect(next).toMatchObject({ threadId: expectedId, lifecycle: { action: "resumed" } });
  expect(read()).toMatchObject({
    threadId: expectedId,
    nativeToolPolicyRestricted: true,
    restrictedThreadConfigFingerprint: expect.any(String),
  });
  expect(calls("thread/start")).toHaveLength(rotate ? 2 : 1);
  if (!rotate) {
    expect(calls("thread/resume")).toHaveLength(mode === "cold" ? 2 : 0);
    await next.liveThreadOwnership?.release(next.threadId);
  }
});

it("keeps a protected warm policy usable after refusing the changed-deny trigger", async () => {
  const { fixture, read, idle, start } = await createFixture();
  const first = await start();
  await idle(first, "warm");
  const previous = read();
  const unprotect = protectCodexAppServerLiveThread(fixture.client, first.threadId);
  fixture.request.mockClear();
  try {
    await expect(
      start({ pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] }),
    ).rejects.toThrow("claimed by active work");
    expect(read()).toEqual(previous);
    expect(isCodexAppServerLiveThreadClaimed(fixture.client, first.threadId)).toBe(false);
    const retry = await start({ runId: "original-policy" });
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

it("preserves the exact durable predecessor when a changed-policy fresh start fails", async () => {
  const { fixture, read, start, calls } = await createFixture(2);
  const first = await start();
  const previous = read();
  await fixture.endTurn(first.threadId);
  await expect(
    start({ pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] }),
  ).rejects.toThrow("synthetic restricted successor creation failed");
  expect(read()).toEqual(previous);
  expect(calls("thread/start")).toHaveLength(2);
});

it.each([
  ["disabled tools", { disableTools: true }],
  ["host-only delegation", { delegationCapability: "host_only" }],
  ["workspace-only work", { requireWorkspaceOnly: true }],
  ["turn policy", { pluginHarnessToolPolicyScope: "turn" }],
  ["temporary empty allowlist", { toolsAllow: [], pluginHarnessToolPolicyScope: "turn" }],
  ["unscoped wildcard", { toolsAllow: ["*"], pluginHarnessToolPolicyScope: undefined }],
] satisfies Array<[string, Partial<CodexAttemptThreadInput["params"]>]>)(
  "isolates initial and follow-up %s while retaining the durable conversation",
  async (_restriction, patch) => {
    const { start, expectIsolation } = await createFixture();
    await expectIsolation(
      (initial) => start({ ...patch, ...(!initial ? { runId: "temporary" } : {}) }),
      (runId) => start({ runId }),
    );
  },
);

it.each(["legacy", "native restoration", "temporary"] as const)(
  "keeps the bound local provider through %s",
  async (transition) => {
    const { fixture, attempt, identity, start, calls } = await createFixture();
    attempt.provider = "codex";
    attempt.modelId = "local-model";
    const first = await start();
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
    await start(
      {
        runId: "provider-continuation",
        ...(transition === "native restoration"
          ? { pluginHarnessToolPolicyRestricted: false }
          : {}),
        ...(transition === "temporary" ? { pluginHarnessToolPolicyScope: "turn" as const } : {}),
      },
      {
        nativeCodeModeEnabled: transition === "native restoration",
      },
    );
    expect(calls("thread/start").at(-1)?.[1]).toMatchObject({
      model: "local-model",
      modelProvider: "lmstudio",
    });
  },
);

it.each(["unchanged", "skills", "generic policy", "safe deny"] as const)(
  "preserves the restricted incognito owner for %s",
  async (change) => {
    const { fixture, attempt, idle, calls, start } = await createFixture();
    attempt.sessionKey = "agent:main:dashboard:incognito-restricted";
    const continueWith = (policy?: typeof change) =>
      start(
        {
          ...(policy ? { runId: "incognito-follow-up" } : {}),
          ...(policy === "safe deny"
            ? { pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] }
            : {}),
        },
        {
          developerInstructions: policy === "generic policy" ? "changed policy" : "generic policy",
          refreshableInstructions: policy === "skills" ? "updated skills" : "original skills",
        },
      );
    const first = await continueWith();
    await idle(first, "warm");
    const rejected = change === "generic policy" || change === "safe deny";
    if (rejected) {
      await expect(continueWith(change)).rejects.toBeInstanceOf(CodexIncognitoPolicyChangeError);
      expect(hasCodexAppServerLiveThread(fixture.client, first.threadId)).toBe(true);
    }
    const next = await continueWith(rejected ? undefined : change);
    expect(next).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("thread/resume")).toHaveLength(0);
    if (change === "skills") {
      expect(calls("thread/inject_items")).toHaveLength(1);
    }
    await next.liveThreadOwnership?.release(next.threadId);
  },
);

it("isolates additive turn grants while native tools remain unrestricted", async () => {
  const { start, expectIsolation } = await createFixture();
  const params = { pluginHarnessToolPolicyRestricted: false };
  const options = { nativeCodeModeEnabled: true };
  const dynamicTools = [
    {
      type: "function" as const,
      name: "fixture_lookup",
      description: "Run-owned plugin tool",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  await expectIsolation(
    () => start({ ...params, pluginHarnessToolPolicyScope: "turn" }, { ...options, dynamicTools }),
    () => start(params, options),
  );
});

it("does not isolate an unrestricted scheduled turn", async () => {
  const { fixture, start } = await createFixture();
  const params = { pluginHarnessToolPolicyRestricted: false };
  const first = await start(params, { nativeCodeModeEnabled: true });
  await fixture.endTurn(first.threadId);
  const next = await start(
    { ...params, pluginHarnessToolPolicyScope: "conversation", runId: "scheduled" },
    { nativeCodeModeEnabled: true },
  );
  expect(next).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
  expect(next.lifecycle.preserveExistingBinding).toBeUndefined();
});
