import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainSessionStoreLockQueuesForTest,
  resetSessionStoreLockRuntimeForTests,
  setSessionWriteLockAcquirerForTests,
} from "../config/sessions.js";
import type { HookRunner } from "../plugins/hooks.js";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./pi-embedded-subscribe.compaction-test-helpers.js";
const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeCompaction: vi.fn<HookRunner["runBeforeCompaction"]>(),
  runAfterCompaction: vi.fn<HookRunner["runAfterCompaction"]>(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeCompaction: hookRunnerMocks.runBeforeCompaction,
      runAfterCompaction: hookRunnerMocks.runAfterCompaction,
    }) as unknown as HookRunner,
}));

import {
  handleCompactionStart,
  handleCompactionEnd,
  reconcileSessionStoreCompactionCountAfterSuccess,
} from "./pi-embedded-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

function createCompactionContext(params: {
  storePath: string;
  sessionKey: string;
  agentId?: string;
  initialCount: number;
  messageProvider?: string;
}): EmbeddedPiSubscribeContext {
  let compactionCount = params.initialCount;
  return {
    params: {
      runId: "run-test",
      session: { messages: [] } as never,
      config: { session: { store: params.storePath } } as never,
      sessionKey: params.sessionKey,
      sessionId: "session-1",
      agentId: params.agentId ?? "test-agent",
      messageProvider: params.messageProvider,
      onAgentEvent: undefined,
    },
    state: {
      compactionInFlight: true,
      pendingCompactionRetry: 0,
    } as never,
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    getCompactionCount: () => compactionCount,
    noteCompactionTokensAfter: vi.fn(),
    getLastCompactionTokensAfter: vi.fn(() => undefined),
  } as unknown as EmbeddedPiSubscribeContext;
}

beforeEach(() => {
  setSessionWriteLockAcquirerForTests(async () => ({
    release: async () => {},
  }));
  hookRunnerMocks.hasHooks.mockReset();
  hookRunnerMocks.runBeforeCompaction.mockReset();
  hookRunnerMocks.runAfterCompaction.mockReset();
  hookRunnerMocks.runBeforeCompaction.mockResolvedValue(undefined);
  hookRunnerMocks.runAfterCompaction.mockResolvedValue(undefined);
});

afterEach(async () => {
  resetSessionStoreLockRuntimeForTests();
  await drainSessionStoreLockQueuesForTest();
});

describe("reconcileSessionStoreCompactionCountAfterSuccess", () => {
  it("raises the stored compaction count to the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-reconcile-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });

  it("does not double count when the store is already at or above the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-idempotent-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 3,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(3);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(3);
  });
});

describe("handleCompactionStart", () => {
  it("passes messageProvider into before_compaction hook context", async () => {
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_compaction");
    const ctx = createCompactionContext({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:feishu:default:direct:ou_test",
      initialCount: 1,
      messageProvider: "feishu",
    });

    handleCompactionStart(ctx);
    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeCompaction).toHaveBeenCalledTimes(1));
    expect(hookRunnerMocks.runBeforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ messageCount: 0 }),
      expect.objectContaining({
        sessionKey: "agent:main:feishu:default:direct:ou_test",
        messageProvider: "feishu",
      }),
    );
  });

  it("normalizes messageProvider before emitting compaction hook context", async () => {
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_compaction");
    const ctx = createCompactionContext({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:telegram:direct:ou_test",
      initialCount: 1,
      messageProvider: "Telegram",
    });

    handleCompactionStart(ctx);
    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeCompaction).toHaveBeenCalledTimes(1));
    expect(hookRunnerMocks.runBeforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ messageCount: 0 }),
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:ou_test",
        messageProvider: "telegram",
      }),
    );
  });
});

describe("handleCompactionEnd", () => {
  it("reconciles the session store after a successful compaction end event", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-handler-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 1,
    });

    handleCompactionEnd(ctx, {
      type: "compaction_end",
      result: { kept: 12 },
      willRetry: false,
      aborted: false,
    } as never);

    await waitForCompactionCount({
      storePath,
      sessionKey,
      expected: 2,
    });

    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
    expect(ctx.noteCompactionTokensAfter).toHaveBeenCalledWith(undefined);
  });
});
