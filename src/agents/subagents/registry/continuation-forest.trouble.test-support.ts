// Continuation (karmaterminal/openclaw#1271): trouble in the burning annex, each through its real
// entry point: a prince's chat /new, the Gateway's sessions.reset, a room handed over (its row
// deleted and recreated, or its owner changed), a Gateway restart booting as production schedules
// it, a Gateway that dies inside the attic's turn, the owner's explicit cancel, and a user's message
// to a room running the real reply owner.
import { expect } from "vitest";
import { runContinuationCustodyBoot } from "../../../auto-reply/continuation/custody-boot.js";
import { resetContinuationCustodyProjection } from "../../../auto-reply/continuation/custody/custody-projection.js";
import { resetDelegateDispatchHedgesForTests } from "../../../auto-reply/continuation/delegate-dispatch.js";
import { resolveContinuationResetRetentions } from "../../../auto-reply/continuation/session-reset-retention-resolve.js";
import {
  clearContinuationWorkDispatch,
  dispatchPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
} from "../../../auto-reply/continuation/work-dispatch.js";
import { getReplyFromConfig } from "../../../auto-reply/reply/get-reply.js";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../../../auto-reply/reply/session.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { recoverPendingProducedSessionDeliveries } from "../../../gateway/server-restart-sentinel.js";
import { performGatewaySessionReset } from "../../../gateway/session-reset-service.js";
import { schedulePendingSessionDeliveries } from "../../../infra/session-delivery-queue-runtime.js";
import { resetSystemEventsForTest } from "../../../infra/system-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { sessionScope } from "./continuation-forest.build.test-support.js";
import {
  AGENT_ID,
  type AnnexElection,
  type AnnexNode,
  type Handover,
  OWNER_A,
  OWNER_B,
  userText,
} from "./continuation-forest.model.test-support.js";
import type { ContinuationForest } from "./continuation-forest.test-support.js";

/** The prince changes 🎽🩲: a chat /new on the prince's own room. */
export async function changesClothes(forest: ContinuationForest, prince: AnnexNode): Promise<void> {
  forest.recordDrops([prince.sessionKey]);
  const result = await initSessionState({
    ctx: finalizeInboundContext({
      Body: "/new",
      From: `telegram:prince-${prince.tree}`,
      To: `telegram:prince-${prince.tree}`,
      ChatType: "direct",
      SessionKey: prince.sessionKey,
      Provider: "telegram",
    }),
    cfg: getRuntimeConfig(),
    commandAuthorized: true,
  });
  expect(result.resetTriggered, `${prince.name}'s /new did not reset`).toBe(true);
  expect(result.sessionKey, `${prince.name}'s /new reset another room`).toBe(prince.sessionKey);
  await forest.settle();
}

/** A same-owner Gateway reset (`sessions.reset`) of any room. */
export async function resetRoom(
  forest: ContinuationForest,
  node: AnnexNode,
  reason: "new" | "reset" = "reset",
): Promise<void> {
  forest.recordDrops([node.sessionKey]);
  const result = await performGatewaySessionReset({
    key: node.sessionKey,
    agentId: AGENT_ID,
    reason,
    commandSource: "test",
    operatorRoleActor: { kind: "system" },
    workerPlacementContext: {},
  });
  expect(result.ok && "entry" in result, `${node.name}'s reset did not commit`).toBe(true);
  await forest.settle();
}

/** A real handover of the room: its row deleted and recreated, or its owner changed. */
export async function handOver(
  forest: ContinuationForest,
  node: AnnexNode,
  how: Handover["how"] = "delete and recreate",
): Promise<void> {
  const scope = sessionScope(node.sessionKey);
  if (how === "delete and recreate") {
    await deleteSessionEntryLifecycle({
      agentId: AGENT_ID,
      archiveTranscript: false,
      storePath: forest.storePath,
      target: { canonicalKey: node.sessionKey, storeKeys: [node.sessionKey] },
    });
    await upsertSessionEntryCore(scope, {
      sessionId: `${node.id}-new-occupant`,
      updatedAt: Date.now(),
    });
  } else {
    assignSessionOwner(scope, { owner: OWNER_B, assignedBy: OWNER_A, assignedAt: Date.now() });
  }
  forest.handovers.push({ sessionKey: node.sessionKey, at: Date.now(), how, seq: ++forest.seq });
  await forest.settle();
}

/**
 * A Gateway restart: every in-memory queue, timer and claim of the old process is gone (each
 * queued copy of a durable row is dropped). The new process boots as server-runtime-services.ts
 * schedules it, while the clock runs: 1.25 s in, the delivery runtime starts and replays produced
 * deliveries (spaced 250 ms apart), then arms every pending row; 1.4 s in, custody boot and the
 * pending reset-retention marks. A due time that falls before the boot fires at the boot.
 */
export async function restartGateway(forest: ContinuationForest): Promise<void> {
  await forest.stopDeliveryRuntime?.();
  forest.stopDeliveryRuntime = undefined;
  forest.recordDrops(forest.rooms);
  resetSystemEventsForTest();
  resetContinuationWorkDispatchForTests();
  resetDelegateDispatchHedgesForTests();
  resetContinuationCustodyProjection();
  forest.generation += 1;
  const startedAt = Date.now();
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const delivery = forest.run(async () => {
    await forest.sleep(1_250);
    forest.startDeliveryRuntime();
    try {
      await recoverPendingProducedSessionDeliveries({
        deps: {} as never,
        queueContext: captureOpenClawStateWorkerContext(),
        log,
        maxEnqueuedAt: startedAt,
      });
    } finally {
      await schedulePendingSessionDeliveries();
    }
  });
  let bootedAt = startedAt;
  const custody = forest.run(async () => {
    await forest.sleep(1_400);
    await runContinuationCustodyBoot({
      armedAt: startedAt,
      whenSubagentRegistryActivated: async () => {},
    });
    bootedAt = Date.now();
    await resolveContinuationResetRetentions({ cfg: getRuntimeConfig(), markedBefore: startedAt });
  });
  const started = Date.now();
  await forest.whileTimePasses(Promise.all([delivery, custody]), "the Gateway's boot");
  // Elections fall due again once custody has booted; delivery replay pacing is not downtime.
  forest.downtimes.push({ from: startedAt, to: bootedAt });
  forest.timings.lastBootMs = Date.now() - started;
}

/**
 * The Gateway dies inside the attic wake's turn. At the wake's due time the work dispatcher claims
 * it and drives its turn as production does (the turn-start fence, then the reply owner, where the
 * inspector checks the attic: the effect). The process dies as the dispatcher writes the turn's
 * durable delivered mark, before it commits (`after: "effect"`), or once that mark is written, as
 * it writes the finish. The dying write never commits and never returns, so nothing after it runs
 * in the dead process; the Gateway then restarts. Suites using it mock the work store with the
 * world's `workMarks` seam.
 */
export async function crashMidWake(
  forest: ContinuationForest,
  attic: AnnexElection,
  after: "effect" | "delivered mark",
): Promise<void> {
  // The room's dispatch timer is the dying process's; its due-time dispatch runs here instead, as a
  // world operation the process can die inside (a timer's dispatch is root work settle() awaits).
  clearContinuationWorkDispatch(attic.ownerSessionKey);
  await forest.advance(attic.dueAt! - Date.now());
  const died = { at: undefined as number | undefined };
  const mark = after === "effect" ? "delivered mark" : "finish";
  forest.dying = {
    flowId: attic.id,
    mark,
    died: () => {
      died.at = Date.now();
    },
  };
  void forest
    .run(() => dispatchPendingContinuationWork({ sessionKey: attic.ownerSessionKey }))
    .catch((error: unknown) => forest.failures.push(`${attic.name}: ${String(error)}`));
  await forest.settle();
  forest.dying = undefined;
  expect(died.at, `the Gateway never reached ${attic.name}'s ${mark}`).toBe(attic.dueAt);
  await restartGateway(forest);
}

/**
 * A user's message to a room running the real reply owner, as a world operation: its turn runs now,
 * or queues as a follow-up behind a running one.
 */
export function userSays(forest: ContinuationForest, node: AnnexNode, who: string) {
  return forest.run(() =>
    getReplyFromConfig(
      finalizeInboundContext({
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: node.sessionKey,
        Body: userText(who),
      }),
    ),
  );
}

/** The owner's explicit `/continuations cancel <id...>`, through its decision owner. */
export async function cancelElections(
  forest: ContinuationForest,
  owner: AnnexNode,
  electionIds: string[],
) {
  // Loaded on use: builds before the explicit cancel existed load the rest of the annex.
  const { cancelOwnedContinuationRecords } =
    await import("../../../auto-reply/continuation/session-reset.js");
  const receipt = await cancelOwnedContinuationRecords({
    ownerSessionKey: owner.sessionKey,
    recordIds: electionIds,
  });
  forest.cancelReceipts.push(receipt);
  await forest.settle();
  return receipt;
}
