import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import {
  getSubagentRegistryPublicationRevision,
  publishSubagentRunChanges,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

it.each(["memory", "persistence"] as const)(
  "publishes %s projections before session observers and wakes persistence observers last",
  (source) => {
    const order: string[] = [];
    const revision = getSubagentRegistryPublicationRevision();
    const event = { runIds: ["run"], sessionKeys: ["child", undefined, "child"] };
    onTestFinished(
      subscribeSubagentRunChanges("projection", (published) => {
        expect(published).toEqual(event);
        expect(getSubagentRegistryPublicationRevision()).toBe(revision + 1);
        order.push("projection");
      }),
    );
    onTestFinished(
      sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === "child") {
          order.push("session");
        }
      }),
    );
    const persisted = vi.fn<Parameters<typeof subscribeSubagentRunChanges>[1]>((published) => {
      expect(published).toEqual(event);
      order.push("persistence");
      throw new Error("observer failed");
    });
    onTestFinished(subscribeSubagentRunChanges("persistence", persisted));
    onTestFinished(subscribeSubagentRunChanges("persistence", () => order.push("last")));

    expect(() => publishSubagentRunChanges(event.sessionKeys, event.runIds, source)).not.toThrow();
    expect(order).toEqual(
      source === "memory"
        ? ["projection", "session"]
        : ["projection", "session", "persistence", "last"],
    );
    expect(persisted).toHaveBeenCalledTimes(source === "memory" ? 0 : 1);
  },
);

it("propagates projection failures before session or persistence observers run", () => {
  const failure = new Error("projection failed");
  const session = vi.fn();
  const persisted = vi.fn();
  onTestFinished(
    subscribeSubagentRunChanges("projection", () => {
      throw failure;
    }),
  );
  onTestFinished(sessionChanges.subscribe(session));
  onTestFinished(subscribeSubagentRunChanges("persistence", persisted));

  expect(() => publishSubagentRunChanges(["child"], ["run"], "persistence")).toThrow(failure);
  expect(session).not.toHaveBeenCalled();
  expect(persisted).not.toHaveBeenCalled();
});

describe("pending lifecycle registration ownership", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["scheduleError", "scheduleTimeout", "scheduleCancellation"] as const)(
    "%s cannot settle a same-ID successor",
    (schedule) => {
      vi.useFakeTimers();
      const original = createSubagentRunRecord({ runId: "reused", generation: 1 });
      const runs = new Map([[original.runId, original]]);
      const completeInBackground = vi.fn();
      const scheduler = createPendingLifecycleScheduler({ runs, completeInBackground });
      scheduler[schedule]({
        runId: original.runId,
        expectedEntry: original,
        endedAt: 123,
        error: "old failure",
      });
      const successor = createSubagentRunRecord({ runId: original.runId, generation: 2 });
      runs.set(original.runId, successor);

      vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);

      expect(completeInBackground).not.toHaveBeenCalled();
      scheduler[schedule]({
        runId: successor.runId,
        expectedEntry: successor,
        endedAt: 456,
        error: "new failure",
      });
      vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
      expect(completeInBackground).toHaveBeenCalledOnce();
      expect(completeInBackground).toHaveBeenCalledWith(
        expect.objectContaining({ runId: successor.runId, endedAt: 456, expectedEntry: successor }),
        expect.any(String),
      );
    },
  );

  it("rejects a registration whose generation changes while retaining runtime custody", () => {
    vi.useFakeTimers();
    const entry = createSubagentRunRecord({ runId: "rotated", generation: 1 });
    const completeInBackground = vi.fn();
    const runs = new Map([[entry.runId, entry]]);
    const scheduler = createPendingLifecycleScheduler({
      runs,
      completeInBackground,
    });
    scheduler.scheduleError({
      runId: entry.runId,
      expectedEntry: entry,
      endedAt: 123,
      error: "old failure",
    });
    runs.set(entry.runId, copySubagentRunRuntimeOwner(entry, { ...entry, generation: 2 }));

    vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);

    expect(completeInBackground).not.toHaveBeenCalled();
  });
});
