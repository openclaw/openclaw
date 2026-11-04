// The burning annex (karmaterminal/openclaw#1271): continuation forests messed with in flight.
//   Winter; the annex burns. Princes send shadow clones down the halls to fold paper cranes and
//   report back, one across to another wing, one shouting to every room; each leaves a runner on
//   the stairs and asks to be woken to check the attic again. Then the trouble, one barrier at a
//   time on a fake clock: new clothes, reset halls, rooms that change hands, a Gateway restart.
//   Every crane is folded once, every report finds its room's current occupant once, nobody else.
// The world, what is real and what is doubled: continuation-forest.test-support.ts. A failure
// message tells the story of each break (for example, "the attic inspector of tree 2 ran 2 times").
// // This file: routed returns in flight, and rooms that change hands.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { ATTIC_DELAY_MS } from "./continuation-forest.model.test-support.js";
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

describe("the burning annex: routed returns and handovers", () => {
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
});
