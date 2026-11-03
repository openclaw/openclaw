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
    console.log(JSON.stringify(forest.timings));
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
});
