// Continuation (karmaterminal/openclaw#1271): the burning annex's oracle. It reads the world's
// append-only attempt log (never the crane bits alone), custody, the return rows and their
// receipts, the adoptions, the refusal lines and the wake requests, and tells every break as the
// story: "the attic inspector of tree 2 ran 2 times (at 5000ms (gen 0), 66500ms (gen 1))".
import { listContinuationRecords } from "../../../auto-reply/continuation/custody/custody-store.js";
import type { ContinuationRecord } from "../../../auto-reply/continuation/custody/custody-store.types.js";
import { custodyStateForTest } from "../../../auto-reply/continuation/custody/custody.test-support.js";
import { inspectDeliveryQueueReceipt } from "../../../infra/delivery-queue-sqlite.js";
import { captureDeliveryQueueStateContext } from "../../../infra/delivery-queue-state-context.js";
import {
  ANNEX_STEP_MS,
  type AnnexElection,
  type AttemptLogLine,
  type Report,
} from "./continuation-forest.model.test-support.js";
import type { ContinuationForest } from "./continuation-forest.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";

export async function tellStories(forest: ContinuationForest): Promise<string[]> {
  const stories = [...forest.failures];
  const records = new Map(
    (
      await listContinuationRecords({
        recordIds: [...forest.elections.values()]
          .filter((election) => election.kind === "branch" || election.kind === "attic")
          .map((election) => election.id),
      })
    ).map((record) => [record.recordId, record]),
  );
  for (const election of forest.elections.values()) {
    stories.push(...electionStories(forest, election, records.get(election.id)));
  }
  // The rooms that adopted each report, built once: the forest may hold 100,000 rooms.
  const adoptedRooms = new Map<string, Set<string>>();
  for (const adoption of forest.adoptions) {
    const rooms = adoptedRooms.get(adoption.reportId) ?? new Set<string>();
    rooms.add(adoption.sessionKey);
    adoptedRooms.set(adoption.reportId, rooms);
  }
  deriveRefusalsFromHandovers(forest);
  for (const report of forest.reports.values()) {
    stories.push(...(await reportStories(forest, report, adoptedRooms.get(report.electionId))));
  }
  stories.push(...wakeStories(forest));
  return stories;
}

/**
 * A report bound to a room's authority before the room changed hands, and not adopted by then,
 * must be refused there: the handover advanced the epoch it carries. An `all` report bound after
 * the handover belongs to the new occupant.
 */
function deriveRefusalsFromHandovers(forest: ContinuationForest): void {
  const adoptedSeq = new Map<string, number>();
  for (const adoption of forest.adoptions) {
    const key = `${adoption.reportId}\u0000${adoption.sessionKey}`;
    adoptedSeq.set(key, Math.min(adoptedSeq.get(key) ?? Infinity, adoption.seq));
  }
  for (const handover of forest.handovers) {
    for (const report of forest.reports.values()) {
      const key = `${report.electionId}\u0000${handover.sessionKey}`;
      if (
        report.boundSeq < handover.seq &&
        report.intended.includes(handover.sessionKey) &&
        (adoptedSeq.get(key) ?? Infinity) > handover.seq &&
        !forest.expectedRefusals.has(key)
      ) {
        forest.expectedRefusals.set(key, "recipient-authority-changed");
      }
    }
  }
}

/** Executed exactly once (attempt log), or refused or cancelled before it ever started. */
function electionStories(
  forest: ContinuationForest,
  election: AnnexElection,
  record: ContinuationRecord | undefined,
): string[] {
  const stories: string[] = [];
  const at = (time: number) => `${time - forest.t0}ms`;
  const times = (lines: readonly AttemptLogLine[]) =>
    lines.map((line) => `${at(line.at)} (gen ${line.generation})`).join(", ");
  const lines = forest.attemptsByElection.get(election.id) ?? [];
  const attempts = lines.filter((line) => line.kind === "attempt");
  const effects = lines.filter((line) => line.kind === "effect");
  const { outcome, reason, stage } = election.expected;
  if (outcome === "executed") {
    if (attempts.length !== 1) {
      stories.push(
        attempts.length === 0
          ? `${election.name} never ran`
          : `${election.name} ran ${attempts.length} times (at ${times(attempts)})`,
      );
    }
    if (effects.length !== 1) {
      const bit = forest.bits.get(election.id) === 1 && effects.length > 1;
      stories.push(
        `${election.name} committed its effect ${effects.length} times${
          effects.length > 0 ? ` (at ${times(effects)})` : ""
        }${bit ? "; its bit still reads 1" : ""}`,
      );
    }
    if (effects.length > 0 && election.kind !== "attic" && !forest.reports.has(election.id)) {
      const stopped = forest.stopped.get(election.id);
      stories.push(`${election.name} never reported${stopped ? ` (${stopped})` : ""}`);
    }
  } else if (attempts.length > 0) {
    stories.push(`${election.name} should have been ${outcome} but ran (at ${times(attempts)})`);
  }
  if (election.kind === "branch") {
    const spawns = forest.spawns.filter((spawn) => spawn.electionId === election.id);
    if (outcome === "executed") {
      if (spawns.length !== 1) {
        stories.push(`${election.name} spawned ${spawns.length} times`);
      } else if (
        election.dueAt !== undefined &&
        !firesOnTime(forest, election.dueAt, spawns[0]!.at)
      ) {
        stories.push(
          `${election.name} spawned at ${at(spawns[0]!.at)}, not at its due time ${at(election.dueAt)}`,
        );
      }
    } else if (spawns.length > 0) {
      stories.push(`${election.name} spawned although it was ${outcome}`);
    }
  }
  if (election.kind === "branch" || election.kind === "attic") {
    if (outcome === "cancelled" && record?.status !== "cancelled") {
      stories.push(`${election.name} was not cancelled (status ${record?.status})`);
    }
    if (outcome === "refused") {
      if (record?.status !== "failed" || record.failureReason !== reason) {
        stories.push(
          `${election.name} was not refused with ${reason} (status ${record?.status}, reason ${record?.failureReason})`,
        );
      }
      const line = `[continuation:work-refused] stage=${stage} reason=${reason} session=${election.ownerSessionKey} flowId=${election.id}`;
      if (!forest.logLines.some((logged) => logged.message === line)) {
        stories.push(`${election.name} was not reported refused at its ${stage}`);
      }
    }
  }
  if (election.kind === "attic" && outcome === "executed" && record) {
    const releasedAt = custodyStateForTest(record).releasedAt as number | undefined;
    if (
      election.dueAt !== undefined &&
      (releasedAt === undefined || !firesOnTime(forest, election.dueAt, releasedAt))
    ) {
      stories.push(
        `${election.name} woke at ${releasedAt === undefined ? "no time" : at(releasedAt)}, not at its due time ${at(election.dueAt)}`,
      );
    }
    if (record.status !== "succeeded") {
      stories.push(`${election.name}'s election ended ${record.status}, not succeeded`);
    }
  }
  return stories;
}

/** At its due time, or, when the Gateway was down then, when the new process booted. */
function firesOnTime(forest: ContinuationForest, dueAt: number, firedAt: number): boolean {
  const down = forest.downtimes.find((window) => dueAt >= window.from && dueAt < window.to);
  const expected = down ? down.to : dueAt;
  return firedAt >= dueAt && firedAt < expected + ANNEX_STEP_MS;
}

/**
 * Every report reaches the current head of each intended room exactly once; a room handed over
 * meanwhile refuses it (reason, failed receipt, never named "Delivered to"), and no room adopts a
 * report it was never sent.
 */
async function reportStories(
  forest: ContinuationForest,
  report: Report,
  adoptedRooms: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const stories: string[] = [];
  const intended = new Set(report.intended);
  const child = subagentRuns.get(report.runId)?.childSessionKey;
  for (const sessionKey of report.intended) {
    const adopted = forest.adoptionCounts.get(`${report.electionId}\u0000${sessionKey}`) ?? 0;
    const refusal = forest.expectedRefusals.get(`${report.electionId}\u0000${sessionKey}`);
    if (!refusal) {
      if (adopted !== 1) {
        stories.push(
          adopted === 0
            ? `${report.name}'s report never reached ${describeRoom(forest, sessionKey)}`
            : `${describeRoom(forest, sessionKey)} adopted ${report.name}'s report ${adopted} times`,
        );
      }
      continue;
    }
    if (adopted > 0) {
      stories.push(`${sessionKey} adopted ${report.name}'s report although it was handed over`);
    }
    const refused = forest.logLines.some(
      (line) =>
        line.message.startsWith("[continuation:return-refused]") &&
        line.message.includes(`reason=${refusal} session=${sessionKey}`),
    );
    if (!refused) {
      stories.push(`${report.name}'s report to ${sessionKey} was never refused with ${refusal}`);
    }
    const rowId = forest.rows.get(`${report.runId}\u0000${sessionKey}`);
    if (rowId && (await receiptStatus(forest, rowId)) !== "failed") {
      stories.push(`${report.name}'s refused row for ${sessionKey} is not a failed receipt`);
    }
    if (
      forest.deliveredLines.some((line) => line.from === child && line.keys.includes(sessionKey))
    ) {
      stories.push(`"Delivered to" named ${sessionKey} for ${report.name}'s refused report`);
    }
  }
  for (const sessionKey of adoptedRooms) {
    if (!intended.has(sessionKey)) {
      stories.push(
        `${describeRoom(forest, sessionKey)} adopted ${report.name}'s report it was never sent`,
      );
    }
  }
  return stories;
}

async function receiptStatus(forest: ContinuationForest, id: string): Promise<string | undefined> {
  const context = captureDeliveryQueueStateContext(forest.stateDir);
  return (await inspectDeliveryQueueReceipt("session", id, false, context)).status;
}

/** A row is woken once per queued copy: again only after a reset or restart dropped its copy. */
function wakeStories(forest: ContinuationForest): string[] {
  const counts = new Map<string, number>();
  for (const wake of forest.wakes) {
    for (const id of wake.deliveryIds) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const stories: string[] = [];
  for (const [id, count] of counts) {
    const dropped = forest.drops.get(id) ?? 0;
    if (count > 1 + dropped) {
      stories.push(
        `delivery ${id} woke its recipient ${count} times (its queued copy was dropped ${dropped} times)`,
      );
    }
  }
  return stories;
}

function describeRoom(forest: ContinuationForest, sessionKey: string): string {
  for (const node of forest.nodes.values()) {
    if (node.sessionKey === sessionKey) {
      return `${node.name}'s room`;
    }
  }
  return sessionKey;
}
