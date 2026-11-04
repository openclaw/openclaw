// The burning annex (karmaterminal/openclaw#1271): continuation forests messed with in flight.
//   Winter; the annex burns. Princes send shadow clones down the halls to fold paper cranes and
//   report back, one across to another wing, one shouting to every room; each leaves a runner on
//   the stairs and asks to be woken to check the attic again. Then the trouble, one barrier at a
//   time on a fake clock: new clothes, reset halls, rooms that change hands, a Gateway restart.
//   Every crane is folded once, every report finds its room's current occupant once, nobody else.
// The world, what is real and what is doubled: continuation-forest.test-support.ts. A failure
// message tells the story of each break (for example, "the attic inspector of tree 2 ran 2 times").
// // This file: Gateway restarts, the replay barriers, and everything at once.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { ATTIC_DELAY_MS, LATE_RUNNER_DELAY_MS } from "./continuation-forest.model.test-support.js";
import { useContinuationForest } from "./continuation-forest.test-support.js";

const forestSeams = vi.hoisted(() => () => import("./continuation-forest.seams.test-support.js"));
vi.mock("../spawn/subagent-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spawn/subagent-spawn.js")>();
  return { ...actual, ...(await forestSeams()).spawnOwner(actual) };
});
vi.mock("../../../auto-reply/reply/get-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../auto-reply/reply/get-reply.js")>();
  return { ...actual, ...(await forestSeams()).replyOwner(actual) };
});
vi.mock("../../../auto-reply/continuation/continuation-wake.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../auto-reply/continuation/continuation-wake.js")>();
  return { ...actual, ...(await forestSeams()).wakeOwner(actual) };
});
vi.mock("../../../infra/session-delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../infra/session-delivery-queue-storage.js")>();
  return { ...actual, ...(await forestSeams()).deliveryRows(actual) };
});
vi.mock("../../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logging/subsystem.js")>();
  return { ...actual, ...(await forestSeams()).logLines(actual) };
});
vi.mock("../../../utils/sleep.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/sleep.js")>();
  return { ...actual, ...(await forestSeams()).clock(actual) };
});

const fixture = useSubagentControlFixture();
const annex = useContinuationForest(() => fixture.stateDir);
/** Past the attic wake, the last election of the night. */
const NIGHTFALL_MS = ATTIC_DELAY_MS + 1_000;

describe("the burning annex: restarts and replay", () => {
  it("a Gateway restart after a head swap replays every report the successor had not adopted, once; the runner and the attic keep their times", async () => {
    const forest = await annex.build();
    const prince = forest.princes[0]!;
    await forest.light();
    await forest.advanceTo(500);
    await forest.changesClothes(prince);
    // The successor is busy: the reports arriving for it wait in the queue, unadopted.
    const turns = forest.holdTurns(prince.sessionKey);
    await forest.advanceTo(LATE_RUNNER_DELAY_MS - 500);
    const waiting = forest.queuedEvents(prince.sessionKey).length;

    await forest.restart();
    await turns.release();

    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
    expect(waiting).toBeGreaterThan(0);
    expect(forest.generation).toBe(1);
  });

  it("the replay barrier: a runner that folded when the Gateway died reports into the new process once, never spawned or folded again", async () => {
    const forest = await annex.build();
    await forest.light();
    // Spawned at 1.5 s; its crane is folded at 2.5 s, and its completion is not recorded yet.
    const runner = forest.cellarRunner(0);
    const folded = forest.hold(`after-flip:${runner.id}`);

    await forest.until(folded, 3_000);
    expect(forest.bits.get(runner.id)).toBe(1);
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

  it("everything at once: the whole night's trouble across the forest, and still every crane once and every report once", async () => {
    const forest = await annex.build();
    const [prince0, prince1, prince2] = forest.princes;
    await forest.light();
    const alarm = forest.electionOf(forest.node("t0.2"));
    const across = forest.electionOf(forest.node("t1.1"));
    const acrossTarget = forest.acrossTarget(1);
    const heldCrane = forest.electionOf(forest.node("t2.1.1.1"));
    const alarmRow = forest.hold(forest.rowPoint(alarm, prince2!.sessionKey));
    const acrossRow = forest.hold(forest.rowPoint(across, acrossTarget.sessionKey));
    const folded = forest.hold(`after-flip:${heldCrane.id}`);

    // Prince 0 changes mid-fold; the hall of tree 1 is reset with its cellar runner pending.
    await forest.advanceTo(500);
    await forest.changesClothes(prince0!);
    await forest.advanceTo(750);
    await forest.reset(forest.node("t1.0"));
    // Tree 0's alarm is in flight to prince 2 while he changes; tree 1's report across is in
    // flight when its room changes hands.
    await forest.until(alarmRow, 2_000);
    await forest.changesClothes(prince2!);
    await alarmRow.release();
    await forest.until(acrossRow, 2_000);
    await forest.handOver(acrossTarget);
    forest.expectRefusedDelivery(across.id, acrossTarget.sessionKey, "recipient-authority-changed");
    await acrossRow.release();
    await forest.until(folded, 2_000);

    // Prince 2 swaps twice before his runner's due time; prince 1 cancels his late runner.
    await forest.advanceTo(LATE_RUNNER_DELAY_MS - 500);
    await forest.changesClothes(prince2!);
    const lateRunner = forest.lateRunner(1);
    const [receipt] = await forest.cancel(prince1!, [lateRunner.id]);
    expect(receipt).toMatchObject({ recordId: lateRunner.id, outcome: "cancelled" });
    forest.expectElection(lateRunner, { outcome: "cancelled" });
    await forest.advance(250);
    await forest.reset(prince2!);

    // The Gateway restarts with a folded crane's report still unrecorded.
    await forest.advanceTo(3_000);
    await forest.restart();
    await folded.release();

    // Prince 1 resets, then his room changes hands before his attic wakes.
    await forest.advanceTo(ATTIC_DELAY_MS - 500);
    await forest.reset(prince1!);
    await forest.advance(250);
    await forest.handOver(prince1!);
    const handedOverAt = Date.now();
    forest.expectElection(forest.attic(1), {
      outcome: "refused",
      reason: "recipient-authority-changed",
      stage: "wake",
    });

    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
    expect(forest.cancelReceipts).toEqual([[expect.objectContaining({ outcome: "cancelled" })]]);
    expect(
      forest.adoptedBlocks.filter(
        (block) => block.sessionKey === prince1!.sessionKey && block.at >= handedOverAt,
      ),
    ).toEqual([]);
  });
});
