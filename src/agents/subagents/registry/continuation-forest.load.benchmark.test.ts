// The burning annex under load (karmaterminal/openclaw#1271): opt-in, never in the default run.
//   OPENCLAW_CONTINUATION_FOREST_LOAD=1 node scripts/run-vitest.mjs run \
//     --config test/vitest/vitest.agents-support.config.ts --maxWorkers=1 \
//     src/agents/subagents/registry/continuation-forest.load.benchmark.test.ts
// Knobs: OPENCLAW_CONTINUATION_FOREST_LOAD_SIZES (rooms, default 10,1000,100000),
// OPENCLAW_CONTINUATION_FOREST_SEED (replays a storm), OPENCLAW_CONTINUATION_FOREST_LOAD_BUDGET_MS
// (wall time per run, default 30 minutes), OPENCLAW_CONTINUATION_FOREST_HELD (returns held while
// the nexus changes, default all of its children), OPENCLAW_CONTINUATION_FOREST_REPORT_DIR.
// Each run writes a JSON report (seed, schedule, stories, timings, contention) and asserts the
// same invariants as the barrier scenarios; findings are reported, never a presentation gate.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  contention,
  loadShape,
  measureMarkPasses,
  planStorm,
  releaseHeldReturns,
  runStorm,
  writeLoadReport,
} from "./continuation-forest.load.test-support.js";
import { ATTIC_DELAY_MS, realNowMs } from "./continuation-forest.model.test-support.js";
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
vi.mock("./subagent-continuation-reset-retention.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./subagent-continuation-reset-retention.js")>();
  return { ...actual, ...(await forestSeams()).retentionMarks(actual) };
});

const LOAD = process.env.OPENCLAW_CONTINUATION_FOREST_LOAD === "1";
const SIZES = (process.env.OPENCLAW_CONTINUATION_FOREST_LOAD_SIZES ?? "10,1000,100000")
  .split(",")
  .map(Number);
const BUDGET_MS = Number(process.env.OPENCLAW_CONTINUATION_FOREST_LOAD_BUDGET_MS ?? 1_800_000);
const HELD = process.env.OPENCLAW_CONTINUATION_FOREST_HELD;
/** A test may run the budget twice (storm, then the oracle) and still report. */
const TIMEOUT_MS = BUDGET_MS * 3;

const fixture = useSubagentControlFixture();
const annex = useContinuationForest(() => fixture.stateDir);

describe.runIf(LOAD)("the burning annex under load", () => {
  it.each(SIZES)(
    "a seeded storm over %i rooms keeps every crane once and every report once",
    async (size) => {
      const seed = Number(
        process.env.OPENCLAW_CONTINUATION_FOREST_SEED ?? Math.floor(Math.random() * 2 ** 31),
      );
      const forest = await annex.build(loadShape(size));
      const events = planStorm(forest, seed);
      const started = realNowMs();
      const outcome = await runStorm(forest, events, BUDGET_MS);
      const stormMs = Math.round(realNowMs() - started);
      const stories = outcome.finished
        ? await forest.stories()
        : [
            `the storm did not finish in ${BUDGET_MS}ms (${outcome.eventsRun}/${events.length} events)`,
          ];
      const file = await writeLoadReport(`storm-${size}-seed-${seed}`, {
        kind: "storm",
        size,
        rooms: forest.rooms.size,
        shape: forest.shape,
        seed,
        schedule: events,
        finished: outcome.finished,
        stormMs,
        reports: forest.reports.size,
        adoptions: forest.adoptions.length,
        restarts: forest.generation,
        stories,
        timings: forest.timings,
        contention: contention(forest),
      });
      expect(
        stories,
        `storm seed ${seed} broke (report ${file}):\n  ${stories.join("\n  ")}`,
      ).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it.each(SIZES)(
    "the nexus of %i rooms reincarnates twice, then releases the returns held while it changed",
    async (size) => {
      const children = size - 1;
      const forest = await annex.build({ trees: 1, depth: 2, fanOut: children, alarmTrees: 0 });
      const nexus = forest.princes[0]!;
      const passes = measureMarkPasses();
      const swapsMs: number[] = [];
      for (let swap = 0; swap < 2; swap += 1) {
        const started = realNowMs();
        await forest.changesClothes(nexus);
        swapsMs.push(Math.round(realNowMs() - started));
      }
      const held = Math.min(children, Number(HELD ?? children));
      const release = await releaseHeldReturns(forest, nexus, held, BUDGET_MS);
      const file = await writeLoadReport(`nexus-${size}`, {
        kind: "nexus",
        size,
        children,
        buildMs: Math.round(forest.timings.buildMs ?? 0),
        swapsMs,
        markPasses: passes,
        release,
        contention: contention(forest),
      });
      // Each pass marks every retained child: two /new, then the reset the returns arrive in.
      expect(
        passes.map((pass) => pass.rows),
        `report ${file}`,
      ).toEqual([children, children, children]);
      expect(release, `report ${file}`).toMatchObject({ finished: true, duplicates: 0 });
    },
    TIMEOUT_MS,
  );

  // Finding (posted as TROUBLE): the delivered mark guards a restart only after the turn's
  // provider run is recorded; a Gateway that dies between the two drives the wake again.
  it(
    "finding: a wake that died after its turn ran, before its delivered mark, is never driven again",
    async () => {
      const forest = await annex.build({ trees: 1, depth: 2, fanOut: 1 });
      await forest.light();
      await forest.advanceTo(ATTIC_DELAY_MS - 1_000);
      await forest.crashMidWake(forest.attic(0), "effect");
      await forest.advanceTo(80_000, 5_000);
      const stories = await forest.stories();
      const file = await writeLoadReport("finding-wake-before-delivered-mark", {
        kind: "finding",
        stories,
        contention: contention(forest),
      });
      expect(stories, `report ${file}`).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
