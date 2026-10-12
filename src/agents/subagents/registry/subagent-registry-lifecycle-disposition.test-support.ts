// A cancellation and a wait expiry both arrive at the lifecycle boundary with
// no disposition of their own. These cases pin which one the published outcome
// is allowed to claim.
import { expect, it, vi } from "vitest";
import { resolveSubagentRunDisposition } from "../announce/subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import {
  createRunEntry,
  type createLifecycleControllerFixture,
  makeKilledSubagentCompletion,
  readLifecycleRun,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

type CompletionOverrides = Omit<Partial<SubagentCompletionRequest>, "runId">;

export function registerLifecycleDispositionTests(params: {
  createLifecycleController: (
    options: Parameters<typeof createLifecycleControllerFixture>[0],
  ) => ReturnType<typeof createLifecycleControllerFixture>;
  completeAndJoinCleanup: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    overrides?: CompletionOverrides,
  ) => Promise<void>;
}) {
  const { createLifecycleController, completeAndJoinCleanup } = params;
  // Every cancellation producer other than the entry.killIntent path reaches
  // this boundary with the killed reason and no disposition. The default read
  // of an absent disposition is `exited`, and announcement does not wait for
  // completion, so each of these used to publish `exited` for a killed child.
  it.each([
    {
      label: "a lifecycle cancellation without a durable kill intent",
      outcome: { status: "error", error: "agent run aborted" } as const,
    },
    {
      label: "the sweeper's cancellation-grace completion",
      outcome: { status: "error", error: "killed" } as const,
    },
    {
      label: "persisted killed-session reconciliation",
      outcome: { status: "error", error: "subagent run terminated" } as const,
    },
  ])("stamps killed disposition for $label", async ({ outcome }) => {
    const entry = createRunEntry({ execution: { status: "running", startedAt: 2_000 } });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(makeKilledSubagentCompletion(entry, { outcome }));

    // Completion publishes a replacement row; the handed-in entry keeps its
    // running preimage, so every postcompletion read goes through the committed
    // run.
    const completed = readLifecycleRun(entry);
    expect(completed.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
    expect(completed.execution.outcome).toMatchObject({ ...outcome, disposition: "killed" });
    expect(resolveSubagentRunDisposition(completed.execution.outcome)).toBe("killed");
  });

  it("replaces a provisional still-running disposition on a cancellation completion", async () => {
    const entry = createRunEntry({ execution: { status: "running", startedAt: 2_000 } });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        // A wait-expiry publication describes the waiter, not the run. Carrying
        // it onto a cancellation would tell the parent a killed child is still
        // live and harvestable.
        outcome: { status: "error", error: "agent run aborted", disposition: "still-running" },
      }),
    );

    expect(resolveSubagentRunDisposition(readLifecycleRun(entry).execution.outcome)).toBe("killed");
  });

  it("re-announces when a live child's own completion supersedes a wait-expiry publication", async () => {
    // A wait-expiry publication reported the waiter, not the run. Fencing the
    // run behind it discarded the child's real ending, so the parent's last
    // word stayed "still running" for a child that had finished 15m earlier.
    const entry = createRunEntry({
      runTimeoutSeconds: 3,
      startedAt: 2_000,
      endedAt: 5_000,
      outcome: { status: "timeout", disposition: "still-running" },
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      cleanupHandled: true,
      cleanupCompletedAt: 5_000,
      delivery: { status: "delivered", announcedAt: 5_000, deliveredAt: 5_000 },
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    // Re-announcement is dispatched as root work, so drain it before reading
    // the call count. A bare `completeRun` asserts against an announce that has
    // not been dispatched yet — the committed row already shows the released
    // delivery, but the flow has not run.
    await completeAndJoinCleanup(controller, entry, {
      endedAt: 6_500,
      outcome: { status: "ok" },
      triggerCleanup: true,
    });

    expect(runSubagentAnnounceFlow).toHaveBeenCalled();
    // The superseding publication carries no still-running marker, so the event
    // reads as an ended child.
    expect(readLifecycleRun(entry).execution.outcome?.disposition).toBeUndefined();
  });

  it("does not re-announce when a second wait also expires on the same live child", async () => {
    const entry = createRunEntry({
      runTimeoutSeconds: 3,
      startedAt: 2_000,
      endedAt: 5_000,
      outcome: { status: "timeout", disposition: "still-running" },
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      cleanupHandled: true,
      cleanupCompletedAt: 5_000,
      delivery: { status: "delivered", announcedAt: 5_000, deliveredAt: 5_000 },
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    // Drained for the same reason as the case above: an undrained negative
    // assertion would pass without proving the second expiry was fenced.
    await completeAndJoinCleanup(controller, entry, {
      endedAt: 6_500,
      outcome: { status: "timeout", disposition: "still-running" },
      triggerCleanup: true,
    });

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
  });
}
