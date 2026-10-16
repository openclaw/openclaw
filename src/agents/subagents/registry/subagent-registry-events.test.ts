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

it.each(["memory", "persistence", "projection failure"] as const)(
  "publishes projections before session and persistence observers: %s",
  (source) => {
    const order: string[] = [];
    const revision = getSubagentRegistryPublicationRevision();
    const event = { runIds: ["run"], sessionKeys: ["child", undefined, "child"] };
    const failure = new Error("projection failed");
    onTestFinished(
      subscribeSubagentRunChanges("projection", (published) => {
        expect(published).toEqual(event);
        expect(getSubagentRegistryPublicationRevision()).toBe(revision + 1);
        if (source === "projection failure") {
          throw failure;
        }
        order.push("projection");
      }),
    );
    const session = vi.fn<Parameters<typeof sessionChanges.subscribe>[0]>((change) => {
      if ("sessionKey" in change && change.sessionKey === "child") {
        order.push("session");
      }
    });
    onTestFinished(sessionChanges.subscribe(session));
    const persisted = vi.fn<Parameters<typeof subscribeSubagentRunChanges>[1]>((published) => {
      expect(published).toEqual(event);
      order.push("persistence");
      throw new Error("observer failed");
    });
    onTestFinished(subscribeSubagentRunChanges("persistence", persisted));
    onTestFinished(subscribeSubagentRunChanges("persistence", () => order.push("last")));

    const publish = () =>
      publishSubagentRunChanges(
        event.sessionKeys,
        event.runIds,
        source === "memory" ? "memory" : "persistence",
      );
    if (source === "projection failure") {
      expect(publish).toThrow(failure);
      expect(session).not.toHaveBeenCalled();
      expect(persisted).not.toHaveBeenCalled();
      return;
    }
    expect(publish).not.toThrow();
    expect(order).toEqual(
      source === "memory"
        ? ["projection", "session"]
        : ["projection", "session", "persistence", "last"],
    );
    expect(persisted).toHaveBeenCalledTimes(source === "memory" ? 0 : 1);
  },
);

describe("pending lifecycle registration ownership", () => {
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
      scheduler[schedule]({
        runId: original.runId,
        expectedEntry: original,
        endedAt: 123,
        error: "old failure",
      });
      const successor = retainCustody
        ? copySubagentRunRuntimeOwner(original, { ...original, generation: 2 })
        : createSubagentRunRecord({ runId: original.runId, generation: 2 });
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
});
