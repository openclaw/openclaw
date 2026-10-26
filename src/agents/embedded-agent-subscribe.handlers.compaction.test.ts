import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { seedSessionStore } from "./embedded-agent-subscribe.compaction-test-helpers.js";
import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
} from "./embedded-agent-subscribe.e2e-harness.js";
import reconcileSessionStoreCompactionCountAfterSuccess from "./embedded-agent-subscribe.handlers.compaction.runtime.js";
import { handleCompactionEnd } from "./embedded-agent-subscribe.handlers.lifecycle.js";
import { createContext } from "./embedded-agent-subscribe.handlers.lifecycle.test-helpers.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentMessage } from "./runtime/index.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import { makeZeroUsageSnapshot } from "./usage.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-compaction-handler-");

function createCompactionContext(messages: AgentMessage[] = []): EmbeddedAgentSubscribeContext {
  const ctx = createContext(undefined);
  let compactionCount = 0;
  Object.assign(ctx.params, {
    runId: "run-test",
    session: Object.assign(createStubSessionHarness().session, { messages }),
    sessionPersistence: "detached",
    agentId: "test-agent",
  });
  Object.assign(ctx, {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    ensureCompactionPromise: vi.fn(),
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    getCompactionCount: () => compactionCount,
    noteCompactionTokensAfter: vi.fn(),
  });
  return ctx;
}

function assistant(timestamp?: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    stopReason: "stop",
    usage: { ...createZeroUsageFixture(), input: 123_000, totalTokens: 123_000 },
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as AgentMessage;
}
function summary(timestamp?: number): AgentMessage {
  return {
    role: "compactionSummary",
    summary: "compressed",
    tokensBefore: 120_000,
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as AgentMessage;
}
const completed = {
  status: "completed",
  tokensBefore: 100,
  tokensAfter: 50,
  willRetry: false,
} as const;
const endEvent = (
  outcome: Parameters<typeof handleCompactionEnd>[1]["outcome"] = completed,
  reason: Parameters<typeof handleCompactionEnd>[1]["reason"] = "threshold",
) => ({ type: "compaction_end" as const, reason, outcome });
const usage = (messages: AgentMessage[]) =>
  messages.filter((message) => message.role === "assistant").map((message) => message.usage);

describe("compaction handlers", () => {
  it("keeps failure details in client events, not logs, while preserving live usage", async () => {
    const messages = [assistant(1_000)];
    const before = usage(messages);
    const ctx = createCompactionContext(messages);
    const onAgentEvent = vi.fn();
    ctx.params.onAgentEvent = onAgentEvent;
    const privateMarker = "private_compaction_payload";
    const reason = `Provider unavailable: ${privateMarker.repeat(100)}`;
    await handleCompactionEnd(ctx, endEvent({ status: "failed", reason }, "overflow"));
    expect(ctx.log.warn).toHaveBeenCalledExactlyOnceWith(
      "embedded run auto-compaction failed",
      expect.objectContaining({
        event: "embedded_run_compaction_end",
        reason: "overflow",
        outcome: "failed",
        reasonClass: "unknown",
      }),
    );
    expect(JSON.stringify(vi.mocked(ctx.log.warn).mock.calls)).not.toContain(privateMarker);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: { phase: "end", completed: false, willRetry: false, outcome: "failed", reason },
    });
    expect(usage(messages)).toEqual(before);
  });

  it.each([
    ["default subscription floor", {}, 2, 2],
    ["caller-owned accounting", { compactionCountOwner: "caller" }, 1, 2],
    ["detached subscription", { sessionPersistence: "detached" }, 1, 0],
  ] as const)(
    "preserves local compaction facts under %s",
    async (_name, options, expectedCount, expectedEventCount) => {
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const agentId = "test-agent";
      const runId = `run-compaction-owner-${randomUUID()}`;
      const sessionKey = `agent:${agentId}:${runId}`;
      await seedSessionStore({ storePath, sessionKey, compactionCount: 1 });
      const before = structuredClone(
        loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
      );
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        ...options,
        runId,
        sessionId: "session-1",
        sessionKey,
        agentId,
        config: { session: { store: storePath } },
        sessionExtras: { messages: [] },
        onAgentEvent,
      });
      const sql =
        "compactionCountOwner" in options && options.compactionCountOwner === "caller"
          ? observeMainThreadSql()
          : undefined;
      try {
        sql?.calibrate();
        emit(endEvent());
        emit(endEvent());
        await subscription.waitForPendingEvents();
        if (sql) {
          expect(sql.count()).toBe(0);
          sql.restore();
        }
        await vi.dynamicImportSettled();
        // Join the writer queue without advancing the seeded floor.
        await reconcileSessionStoreCompactionCountAfterSuccess({
          sessionKey,
          agentId,
          configStore: storePath,
          observedCompactionCount: 1,
        });
        expect(subscription.getCompactionCount()).toBe(2);
        expect(subscription.getLastCompactionTokensAfter()).toBe(50);
        expect(onAgentEvent).toHaveBeenCalledTimes(2);
        expect(onAgentEvent).toHaveBeenCalledWith({
          stream: "compaction",
          data: { phase: "end", completed: true, willRetry: false, outcome: "completed" },
        });
        const events = (await listSessionStateEventsSince(sessionKey, agentId, 0)).events.filter(
          (event) => event.runId === runId,
        );
        expect(events).toHaveLength(expectedEventCount);
        expect(events.every((event) => event.kind === "compacted")).toBe(true);
        const after = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
        expect(after?.compactionCount).toBe(expectedCount);
        if (expectedCount === 1) {
          expect(after).toEqual(before);
        }
      } finally {
        sql?.restore();
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    ["aborted usage is preserved", [assistant(1_000)], [false], { status: "aborted" }],
    [
      "timestamps override transcript order",
      [assistant(3_000), summary(2_000), assistant(1_000)],
      [false, true],
      completed,
    ],
    [
      "legacy entries use summary position",
      [assistant(), summary(), assistant()],
      [true, false],
      completed,
    ],
  ] satisfies Array<[string, AgentMessage[], boolean[], Parameters<typeof endEvent>[0]]>)(
    "%s",
    async (_name, messages, stale, outcome) => {
      const before = usage(messages);
      await handleCompactionEnd(createCompactionContext(messages), endEvent(outcome));
      expect(usage(messages)).toEqual(
        stale.map((isStale, index) => (isStale ? makeZeroUsageSnapshot() : before[index])),
      );
    },
  );
});
