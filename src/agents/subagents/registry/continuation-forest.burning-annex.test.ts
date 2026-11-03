// The burning annex (karmaterminal/openclaw#1271): continuation forests messed with in flight.
//   Winter; the annex burns. Princes send shadow clones down the halls to fold paper cranes and
//   report back, one across to another wing, one shouting to every room; each leaves a runner on
//   the stairs and asks to be woken to check the attic again. Then the trouble, one barrier at a
//   time on a fake clock: new clothes, reset halls, rooms that change hands, a Gateway restart.
//   Every crane is folded once, every report finds its room's current occupant once, nobody else.
// The world, what is real and what is doubled: continuation-forest.test-support.ts. A failure
// message tells the story of each break (for example, "the attic inspector of tree 2 ran 2 times").
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  ATTIC_DELAY_MS,
  LATE_RUNNER_DELAY_MS,
  useContinuationForest,
} from "./continuation-forest.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";

vi.mock("../spawn/subagent-spawn.js", async (importOriginal) =>
  (await import("./continuation-forest.seams.test-support.js")).withForestSpawnOwner(
    await importOriginal(),
  ),
);
vi.mock("../../../auto-reply/reply/get-reply.js", async (importOriginal) =>
  (await import("./continuation-forest.seams.test-support.js")).withForestReplyOwner(
    await importOriginal(),
  ),
);
vi.mock("../../../auto-reply/continuation/continuation-wake.js", async (importOriginal) =>
  (await import("./continuation-forest.seams.test-support.js")).withForestWakeOwner(
    await importOriginal(),
  ),
);
vi.mock("../../../auto-reply/reply/session-reset-cleanup.js", async (importOriginal) =>
  (await import("./continuation-forest.seams.test-support.js")).withForestResetKill(
    await importOriginal(),
  ),
);
vi.mock("../../../infra/session-delivery-queue-storage.js", async (importOriginal) =>
  (await import("./continuation-forest.seams.test-support.js")).withForestDeliveryRows(
    await importOriginal(),
  ),
);
vi.mock("../../../logging/subsystem.js", async (importOriginal) =>
  (await import("./continuation-forest.seams.test-support.js")).withForestLogLines(
    await importOriginal(),
  ),
);
vi.mock("../../../utils/sleep.js", async (importOriginal) =>
  (await import("./continuation-forest.seams.test-support.js")).withForestSleep(
    await importOriginal(),
  ),
);

const fixture = useSubagentControlFixture();
const annex = useContinuationForest(() => fixture.stateDir);
/** Past the attic wake, the last election of the night. */
const NIGHTFALL_MS = ATTIC_DELAY_MS + 1_000;

describe("the burning annex", () => {
  it("a quiet night: every crane folds once and every report finds its room once", async () => {
    const forest = await annex.build();
    await forest.light();
    await forest.advanceTo(NIGHTFALL_MS);

    await forest.expectForestHolds();
    expect(forest.reports.size).toBe(forest.elections.size - forest.princes.length);
  });

  it("the prince changes 🎽🩲 mid-fold: his successor gets every report, his runner and his attic, once", async () => {
    const forest = await annex.build();
    const prince = forest.princes[1]!;
    await forest.light();
    await forest.advanceTo(500);
    const before = forest.head(prince.sessionKey);

    await forest.changesClothes(prince);

    expect(forest.head(prince.sessionKey)).not.toBe(before);
    for (const child of prince.children) {
      expect(subagentRuns.get(child.runId!)?.continuationResetRetention?.state).toBe("adopted");
    }
    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
    // Every report to the prince arrived after the swap, so the successor adopted all of them.
    const adopted = forest.adoptions.filter((a) => a.sessionKey === prince.sessionKey);
    expect(adopted.length).toBeGreaterThan(0);
    expect(new Set(adopted.map((a) => a.head))).toEqual(new Set([forest.head(prince.sessionKey)]));
  });

  it("a reset of an intermediate hall keeps its grandchildren and its pending cellar runner", async () => {
    const forest = await annex.build();
    const hall = forest.node("t0.0");
    await forest.light();
    const runner = forest.cellarRunner(0);
    await forest.advanceTo(750);

    await forest.reset(hall);

    for (const child of hall.children) {
      expect(subagentRuns.get(child.runId!)?.continuationResetRetention?.state).toBe("adopted");
    }
    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
    expect(forest.spawns.filter((spawn) => spawn.electionId === runner.id)).toHaveLength(1);
  });

  it("two head swaps in a row before the due times neither duplicate nor postpone the runner or the attic", async () => {
    const forest = await annex.build();
    const prince = forest.princes[2]!;
    await forest.light();
    await forest.advanceTo(LATE_RUNNER_DELAY_MS - 500);

    await forest.changesClothes(prince);
    await forest.advance(250);
    await forest.reset(prince);

    await forest.advanceTo(NIGHTFALL_MS);
    // The oracle pins the spawn and the wake to their original due times, once each.
    await forest.expectForestHolds();
  });

  it("a report across to another tree and an alarm to every room, in flight across head swaps, reach each successor once", async () => {
    const forest = await annex.build();
    await forest.light();
    const across = forest.electionOf(forest.node("t0.1"));
    const target = forest.acrossTarget(0);
    const alarm = forest.electionOf(forest.node("t2.2"));
    const prince = forest.princes[1]!;
    // The alarm writes prince 1's row and parks before queueing it; the prince changes meanwhile.
    const alarmRow = forest.hold(forest.rowPoint(alarm, prince.sessionKey));
    // The report across is queued in a room whose head is busy, then the room's head swaps.
    const targetTurns = forest.holdTurns(target.sessionKey);
    const acrossRow = forest.hold(forest.rowPoint(across, target.sessionKey));

    await forest.until(alarmRow, 2_000);
    await forest.changesClothes(prince);
    await alarmRow.release();
    await forest.until(acrossRow, 2_000);
    await acrossRow.release();
    await forest.reset(target);
    await targetTurns.release();

    // The swap dropped the room's queued copy; the Gateway's pending sweep replays the durable row.
    await forest.advanceTo(NIGHTFALL_MS);
    await forest.advanceTo(80_000, 5_000);
    await forest.expectForestHolds();
  });

  it("a room handed over while a report to it is in flight refuses it with a failed receipt; the report's other room still gets it", async () => {
    const forest = await annex.build();
    await forest.light();
    const across = forest.electionOf(forest.node("t0.1"));
    const target = forest.acrossTarget(0);
    const inFlight = forest.hold(forest.rowPoint(across, target.sessionKey));

    await forest.until(inFlight, 2_000);
    await forest.handOver(target);
    forest.expectRefusedDelivery(across.id, target.sessionKey, "recipient-authority-changed");
    await inFlight.release();

    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
    expect(forest.adoptions.filter((a) => a.reportId === across.id)).toEqual([
      expect.objectContaining({ sessionKey: forest.princes[0]!.sessionKey }),
    ]);
  });

  it.each(["wake", "replay"] as const)(
    "a prince handed over after a same-owner reset refuses his kept attic wake at the %s; nothing reaches the new occupant",
    async (stage) => {
      const forest = await annex.build();
      const prince = forest.princes[1]!;
      await forest.light();
      await forest.advanceTo(ATTIC_DELAY_MS - 1_000);
      await forest.reset(prince);
      const attic = forest.attic(1);
      expect(await forest.record(attic)).toMatchObject({ status: "queued", dueAt: attic.dueAt });

      await forest.advance(250);
      await forest.handOver(prince);
      const handedOverAt = Date.now();
      forest.expectElection(attic, {
        outcome: "refused",
        reason: "recipient-authority-changed",
        stage,
      });
      if (stage === "replay") {
        await forest.advance(250);
        await forest.restart();
      }

      await forest.advanceTo(NIGHTFALL_MS);
      await forest.expectForestHolds();
      expect(
        forest.adoptedBlocks.filter(
          (block) => block.sessionKey === prince.sessionKey && block.at >= handedOverAt,
        ),
      ).toEqual([]);
    },
  );

  it("a Gateway restart after a head swap replays every report the successor had not adopted, once; the runner and the attic keep their times", async () => {
    const forest = await annex.build();
    const prince = forest.princes[0]!;
    await forest.light();
    await forest.advanceTo(500);
    await forest.changesClothes(prince);
    // The successor is busy: the reports arriving for it wait in the queue, unadopted.
    const turns = forest.holdTurns(prince.sessionKey);
    await forest.advanceTo(LATE_RUNNER_DELAY_MS - 500);
    const waiting = forest.reports.size;

    await forest.restart();
    await turns.release();

    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
    expect(waiting).toBeGreaterThan(0);
    expect(forest.generation).toBe(1);
  });

  it("the replay barrier: a crane folded when the Gateway died reports into the new process once, never folded again", async () => {
    const forest = await annex.build();
    await forest.light();
    const crane = forest.electionOf(forest.node("t2.1.1.1"));
    const folded = forest.hold(`after-flip:${crane.id}`);

    await forest.until(folded, 2_000);
    expect(forest.bits.get(crane.id)).toBe(1);
    await forest.restart();
    await folded.release();

    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
  });

  it("the replay barrier in the attic's turn: a wake that died after its durable delivered mark is never driven again", async () => {
    const forest = await annex.build();
    await forest.light();
    await forest.advanceTo(ATTIC_DELAY_MS - 1_000);

    await forest.crashMidWake(forest.attic(2), "delivered mark");

    // Past running-recovery's one-minute staleness, which re-drives a wake left running.
    await forest.advanceTo(80_000, 5_000);
    await forest.expectForestHolds();
    expect(await forest.record(forest.attic(2))).toMatchObject({ status: "succeeded" });
  });
});
