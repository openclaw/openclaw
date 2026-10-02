import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { seedSessionStore } from "./embedded-agent-subscribe.compaction-test-helpers.js";
import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  handleCompactionEnd,
  handleCompactionStart,
} from "./embedded-agent-subscribe.handlers.compaction.js";
import reconcileSessionStoreCompactionCountAfterSuccess from "./embedded-agent-subscribe.handlers.compaction.runtime.js";
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
const completedCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "threshold",
    outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: false },
  }) as const;
const usage = (messages: AgentMessage[]) =>
  messages.filter((message) => message.role === "assistant").map((message) => message.usage);

describe("compaction handlers", () => {
  it("normalizes unknown compaction starts and reports successful completion", () => {
    const ctx = createCompactionContext();
    handleCompactionStart(ctx, { type: "compaction_start" });
    handleCompactionEnd(ctx, completedCompactionEnd());
    expect(vi.mocked(ctx.log.info).mock.calls[0]?.[1]).toMatchObject({
      event: "embedded_run_compaction_start",
      reason: "threshold",
      runId: "run-test",
    });
    expect(vi.mocked(ctx.log.info).mock.calls[1]?.[1]).toMatchObject({
      event: "embedded_run_compaction_end",
      reason: "threshold",
      completed: true,
      compactionCount: 1,
    });
  });

  it("logs a benign manual skip at info", () => {
    const ctx = createCompactionContext();
    handleCompactionStart(ctx, { type: "compaction_start", reason: "manual" });
    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "manual",
      outcome: { status: "skipped", reason: "Nothing to compact (session too small)" },
    });
    expect(vi.mocked(ctx.log.info).mock.calls[0]?.[1]).toMatchObject({ reason: "manual" });
    expect(vi.mocked(ctx.log.info).mock.calls[1]?.[1]).toMatchObject({
      outcome: "skipped",
      completed: false,
      reasonClass: "no_compactable_entries",
    });
  });

  it("bounds unknown failure diagnostics while preserving live usage", () => {
    const messages = [assistant(1_000)];
    const before = usage(messages);
    const ctx = createCompactionContext(messages);
    const reason = `Provider unavailable: ${"provider detail ".repeat(100)}`;
    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "overflow",
      outcome: { status: "failed", reason },
    });
    expect(ctx.log.warn).toHaveBeenCalledExactlyOnceWith(
      "embedded run auto-compaction failed",
      expect.objectContaining({
        event: "embedded_run_compaction_end",
        reason: "overflow",
        outcome: "failed",
        reasonClass: "unknown",
        outcomeReason: reason,
        reasonDetail: expect.stringMatching(/^.{100}$/),
        consoleMessage: expect.not.stringContaining("provider detail provider detail"),
      }),
    );
    expect(usage(messages)).toEqual(before);
  });

  it.each([
    { name: "default subscription floor", options: {}, expectedCount: 2, expectedEventCount: 2 },
    {
      name: "caller-owned accounting",
      options: { compactionCountOwner: "caller" },
      expectedCount: 1,
      expectedEventCount: 2,
    },
    {
      name: "detached subscription",
      options: { sessionPersistence: "detached" },
      expectedCount: 1,
      expectedEventCount: 0,
    },
  ] as const)(
    "preserves local compaction facts under $name",
    async ({ options, expectedCount, expectedEventCount }) => {
      const tmp = sessionDirs.make();
      const storePath = path.join(tmp, "sessions.json");
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
      try {
        emit(completedCompactionEnd());
        emit(completedCompactionEnd());
        await subscription.waitForPendingEvents();
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
        subscription.unsubscribe();
      }
    },
  );

  it("preserves live usage when compaction is aborted", () => {
    const messages = [assistant(1_000)];
    const before = usage(messages);
    handleCompactionEnd(createCompactionContext(messages), {
      type: "compaction_end",
      reason: "threshold",
      outcome: { status: "aborted" },
    });
    expect(usage(messages)).toEqual(before);
  });

  it.each([
    {
      name: "timestamps override transcript order",
      messages: [assistant(3_000), summary(2_000), assistant(1_000)],
      stale: [false, true],
    },
    {
      name: "legacy entries use summary position",
      messages: [assistant(), summary(), assistant()],
      stale: [true, false],
    },
    {
      name: "marker-free compaction clears every old snapshot",
      messages: [assistant(), { role: "user", content: "question", timestamp: 0 }, assistant()],
      stale: [true, true],
    },
  ] satisfies Array<{ name: string; messages: AgentMessage[]; stale: boolean[] }>)(
    "$name",
    ({ messages, stale }) => {
      const before = usage(messages);
      handleCompactionEnd(createCompactionContext(messages), completedCompactionEnd());
      expect(usage(messages)).toEqual(
        stale.map((isStale, index) => (isStale ? makeZeroUsageSnapshot() : before[index])),
      );
    },
  );
});
