import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import { isJsonObject } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerThreadBinding } from "./session-binding.js";
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
type Attempt = CodexAttemptThreadInput["params"];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const safeDeny = { pluginHarnessToolPolicySafeDeniedTools: ["image_generate"] };
const resumed = (threadId: string) => ({ threadId, lifecycle: { action: "resumed" } });

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
  const patchBinding = (threadId: string, patch: Partial<CodexAppServerThreadBinding>) =>
    testCodexAppServerBindingStore.mutate(identity, { kind: "patch", threadId, patch });
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
    patch: Partial<Attempt> = {},
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
    expect(next).toMatchObject(resumed(durable.threadId));
    expect(read()?.threadId).toBe(durable.threadId);
  };
  return { fixture, attempt, patchBinding, read, idle, start, calls, expectIsolation };
}

afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

it.each([
  ["warm", "unchanged"],
  ["cold", "empty"],
  ["warm", "safe deny"],
  ["cold", "safe deny"],
] as const)("continues a %s restricted conversation across %s policy", async (mode, change) => {
  const { read, idle, start } = await createFixture();
  const rotate = change === "safe deny";
  const policy = change === "empty" ? { toolsAllow: [] } : {};
  const first = await start(policy);
  expect(first.lifecycle.preserveExistingBinding).toBeUndefined();
  await idle(first, mode);
  const followup = {
    ...policy,
    ...(change === "safe deny" ? safeDeny : {}),
  };
  const second = await start({
    ...followup,
    ...(!rotate ? { toolsAllow: change === "empty" ? [] : ["*"] } : {}),
    runId: rotate ? "changed-policy" : "scheduled",
  });
  const expectedId = rotate ? "restricted-2" : first.threadId;
  expect(second).toMatchObject({
    threadId: expectedId,
    lifecycle: { action: rotate ? "started" : "resumed" },
  });
  await idle(second, rotate ? "cold" : mode);
  const next = await start({
    ...followup,
    runId: rotate ? "recovered" : "follow-up",
  });
  expect(next).toMatchObject(resumed(expectedId));
  expect(read()).toMatchObject({
    threadId: expectedId,
    nativeToolPolicyRestricted: true,
    restrictedThreadConfigFingerprint: expect.any(String),
  });
  if (!rotate) {
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
    await expect(start(safeDeny)).rejects.toThrow("claimed by active work");
    expect(read()).toEqual(previous);
    expect(isCodexAppServerLiveThreadClaimed(fixture.client, first.threadId)).toBe(false);
    const retry = await start({ runId: "original-policy" });
    expect(retry).toMatchObject(resumed(first.threadId));
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
  const { fixture, read, start } = await createFixture(2);
  const first = await start();
  const previous = read();
  await fixture.endTurn(first.threadId);
  await expect(start(safeDeny)).rejects.toThrow("synthetic restricted successor creation failed");
  expect(read()).toEqual(previous);
});

it.each([
  ["disabled tools", { disableTools: true }],
  ["host-only delegation", { delegationCapability: "host_only" }],
  ["workspace-only work", { requireWorkspaceOnly: true }],
  ["turn policy", { pluginHarnessToolPolicyScope: "turn" }],
  ["temporary empty allowlist", { toolsAllow: [], pluginHarnessToolPolicyScope: "turn" }],
  ["unscoped wildcard", { toolsAllow: ["*"], pluginHarnessToolPolicyScope: undefined }],
] satisfies Array<[string, Partial<Attempt>]>)(
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
    const { fixture, attempt, patchBinding, start, calls } = await createFixture();
    attempt.provider = "codex";
    attempt.modelId = "local-model";
    const first = await start();
    await fixture.endTurn(first.threadId);
    expect(
      await patchBinding(first.threadId, {
        model: "local-model",
        modelProvider: "lmstudio",
        ...(transition === "legacy" ? { restrictedThreadConfigFingerprint: undefined } : {}),
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

it("preserves the restricted incognito owner after refusing a changed safe deny", async () => {
  const { fixture, attempt, idle, start } = await createFixture();
  attempt.sessionKey = "agent:main:dashboard:incognito-restricted";
  const first = await start();
  await idle(first, "warm");
  await expect(start(safeDeny)).rejects.toBeInstanceOf(CodexIncognitoPolicyChangeError);
  expect(hasCodexAppServerLiveThread(fixture.client, first.threadId)).toBe(true);
  const next = await start({ runId: "incognito-follow-up" });
  expect(next).toMatchObject(resumed(first.threadId));
  await next.liveThreadOwnership?.release(next.threadId);
});

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
  expect(next).toMatchObject(resumed(first.threadId));
  expect(next.lifecycle.preserveExistingBinding).toBeUndefined();
});
