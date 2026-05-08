import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./pi-embedded-subscribe.compaction-test-helpers.js";
import {
  handleCompactionEnd,
  reconcileSessionStoreCompactionCountAfterSuccess,
} from "./pi-embedded-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const TEST_AGENT_ID = "test-agent";

function useStateDir(stateDir: string): void {
  process.env.OPENCLAW_STATE_DIR = stateDir;
}

function createCompactionContext(params: {
  sessionKey: string;
  agentId?: string;
  initialCount: number;
}): EmbeddedPiSubscribeContext {
  let compactionCount = params.initialCount;
  return {
    params: {
      runId: "run-test",
      session: { messages: [] } as never,
      config: {} as never,
      sessionKey: params.sessionKey,
      sessionId: "session-1",
      agentId: params.agentId ?? TEST_AGENT_ID,
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

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("reconcileSessionStoreCompactionCountAfterSuccess", () => {
  it("raises the stored compaction count to the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-reconcile-"));
    useStateDir(tmp);
    const sessionKey = "main";
    await seedSessionStore({
      agentId: TEST_AGENT_ID,
      sessionKey,
      compactionCount: 1,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: TEST_AGENT_ID,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(2);
    expect(await readCompactionCount(TEST_AGENT_ID, sessionKey)).toBe(2);
  });

  it("does not double count when the store is already at or above the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-idempotent-"));
    useStateDir(tmp);
    const sessionKey = "main";
    await seedSessionStore({
      agentId: TEST_AGENT_ID,
      sessionKey,
      compactionCount: 3,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: TEST_AGENT_ID,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(3);
    expect(await readCompactionCount(TEST_AGENT_ID, sessionKey)).toBe(3);
  });
});

describe("handleCompactionEnd", () => {
  it("reconciles the session store after a successful compaction end event", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-handler-"));
    useStateDir(tmp);
    const sessionKey = "main";
    await seedSessionStore({
      agentId: TEST_AGENT_ID,
      sessionKey,
      compactionCount: 1,
    });

    const ctx = createCompactionContext({
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
      agentId: TEST_AGENT_ID,
      sessionKey,
      expected: 2,
    });

    expect(await readCompactionCount(TEST_AGENT_ID, sessionKey)).toBe(2);
    expect(ctx.noteCompactionTokensAfter).toHaveBeenCalledWith(undefined);
  });
});
