// Codex tests cover compact plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import {
  maybeCompactCodexAppServerSession as maybeCompactCodexAppServerSessionImpl,
  requestCodexNativeTurnForBinding,
} from "./compact.js";
import type { CodexServerNotification, JsonValue } from "./protocol.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  clearCodexAppServerBindingForThread,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientLeaseFactory } from "./shared-client.js";
import {
  adaptCodexTestClientFactory,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

let tempDir: string;
let codexAppServerClientLeaseFactoryForTest: CodexAppServerClientLeaseFactory | undefined;

type MaybeCompactImplOptions = NonNullable<
  Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]
>;
type MaybeCompactOptions = Omit<MaybeCompactImplOptions, "bindingStore"> & {
  bindingStore?: MaybeCompactImplOptions["bindingStore"];
};

function setCodexAppServerClientFactoryForTest(factory: CodexTestAppServerClientFactory): void {
  codexAppServerClientLeaseFactoryForTest = adaptCodexTestClientFactory(factory);
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientLeaseFactoryForTest = undefined;
}

function maybeCompactCodexAppServerSession(
  params: Parameters<typeof maybeCompactCodexAppServerSessionImpl>[0],
  options: MaybeCompactOptions = {},
) {
  const identity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  registerCodexTestSessionIdentity(
    params.sessionFile,
    params.sessionId,
    params.sessionKey,
    identity.agentId,
  );
  const clientLeaseFactory = options.clientLeaseFactory ?? codexAppServerClientLeaseFactoryForTest;
  return maybeCompactCodexAppServerSessionImpl(params, {
    ...options,
    bindingStore: options.bindingStore ?? testCodexAppServerBindingStore,
    ...(clientLeaseFactory ? { clientLeaseFactory } : {}),
  });
}

async function writeTestBinding(
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

function startCompaction(
  sessionFile: string,
  options: { currentTokenCount?: number; abortSignal?: AbortSignal } = {},
) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    ...options,
  });
}

function startSandboxedCompaction(sessionFile: string) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  });
}

function startNodeExecCompaction(sessionFile: string) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    config: { tools: { exec: { host: "node", node: "worker-1" } } },
  });
}

type CompactResult = NonNullable<Awaited<ReturnType<typeof maybeCompactCodexAppServerSession>>>;

function requireCompactResult(result: CompactResult | undefined): CompactResult {
  if (!result) {
    throw new Error("expected compaction result");
  }
  return result;
}

function compactDetails(result: CompactResult): Record<string, unknown> {
  return (result.result?.details ?? {}) as Record<string, unknown>;
}

function expectCompactStart(request: ReturnType<typeof vi.fn>): void {
  expect(request).toHaveBeenCalledWith(
    "thread/compact/start",
    { threadId: "thread-1" },
    expect.objectContaining({ timeoutMs: expect.any(Number) }),
  );
}

function expectReviewStart(request: ReturnType<typeof vi.fn>): void {
  expect(request).toHaveBeenCalledWith(
    "review/start",
    { threadId: "thread-1", target: { type: "uncommittedChanges" } },
    expect.objectContaining({ timeoutMs: expect.any(Number) }),
  );
}

async function flushAsyncTasks(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function expectExternalMutationBlockedDuringNativeRequest(params: {
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

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compact-"));
  });

  afterEach(async () => {
    resetCodexAppServerClientFactoryForTest();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns after compact startup while retaining cleanup through completion", async () => {
    const fake = createFakeCodexClient({ autoComplete: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 123 }),
    );

    expectCompactStart(fake.request);
    expect(fake.addNotificationHandler).toHaveBeenCalledTimes(1);
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/compact/start",
    ]);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.result?.tokensBefore).toBe(123);
    expect(result.result?.tokensAfter).toBeUndefined();
    const details = compactDetails(result);
    expect(details.backend).toBe("codex-app-server");
    expect(details.threadId).toBe("thread-1");
    expect(details.signal).toBe("thread/compact/start");
    expect(details.pending).toBe(true);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.nativeContextUsage).toBeUndefined();
    expect(binding?.modelContextWindow).toBe(258_400);
    expect(binding?.contextEngine?.projection).toBeUndefined();

    const nextRoute = getCodexAppServerTurnRouter(fake.client).reserveThread({
      threadId: "thread-1",
      onNotification: vi.fn(),
    });
    nextRoute.release();
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn", status: "completed" },
      },
    });
    await flushAsyncTasks();
    expect(fake.request.mock.calls.map(([method]) => method)).toContain("thread/unsubscribe");
  });

  it("resumes and retains native review turns through completion", async () => {
    const fake = createFakeCodexClient({ autoComplete: false });
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 42_000 },
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    const identity = sessionBindingIdentity({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    const binding = await testCodexAppServerBindingStore.read(identity);
    if (!binding) {
      throw new Error("missing review binding");
    }

    await requestCodexNativeTurnForBinding(
      {
        bindingIdentity: identity,
        bindingStore: testCodexAppServerBindingStore,
        expectedBinding: binding,
        clientLeaseFactory: adaptCodexTestClientFactory(async () => fake.client),
      },
      "review",
    );

    expectReviewStart(fake.request);
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "review/start",
    ]);
    const startedBinding = await readCodexAppServerBinding(sessionFile);
    expect(startedBinding?.threadId).toBe("thread-1");
    expect(startedBinding).not.toHaveProperty("nativeContextUsage");
    expect(startedBinding?.contextEngine?.projection).toMatchObject({ epoch: "epoch-1" });
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "review-turn", status: "completed" },
      },
    });
    await flushAsyncTasks();
    expect(fake.request.mock.calls.map(([method]) => method)).toContain("thread/unsubscribe");
    expect(await readCodexAppServerBinding(sessionFile)).not.toHaveProperty("nativeContextUsage");
  });

  it("releases native review ownership after an exact setup error", async () => {
    const fake = createFakeCodexClient({ autoComplete: false });
    const identity = sessionBindingIdentity({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    await writeTestBinding();
    const binding = await testCodexAppServerBindingStore.read(identity);
    if (!binding) {
      throw new Error("missing review binding");
    }

    await requestCodexNativeTurnForBinding(
      {
        bindingIdentity: identity,
        bindingStore: testCodexAppServerBindingStore,
        expectedBinding: binding,
        clientLeaseFactory: adaptCodexTestClientFactory(async () => fake.client),
      },
      "review",
    );
    fake.emit({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "review-turn",
        error: { message: "review setup failed" },
        willRetry: false,
      },
    });

    await flushAsyncTasks();
    expect(fake.request.mock.calls.map(([method]) => method)).toContain("thread/unsubscribe");
  });

  it("retains the exact review setup error that races ahead of the startup response", async () => {
    const fake = createFakeCodexClient({ autoComplete: false });
    fake.handleRequest("review/start", () => {
      fake.emit({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "review-turn",
          error: { message: "review setup failed" },
          willRetry: false,
        },
      });
      fake.emit({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "other-turn",
          error: { message: "unrelated setup failed" },
          willRetry: false,
        },
      });
      return reviewStartResponse("thread-1");
    });
    const identity = sessionBindingIdentity({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    await writeTestBinding();
    const binding = await testCodexAppServerBindingStore.read(identity);
    if (!binding) {
      throw new Error("missing review binding");
    }

    await requestCodexNativeTurnForBinding(
      {
        bindingIdentity: identity,
        bindingStore: testCodexAppServerBindingStore,
        expectedBinding: binding,
        clientLeaseFactory: adaptCodexTestClientFactory(async () => fake.client),
      },
      "review",
    );

    await flushAsyncTasks();
    expect(fake.request.mock.calls.map(([method]) => method)).toContain("thread/unsubscribe");
  });

  it("releases a healthy client when app-server rejects native review", async () => {
    const fake = createFakeCodexClient({ autoComplete: false });
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    fake.handleRequest("review/start", () => {
      throw new CodexAppServerRpcError(
        { code: -32_000, message: "review rejected" },
        "review/start",
      );
    });
    const identity = sessionBindingIdentity({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 42_000 },
    });
    const binding = await testCodexAppServerBindingStore.read(identity);
    if (!binding) {
      throw new Error("missing review binding");
    }

    await expect(
      requestCodexNativeTurnForBinding(
        {
          bindingIdentity: identity,
          bindingStore: testCodexAppServerBindingStore,
          expectedBinding: binding,
          clientLeaseFactory: async () => ({ client: fake.client, release, abandon }),
        },
        "review",
      ),
    ).rejects.toThrow("review rejected");

    expect(release).toHaveBeenCalledTimes(1);
    expect(abandon).not.toHaveBeenCalled();
    expect(fake.request.mock.calls.map(([method]) => method)).toContain("thread/unsubscribe");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      nativeContextUsage: { currentTokens: 42_000 },
    });
  });

  it("keeps review usage invalidated when startup acceptance is indeterminate", async () => {
    const fake = createFakeCodexClient({ autoComplete: false });
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    fake.handleRequest("review/start", () => {
      throw new Error("review response lost");
    });
    const identity = sessionBindingIdentity({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 42_000 },
    });
    const binding = await testCodexAppServerBindingStore.read(identity);
    if (!binding) {
      throw new Error("missing review binding");
    }

    await expect(
      requestCodexNativeTurnForBinding(
        {
          bindingIdentity: identity,
          bindingStore: testCodexAppServerBindingStore,
          expectedBinding: binding,
          clientLeaseFactory: async () => ({ client: fake.client, release, abandon }),
        },
        "review",
      ),
    ).rejects.toThrow("review response lost");

    expect(release).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledTimes(1);
    const stored = await readCodexAppServerBinding(sessionFile);
    expect(stored).not.toHaveProperty("nativeContextUsage");
  });

  it("retires a native-turn client when wire unsubscribe fails", async () => {
    const fake = createFakeCodexClient();
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    fake.handleRequest("thread/unsubscribe", () => {
      throw new Error("unsubscribe response lost");
    });
    const identity = sessionBindingIdentity({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    await writeTestBinding();
    const binding = await testCodexAppServerBindingStore.read(identity);
    if (!binding) {
      throw new Error("missing review binding");
    }

    await requestCodexNativeTurnForBinding(
      {
        bindingIdentity: identity,
        bindingStore: testCodexAppServerBindingStore,
        expectedBinding: binding,
        clientLeaseFactory: async () => ({ client: fake.client, release, abandon }),
      },
      "review",
    );

    await flushAsyncTasks();
    expect(release).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("does not unsubscribe a thread when abort wins before resume", async () => {
    const fake = createFakeCodexClient({ autoComplete: false });
    const abortController = new AbortController();
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    const identity = sessionBindingIdentity({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    await writeTestBinding();
    const binding = await testCodexAppServerBindingStore.read(identity);
    if (!binding) {
      throw new Error("missing review binding");
    }

    await expect(
      requestCodexNativeTurnForBinding(
        {
          bindingIdentity: identity,
          bindingStore: testCodexAppServerBindingStore,
          expectedBinding: binding,
          abortSignal: abortController.signal,
          clientLeaseFactory: async () => {
            abortController.abort("cancelled");
            return { client: fake.client, release, abandon };
          },
        },
        "review",
      ),
    ).rejects.toThrow("review aborted before native turn startup");

    expect(fake.request).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(abandon).not.toHaveBeenCalled();
  });

  it("requires the context-compaction item instead of treating any turn as startup", async () => {
    const fake = createFakeCodexClient({ autoStart: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    let settled = false;
    const compact = startCompaction(sessionFile).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expectCompactStart(fake.request));
    await flushAsyncTasks();
    expect(settled).toBe(false);

    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-other",
        turn: { id: "compact-turn", status: "inProgress" },
      },
    });
    await flushAsyncTasks();
    expect(settled).toBe(false);

    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "unrelated-turn", status: "inProgress" },
      },
    });
    await flushAsyncTasks();
    expect(settled).toBe(false);

    fake.emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn",
        item: { id: "compact-item", type: "contextCompaction" },
      },
    });
    await expect(compact).resolves.toMatchObject({ ok: true, compacted: false });
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn", status: "completed" },
      },
    });
  });

  it("retains start and completion notifications that arrive before the compact RPC response", async () => {
    const fake = createFakeCodexClient({ autoStart: false });
    const abortController = new AbortController();
    let resolveCompactRequest!: () => void;
    fake.handleRequest(
      "thread/compact/start",
      () =>
        new Promise<void>((resolve) => {
          resolveCompactRequest = resolve;
        }),
    );
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const compact = startCompaction(sessionFile, { abortSignal: abortController.signal });
    await vi.waitFor(() => expectCompactStart(fake.request));

    fake.emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn",
        item: { id: "compact-item", type: "contextCompaction" },
      },
    });
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn", status: "completed" },
      },
    });
    abortController.abort("caller finished");
    resolveCompactRequest();

    await expect(compact).resolves.toMatchObject({ ok: true, compacted: false });
    await flushAsyncTasks();
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/compact/start",
      "thread/unsubscribe",
    ]);
  });

  it("invalidates stale context facts before a compact response can be lost", async () => {
    const fake = createFakeCodexClient();
    fake.handleRequest("thread/compact/start", () => {
      throw new Error("compact response lost");
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "compact response lost",
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({
      threadId: "thread-1",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
      },
    });
    expect(binding).not.toHaveProperty("nativeContextUsage");
    expect(binding?.contextEngine).not.toHaveProperty("projection");
  });

  it("abandons an accepted compact request that never emits turn startup", async () => {
    const fake = createFakeCodexClient({ autoStart: false });
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
        },
        {
          pluginConfig: { appServer: { requestTimeoutMs: 10 } },
          clientLeaseFactory: async () => ({ client: fake.client, release, abandon }),
        },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compact turn did not start for thread thread-1",
    });
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).not.toHaveProperty("nativeContextUsage");
    expect(binding?.contextEngine).not.toHaveProperty("projection");
  });

  it("restores context facts when app-server rejects native compaction", async () => {
    const fake = createFakeCodexClient();
    fake.handleRequest("thread/compact/start", () => {
      throw new CodexAppServerRpcError(
        { code: -32_000, message: "compaction rejected" },
        "thread/compact/start",
      );
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "compaction rejected",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
  });

  it("does not accept an unrelated turn start after compaction is rejected", async () => {
    const fake = createFakeCodexClient({ autoStart: false });
    fake.handleRequest("thread/compact/start", () => {
      fake.emit({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "unrelated-turn", status: "inProgress" },
        },
      });
      throw new CodexAppServerRpcError(
        { code: -32_000, message: "compaction rejected" },
        "thread/compact/start",
      );
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "compaction rejected",
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: { projection: { epoch: "epoch-1" } },
    });
  });

  it("keeps context facts invalidated when another compaction starts before rejection", async () => {
    const fake = createFakeCodexClient({ autoStart: false });
    fake.handleRequest("thread/resume", (params) => {
      const threadId = (params as { threadId: string }).threadId;
      fake.emit({
        method: "item/started",
        params: {
          threadId,
          turnId: "other-compact-turn",
          item: { id: "other-compact-item", type: "contextCompaction" },
        },
      });
      return createThreadResumeResponse(threadId);
    });
    fake.handleRequest("thread/compact/start", () => {
      throw new CodexAppServerRpcError(
        { code: -32_000, message: "compaction rejected" },
        "thread/compact/start",
      );
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "compaction rejected",
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).not.toHaveProperty("nativeContextUsage");
    expect(binding?.contextEngine).not.toHaveProperty("projection");
  });

  it("invalidates context facts when resume observes an active compaction", async () => {
    const fake = createFakeCodexClient({ autoStart: false });
    fake.handleRequest("thread/resume", (params) => {
      const threadId = (params as { threadId: string }).threadId;
      fake.emit({
        method: "item/started",
        params: {
          threadId,
          turnId: "active-compact-turn",
          item: { id: "active-compact-item", type: "contextCompaction" },
        },
      });
      return createThreadResumeResponse(threadId, { type: "active", activeFlags: [] });
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "Codex thread already has an active turn; retry compaction after it finishes",
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).not.toHaveProperty("nativeContextUsage");
    expect(binding?.contextEngine).not.toHaveProperty("projection");
  });

  it("skips native app-server compaction for automatic budget triggers", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        trigger: "budget",
        currentTokenCount: 456,
      }),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server owns automatic compaction");
    expect(result.result?.tokensBefore).toBe(456);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "non_manual_trigger",
      trigger: "budget",
    });
  });

  it("starts native app-server compaction for post-context-engine budget requests", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    expect(fake.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread-1" },
      { timeoutMs: 60_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.result?.tokensBefore).toBe(456);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: true,
      request: "after_context_engine",
      trigger: "budget",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
      },
    });
    expect(
      (await readCodexAppServerBinding(sessionFile))?.contextEngine?.projection,
    ).toBeUndefined();
  });

  it("keeps the Codex thread when context compaction rotates the OpenClaw session", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const rotatedIdentity = sessionBindingIdentity({
      sessionId: "session-2",
      sessionKey: "agent:main:session-1",
    });
    await expect(
      testCodexAppServerBindingStore.adoptSessionGeneration(rotatedIdentity, "session-1"),
    ).resolves.toBe("adopted");

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-2",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    expectCompactStart(fake.request);
    expect(result.ok).toBe(true);
    expect(compactDetails(result)).toMatchObject({
      threadId: "thread-1",
      request: "after_context_engine",
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
    });
  });

  it("preserves projection when aborted before guarded native compaction", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const abortController = new AbortController();
    abortController.abort("cancelled");
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
          abortSignal: abortController.signal,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server compaction aborted before native compaction");
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "aborted_before_native_compaction",
      request: "after_context_engine",
      trigger: "budget",
      expectedThreadId: "thread-1",
      currentThreadId: "thread-1",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      contextEngine: {
        projection: {
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });
  });

  it("commits native compaction when cancellation races the binding invalidation", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const abortController = new AbortController();
    const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: async (...args: Parameters<typeof mutate>) => {
        const result = await mutate(...args);
        if (args[1].kind === "invalidate-native-context") {
          abortController.abort("cancelled during invalidation");
        }
        return result;
      },
    };
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          abortSignal: abortController.signal,
        },
        { allowNonManualNativeRequest: true, bindingStore },
      ),
    );

    expect(result).toMatchObject({ ok: true, compacted: false });
    expect(fake.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread-1" },
      { timeoutMs: 60_000 },
    );
  });

  it("skips post-context-engine native compaction when the binding changes before request", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const originalContextEngine = {
      schemaVersion: 1 as const,
      engineId: "lossless-claw",
      policyFingerprint: "policy-1",
      projection: {
        schemaVersion: 1 as const,
        mode: "thread_bootstrap" as const,
        epoch: "epoch-1",
        fingerprint: "fingerprint-1",
      },
    };
    const sessionFile = await writeTestBinding({
      contextEngine: originalContextEngine,
    });
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      async withLease<T>(
        identity: Parameters<typeof testCodexAppServerBindingStore.withLease>[0],
        run: () => Promise<T>,
      ) {
        await testCodexAppServerBindingStore.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-2",
            cwd: tempDir,
            contextEngine: {
              ...originalContextEngine,
              projection: {
                schemaVersion: 1,
                mode: "thread_bootstrap",
                epoch: "epoch-2",
                fingerprint: "fingerprint-2",
              },
            },
          },
        });
        return await testCodexAppServerBindingStore.withLease(identity, run);
      },
    };

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true, bindingStore },
      ),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server binding changed before native compaction");
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "binding_changed_before_native_compaction",
      request: "after_context_engine",
      trigger: "budget",
      expectedThreadId: "thread-1",
      currentThreadId: "thread-2",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-2",
      contextEngine: {
        projection: {
          epoch: "epoch-2",
          fingerprint: "fingerprint-2",
        },
      },
    });
  });

  it("blocks same-process binding writes until guarded native compaction starts", async () => {
    let releaseExternalWrite!: () => void;
    const externalWriteGate = new Promise<void>((resolve) => {
      releaseExternalWrite = resolve;
    });
    let externalWriteStarted = false;
    let externalWriteFinished = false;
    const fake = createFakeCodexClient();
    fake.handleRequest("thread/compact/start", () =>
      expectExternalMutationBlockedDuringNativeRequest({
        releaseExternalMutation: releaseExternalWrite,
        isExternalMutationStarted: () => externalWriteStarted,
        isExternalMutationFinished: () => externalWriteFinished,
      }),
    );
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });
    const externalWrite = (async () => {
      await externalWriteGate;
      externalWriteStarted = true;
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-2",
        cwd: tempDir,
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint: "policy-2",
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-2",
          },
        },
      });
      externalWriteFinished = true;
    })();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    await externalWrite;
    expect(fake.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread-1" },
      { timeoutMs: 60_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-2",
      contextEngine: {
        policyFingerprint: "policy-2",
        projection: {
          epoch: "epoch-2",
        },
      },
    });
  });

  it("blocks same-process binding clears until guarded native compaction starts", async () => {
    let releaseExternalClear!: () => void;
    const externalClearGate = new Promise<void>((resolve) => {
      releaseExternalClear = resolve;
    });
    let externalClearStarted = false;
    let externalClearFinished = false;
    const fake = createFakeCodexClient();
    fake.handleRequest("thread/compact/start", () =>
      expectExternalMutationBlockedDuringNativeRequest({
        releaseExternalMutation: releaseExternalClear,
        isExternalMutationStarted: () => externalClearStarted,
        isExternalMutationFinished: () => externalClearFinished,
      }),
    );
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });
    const externalClear = (async () => {
      await externalClearGate;
      externalClearStarted = true;
      const cleared = await clearCodexAppServerBindingForThread(sessionFile, "thread-1");
      externalClearFinished = true;
      expect(cleared).toBe(true);
    })();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    await externalClear;
    expect(fake.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread-1" },
      { timeoutMs: 60_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("skips native app-server compaction when trigger is omitted", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        currentTokenCount: 789,
      }),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server owns automatic compaction");
    expect(result.result?.tokensBefore).toBe(789);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "non_manual_trigger",
      trigger: "unknown",
    });
  });

  it("blocks native app-server compaction when the current OpenClaw session is sandboxed", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(await startSandboxedCompaction(sessionFile));

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain(
      "Codex-native native compaction is unavailable because OpenClaw sandboxing is active for this session.",
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("blocks native app-server compaction when exec host=node is active", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(await startNodeExecCompaction(sessionFile));

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain(
      "Codex-native native compaction is unavailable because OpenClaw exec host=node is active for this session.",
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("rejects an active resumed turn before invalidating binding facts", async () => {
    const fake = createFakeCodexClient();
    fake.handleRequest("thread/resume", () =>
      createThreadResumeResponse("thread-1", { type: "active", activeFlags: [] }),
    );
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      nativeContextUsage: { currentTokens: 220_000 },
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "Codex thread already has an active turn; retry compaction after it finishes",
    });
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/unsubscribe",
    ]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      nativeContextUsage: { currentTokens: 220_000 },
      contextEngine: { projection: { epoch: "epoch-1" } },
    });
  });

  it("does not unsubscribe another owner when the thread route is already reserved", async () => {
    const fake = createFakeCodexClient();
    const activeRoute = getCodexAppServerTurnRouter(fake.client).reserveThread({
      threadId: "thread-1",
      onNotification: vi.fn(),
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(await startCompaction(sessionFile));
    activeRoute.release();

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server thread route already reserved: thread-1",
    });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("does not consume native completion notifications after forwarding the request", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 123 }),
    );
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          last: {
            totalTokens: 0,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.result?.tokensAfter).toBeUndefined();
    expect(compactDetails(result).tokenUsageSource).toBeUndefined();
    expect(compactDetails(result).signal).toBe("thread/compact/start");
  });

  it("reuses the bound auth profile for native compaction", async () => {
    const fake = createFakeCodexClient();
    let seenAuthProfileId: string | undefined;
    setCodexAppServerClientFactoryForTest(async (_startOptions, authProfileId) => {
      seenAuthProfileId = authProfileId;
      return fake.client;
    });
    const sessionFile = await writeTestBinding({ authProfileId: "openai:work" });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(seenAuthProfileId).toBe("openai:work");
    expect(result.ok).toBe(true);
  });

  it("reports missing thread bindings as failed native compaction", async () => {
    const sessionFile = path.join(tempDir, "missing-binding.jsonl");

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 123 }),
    );

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no codex app-server thread binding");
    expect(result.failure?.reason).toBe("missing_thread_binding");
    expect(result.result).toBeUndefined();
  });

  it("resumes a persisted thread before starting native compaction", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      authProfileId: "openai:work",
      model: "gpt-5.5-mini",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: "priority",
      nativeContextUsage: { currentTokens: 220_000 },
      modelContextWindow: 258_400,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );
    await flushAsyncTasks();

    expect(
      fake.request.mock.calls.map(([method, requestParams]) => [method, requestParams]),
    ).toEqual([
      ["thread/resume", { threadId: "thread-1", excludeTurns: true, persistExtendedHistory: true }],
      ["thread/compact/start", { threadId: "thread-1" }],
      ["thread/unsubscribe", { threadId: "thread-1" }],
    ]);
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-1");
    expect(preservedBinding?.authProfileId).toBe("openai:work");
    expect(preservedBinding?.model).toBe("gpt-5.5-mini");
    expect(preservedBinding?.approvalPolicy).toBe("on-request");
    expect(preservedBinding?.sandbox).toBe("workspace-write");
    expect(preservedBinding?.serviceTier).toBe("priority");
    expect(preservedBinding?.nativeContextUsage).toBeUndefined();
    expect(preservedBinding?.modelContextWindow).toBe(258_400);
    expect(preservedBinding?.contextEngine?.projection).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: true,
    });
  });

  it("preserves stale binding metadata when the persisted thread is missing", async () => {
    const fake = createFakeCodexClient();
    fake.handleRequest("thread/resume", () => {
      throw new CodexAppServerRpcError(
        { code: -32_000, message: "thread not found: thread-1" },
        "thread/resume",
      );
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({ authProfileId: "openai:work" });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      authProfileId: "openai:work",
    });
    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-1",
      failure: { reason: "stale_thread_binding" },
    });
  });

  it("does not start compaction when the resume response is lost", async () => {
    const fake = createFakeCodexClient();
    fake.handleRequest("thread/resume", () => {
      throw new Error("resume response lost");
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({ ok: false, reason: "resume response lost" });
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
  });

  it("abandons a corrupt client when resume returns a different thread", async () => {
    const fake = createFakeCodexClient();
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    let settled = false;
    fake.handleRequest("thread/resume", () => createThreadResumeResponse("thread-other"));
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
        },
        {
          clientLeaseFactory: async () => ({
            client: fake.client,
            release: () => {
              if (!settled) {
                settled = true;
                release();
              }
            },
            abandon: async () => {
              if (!settled) {
                settled = true;
                await abandon();
              }
            },
          }),
        },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "Codex thread/resume returned thread-other for thread-1",
    });
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(release).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("does not impose an OpenClaw timeout after Codex accepts native compaction", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: true,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
    expect(await readCodexAppServerBinding(sessionFile)).toBeDefined();
  });

  it("fails closed when the persisted binding auth profile disagrees with the runtime request", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const sessionFile = await writeTestBinding({
      authProfileId: "openai:binding",
    });

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      authProfileId: "openai:runtime",
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "auth profile mismatch for session binding",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("forwards compaction to native Codex even when a context engine owns compaction", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 123,
      },
    }));
    const maintain = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["maintain"]>>[0]) => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }),
    );
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
      maintain,
    };

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        contextEngine,
        contextEngineRuntimeContext: { workspaceDir: tempDir, provider: "codex" },
        currentTokenCount: 123,
        trigger: "manual",
      }),
    );

    expectCompactStart(fake.request);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: true,
    });
    expect(compact).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
    });
  });

  it("requires a Codex binding instead of delegating to an owning context engine", async () => {
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 123,
      },
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: path.join(tempDir, "missing-binding.jsonl"),
      workspaceDir: tempDir,
      contextEngine,
      trigger: "manual",
    });

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      failure: { reason: "missing_thread_binding" },
    });
    expect(compact).not.toHaveBeenCalled();
  });
});

function createFakeCodexClient(options: { autoStart?: boolean; autoComplete?: boolean } = {}): {
  client: CodexAppServerClient;
  request: ReturnType<typeof vi.fn<CodexAppServerClient["request"]>>;
  close: ReturnType<typeof vi.fn>;
  addNotificationHandler: ReturnType<typeof vi.fn>;
  emit: (notification: CodexServerNotification) => void;
  handleRequest: (method: string, handler: (params: unknown) => unknown) => void;
} {
  const handlers = new Set<(notification: CodexServerNotification) => void>();
  const closeHandlers = new Set<() => void>();
  const requestHandlers = new Set<() => undefined>();
  const requestOverrides = new Map<string, (params: unknown) => unknown>();
  let emit = (_notification: CodexServerNotification): void => undefined;
  const request = vi.fn<CodexAppServerClient["request"]>(
    async (method: string, params: unknown) => {
      const override = requestOverrides.get(method);
      const overrideResult = override ? await override(params) : undefined;
      if (method === "thread/resume") {
        if (override) {
          return overrideResult as never;
        }
        const threadId = (params as { threadId: string }).threadId;
        return createThreadResumeResponse(threadId) as never;
      }
      if (method === "review/start") {
        const threadId = (params as { threadId: string }).threadId;
        if (options.autoComplete !== false) {
          queueMicrotask(() => {
            emit({
              method: "turn/completed",
              params: { threadId, turn: { id: "review-turn", status: "completed" } },
            });
          });
        }
        return (overrideResult ?? reviewStartResponse(threadId)) as never;
      }
      if (method === "thread/compact/start" && options.autoStart !== false) {
        const threadId = (params as { threadId: string }).threadId;
        const turnId = "compact-turn";
        queueMicrotask(() => {
          emit({
            method: "turn/started",
            params: { threadId, turn: { id: turnId, status: "inProgress" } },
          });
          emit({
            method: "item/started",
            params: {
              threadId,
              turnId,
              item: { id: "compact-item", type: "contextCompaction" },
            },
          });
          if (options.autoComplete !== false) {
            queueMicrotask(() => {
              emit({
                method: "turn/completed",
                params: { threadId, turn: { id: turnId, status: "completed" } },
              });
            });
          }
        });
      }
      return (overrideResult ?? {}) as never;
    },
  );
  const close = vi.fn(() => {
    for (const handler of closeHandlers) {
      handler();
    }
  });
  const addNotificationHandler = vi.fn(
    (handler: (notification: CodexServerNotification) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  );
  const addRequestHandler = vi.fn((handler: () => undefined) => {
    requestHandlers.add(handler);
    return () => requestHandlers.delete(handler);
  });
  const addCloseHandler = vi.fn((handler: () => void) => {
    closeHandlers.add(handler);
    return () => closeHandlers.delete(handler);
  });
  emit = (notification) => {
    for (const handler of handlers) {
      handler(notification);
    }
  };
  return {
    client: {
      request,
      close,
      addNotificationHandler,
      addRequestHandler,
      addCloseHandler,
    } as unknown as CodexAppServerClient,
    request,
    close,
    addNotificationHandler,
    emit,
    handleRequest(method, handler): void {
      requestOverrides.set(method, handler);
    },
  };
}

function reviewStartResponse(threadId: string): JsonValue {
  return {
    turn: {
      id: "review-turn",
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
    reviewThreadId: threadId,
  };
}

function createThreadResumeResponse(
  threadId: string,
  status: { type: "idle" } | { type: "active"; activeFlags: string[] } = { type: "idle" },
) {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status,
      path: null,
      cwd: "/repo",
      cliVersion: "0.139.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.5-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/repo",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}
