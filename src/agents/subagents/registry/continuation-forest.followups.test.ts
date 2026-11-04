// The burning annex (karmaterminal/openclaw#1271): continuation forests messed with in flight.
//   Winter; the annex burns. Princes send shadow clones down the halls to fold paper cranes and
//   report back, one across to another wing, one shouting to every room; each leaves a runner on
//   the stairs and asks to be woken to check the attic again. Then the trouble, one barrier at a
//   time on a fake clock: new clothes, reset halls, rooms that change hands, a Gateway restart.
//   Every crane is folded once, every report finds its room's current occupant once, nobody else.
// The world, what is real and what is doubled: continuation-forest.test-support.ts. A failure
// message tells the story of each break (for example, "the attic inspector of tree 2 ran 2 times").
// // This file: the crash in the attic's turn, and a wake due beside it, when recovery finds them
// // with follow-ups pending, in a room that runs the real reply owner (admission, the follow-up
// // mailbox and its drain).
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import "../../../test-utils/prepare-compiled-subprocesses.js";
import { describe, expect, it, vi } from "vitest";
import { prewarmConfigDrivenReplyRuntime } from "../../../auto-reply/reply/get-reply-from-config.runtime.js";
import { ATTIC_DELAY_MS, userText } from "./continuation-forest.model.test-support.js";
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
vi.mock("../../embedded-agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../embedded-agent.js")>();
  return { ...actual, ...(await forestSeams()).providerEdge(actual) };
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
vi.mock("../../../auto-reply/continuation/work-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../auto-reply/continuation/work-store.js")>();
  return { ...actual, ...(await forestSeams()).workMarks(actual) };
});

await prewarmConfigDrivenReplyRuntime();

const fixture = useSubagentControlFixture();
const annex = useContinuationForest(() => fixture.stateDir, { realReplyOwner: true });
/** Running-recovery finds a wake left running one minute after its last write (its fence). */
const RECOVERY_MS = ATTIC_DELAY_MS + 60_000;

describe("the burning annex: the crash in the attic's turn, with follow-ups pending", () => {
  it("recovery finds the crashed wake and a due one while follow-ups wait and no turn runs: the crashed wake ran once and is interrupted with one notice, the due one is refused and runs once after the follow-ups, and neither queues as a follow-up", async () => {
    // One prince alone; his room runs the real reply owner.
    const forest = await annex.build({ trees: 1, depth: 1, fanOut: 1 });
    const prince = forest.princes[0]!;
    forest.runsRealReplyOwner(prince);
    await forest.light();
    await forest.advanceTo(ATTIC_DELAY_MS - 1_000);
    const attic = forest.attic(0);
    forest.expectElection(attic, { outcome: "interrupted" });

    // The attic wake claims, its turn checks the attic, and the Gateway dies before the turn's
    // delivery is recorded; the Gateway restarts.
    await forest.crashMidWake(attic, "effect");

    // In the new process the prince asks to be woken again, due as recovery finds the crash.
    await forest.advanceTo(RECOVERY_MS - ATTIC_DELAY_MS, 5_000);
    const watch = await forest.asksToBeWoken(prince, "the night watch of tree 0");
    forest.expectElection(watch, { outcome: "executed", deferred: "behind the follow-ups" });

    // Just before: user-1's turn runs, user-2 and user-3 queue behind it, and it ends.
    await forest.advanceTo(RECOVERY_MS - 500, 5_000);
    const firstTurn = forest.hold("turn:user-1");
    const first = forest.says(prince, "user-1");
    await forest.until(firstTurn, RECOVERY_MS - 500);
    await forest.advance(250);
    await forest.says(prince, "user-2");
    await forest.says(prince, "user-3");
    await firstTurn.release();
    await first;
    const waiting = [userText("user-2"), userText("user-3")];
    expect(forest.followups(prince.sessionKey), "the follow-ups are not waiting").toEqual(waiting);
    expect(forest.turnRunning(prince.sessionKey), "a turn still runs").toBe(false);
    expect(await forest.record(attic), "recovery found the crash early").toMatchObject({
      status: "running",
    });

    // Recovery finds both wakes inside the follow-ups' debounce window.
    await forest.advance(250);
    const queuedAtRecovery = forest.followups(prince.sessionKey);
    expect((await forest.record(attic))?.status, "recovery never found the crash").not.toBe(
      "running",
    );

    await forest.advanceTo(80_000);
    await forest.expectForestHolds();
    expect(queuedAtRecovery, "a wake queued as a follow-up").toEqual(waiting);
    expect(forest.providerTurns.map((turn) => turn.who)).toEqual([
      attic.name,
      "user-1",
      "user-2",
      "user-3",
      watch.name,
    ]);
  });
});
