import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import * as publication from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

const subscribe = (...args: Parameters<typeof publication.subscribeSubagentRunChanges>) =>
  onTestFinished(publication.subscribeSubagentRunChanges(...args));

it.each(["memory", "persistence", "projection failure"] as const)(
  "publishes projections before session and persistence observers: %s",
  (source) => {
    const order: string[] = [];
    const revision = publication.getSubagentRegistryPublicationRevision();
    const event = { runIds: ["run"], sessionKeys: ["child", undefined, "child"] };
    const failure = new Error("projection failed");
    subscribe("projection", (published) => {
      expect(published).toEqual(event);
      expect(publication.getSubagentRegistryPublicationRevision()).toBe(revision + 1);
      if (source === "projection failure") {
        throw failure;
      }
      order.push("projection");
    });
    const session = vi.fn(() => order.push("session"));
    onTestFinished(sessionChanges.subscribe(session));
    const persisted = vi.fn<Parameters<typeof publication.subscribeSubagentRunChanges>[1]>(
      (published) => {
        expect(published).toEqual(event);
        order.push("persistence");
        throw new Error("observer failed");
      },
    );
    subscribe("persistence", persisted);
    subscribe("persistence", () => order.push("last"));

    const publish = () =>
      publication.publishSubagentRunChanges(
        event.sessionKeys,
        event.runIds,
        source === "memory" ? "memory" : "persistence",
      );
    if (source === "projection failure") {
      expect(publish).toThrow(failure);
      expect([session.mock.calls, persisted.mock.calls]).toEqual([[], []]);
      return;
    }
    expect(publish).not.toThrow();
    expect(session).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey: "child" }),
    );
    expect(order).toEqual(
      source === "memory"
        ? ["projection", "session"]
        : ["projection", "session", "persistence", "last"],
    );
    expect(persisted).toHaveBeenCalledTimes(source === "memory" ? 0 : 1);
  },
);

afterEach(() => vi.useRealTimers());

it.each([
  { schedule: "scheduleError", retainCustody: false },
  { schedule: "scheduleTimeout", retainCustody: false },
  { schedule: "scheduleCancellation", retainCustody: false },
  { schedule: "scheduleError", retainCustody: true },
] as const)(
  "$schedule cannot settle a same-ID successor (retained custody=$retainCustody)",
  ({ schedule, retainCustody }) => {
    vi.useFakeTimers();
    const original = createSubagentRunRecord({ runId: "reused", generation: 1 });
    const runs = new Map([[original.runId, original]]);
    const completeInBackground = vi.fn();
    const scheduler = createPendingLifecycleScheduler({ runs, completeInBackground });
    const scheduleEntry = (expectedEntry: SubagentRunRecord, endedAt: number) =>
      scheduler[schedule]({ runId: expectedEntry.runId, expectedEntry, endedAt, error: "failure" });
    scheduleEntry(original, 123);
    const successor = retainCustody
      ? copySubagentRunRuntimeOwner(original, { ...original, generation: 2 })
      : createSubagentRunRecord({ runId: original.runId, generation: 2 });
    runs.set(original.runId, successor);

    vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);

    expect(completeInBackground).not.toHaveBeenCalled();
    scheduleEntry(successor, 456);
    vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
    expect(completeInBackground).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: successor.runId, endedAt: 456, expectedEntry: successor }),
      expect.any(String),
    );
  },
);
