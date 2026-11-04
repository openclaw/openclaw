// The burning annex (karmaterminal/openclaw#1544): session-store maintenance past the cap.
//   Relay 0 of tree 0 ends its turn instead of yielding: its own run goes home while its wing is
//   still out. Past session.maintenance.maxEntries the store evicts its oldest disposable rooms, but
//   never a room that holds live continuation custody: an election it owns, a child that still owes
//   it a report, a report pending for it. Once that custody ends, the next pass evicts the room.
// The world, what is real and what is doubled: continuation-forest.test-support.ts. A pass here is
// the forced maintenance `openclaw sessions cleanup --enforce` commits, or the Gateway's automatic
// pass after a write. Every child's run goes home once its report is routed.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
} from "../../../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { observeSessionMaintenanceCompletion } from "../../../config/sessions/session-accessor.sqlite-maintenance-completion.test-support.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "../../../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import * as logging from "../../../logging/logger.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  AGENT_ID,
  ANNEX_STEP_MS,
  ATTIC_DELAY_MS,
  CELLAR_RUNNER_DELAY_MS,
  FOLD_MS,
  annexRoomCount,
  nodeKey,
} from "./continuation-forest.model.test-support.js";
import {
  type ContinuationForest,
  useContinuationForest,
} from "./continuation-forest.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";

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
/** Two trees of princes, relays and cranes; no report shouts to every room. */
const SHAPE = { trees: 2, depth: 3, fanOut: 2, alarmTrees: 0 };
const ROOMS = annexRoomCount(SHAPE);
/** Past the attic wake, the last election of the night. */
const NIGHTFALL_MS = ATTIC_DELAY_MS + 1_000;
const OVERFLOWING = "SQLite automatic session maintenance left the store over maxEntries";

async function lightTheAnnex(): Promise<ContinuationForest> {
  const forest = await annex.build(SHAPE);
  forest.childrenSettleOnReport = true;
  await forest.light();
  await forest.endsItsTurn(forest.node("t0.0"));
  return forest;
}

/** One forced pass over the store, as `openclaw sessions cleanup --enforce` commits it. */
async function maintain(
  forest: ContinuationForest,
  maintenanceOverride: Partial<ResolvedSessionMaintenanceConfig>,
): Promise<void> {
  await applySessionEntryLifecycleMutation({
    agentId: AGENT_ID,
    storePath: forest.storePath,
    removals: [],
    maintenanceOverride,
  });
  await forest.settle();
}

function rooms(forest: ContinuationForest): string[] {
  return listSessionEntriesCore({ agentId: AGENT_ID, storePath: forest.storePath })
    .map((row) => row.sessionKey)
    .toSorted();
}

/** Relay 0 has no runner on its way: its custody is its cranes' reports alone. */
async function withoutTheCellarRunner(forest: ContinuationForest): Promise<void> {
  const runner = forest.cellarRunner(0);
  await forest.cancel(forest.node("t0.0"), [runner.id]);
  forest.expectElection(runner, { outcome: "cancelled" });
}

describe("the burning annex: store maintenance past the cap", () => {
  // The cap takes the two oldest unprotected rooms. Age pruning plans on the worker's clock, ahead
  // of the annex's: its 1 ms window covers every room, so it takes all the unprotected ones.
  it.each([
    ["the entry cap", { maxEntries: ROOMS + 1 }, ["old", "mid"]],
    ["age pruning", { pruneAfterMs: 1 }, ["old", "mid", "new"]],
  ] as const)(
    "%s keeps a relay whose cranes are out and takes the rooms with nothing in flight, oldest first; the cranes' reports reach the relay",
    async (_, pass, evicted) => {
      const forest = await lightTheAnnex();
      const relay = forest.node("t0.0");
      await withoutTheCellarRunner(forest);
      await forest.advance(ANNEX_STEP_MS);
      // Ash rooms hold no custody: one older than the relay (built at the fire's first instant),
      // two newer.
      const ash = { old: nodeKey("ash-old"), mid: nodeKey("ash-mid"), new: nodeKey("ash-new") };
      const now = Date.now();
      await applySessionEntryLifecycleMutation({
        agentId: AGENT_ID,
        storePath: forest.storePath,
        upserts: [
          [ash.old, now - 60_000],
          [ash.mid, now - 200],
          [ash.new, now - 50],
        ].map(([sessionKey, updatedAt]) => ({
          sessionKey: sessionKey as string,
          entry: { sessionId: `${sessionKey}-head`, updatedAt } as SessionEntry,
        })),
        skipMaintenance: true,
      });

      await maintain(forest, pass);
      // Soft: a lost room goes on to tell what it cost.
      expect.soft(rooms(forest)).toContain(relay.sessionKey);
      expect(Object.values(ash).filter((key) => !rooms(forest).includes(key))).toEqual(
        evicted.map((age) => ash[age]),
      );

      await forest.advanceTo(NIGHTFALL_MS);
      await forest.expectForestHolds();
      await maintain(forest, { maxEntries: 2 });
      expect(rooms(forest)).not.toContain(relay.sessionKey);
    },
  );

  it("keeps a relay whose only custody is its queued runner; the runner spawns once, then the room goes", async () => {
    const forest = await lightTheAnnex();
    const relay = forest.node("t0.0");
    const runner = forest.cellarRunner(0);
    await forest.advanceTo(CELLAR_RUNNER_DELAY_MS - ANNEX_STEP_MS);
    // Both cranes reported, their runs went home, and the relay adopted their reports.
    expect(forest.childReportsFor(relay)).toEqual(
      new Set(relay.children.map((crane) => crane.runId)),
    );
    expect((await forest.record(runner))?.status).toBe("queued");

    await maintain(forest, { maxEntries: 2 });
    expect.soft(rooms(forest)).toContain(relay.sessionKey);

    await forest.advanceTo(NIGHTFALL_MS);
    await forest.expectForestHolds();
    expect(forest.spawns.filter((spawn) => spawn.electionId === runner.id)).toHaveLength(1);
    await maintain(forest, { maxEntries: 2 });
    expect(rooms(forest)).not.toContain(relay.sessionKey);
  });

  it("keeps a relay whose cranes' reports are pending for it; it adopts them, none refused, then the room goes", async () => {
    const forest = await lightTheAnnex();
    const relay = forest.node("t0.0");
    await withoutTheCellarRunner(forest);
    const turns = forest.holdTurns(relay.sessionKey);
    await forest.advanceTo(FOLD_MS + ANNEX_STEP_MS);
    // Both cranes reported and went home; their rows wait for the relay's next turn.
    for (const crane of relay.children) {
      const row = forest.rows.get(`${crane.runId}\u0000${relay.sessionKey}`);
      expect(row && !forest.adoptedDeliveryIds.has(row)).toBe(true);
      expect(subagentRuns.get(crane.runId!)?.delivery?.status).toBe("delivered");
    }

    await maintain(forest, { maxEntries: 2 });
    expect.soft(rooms(forest)).toContain(relay.sessionKey);

    await turns.release();
    await forest.advanceTo(NIGHTFALL_MS);
    expect
      .soft(forest.logLines.filter(({ message }) => message.includes(":return-refused]")))
      .toEqual([]);
    await forest.expectForestHolds();
    await maintain(forest, { maxEntries: 2 });
    expect(rooms(forest)).not.toContain(relay.sessionKey);
  });

  it("when every room past the cap holds custody, the Gateway's pass leaves the store over it and says so once", async () => {
    const forest = await lightTheAnnex();
    const relay = forest.node("t0.0");
    const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
    vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
    const info = vi.spyOn(logger, "info");
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID });
    const completed = observeSessionMaintenanceCompletion(databasePath);

    await patchSessionEntryCore(
      { agentId: AGENT_ID, storePath: forest.storePath, sessionKey: forest.princes[0]!.sessionKey },
      () => ({ label: "the annex is burning" }),
      { maintenanceConfig: resolveMaintenanceConfigFromInput({ maxEntries: 2 }) },
    );
    await completed;
    await forest.settle();

    expect(rooms(forest)).toHaveLength(ROOMS);
    expect(rooms(forest)).toContain(relay.sessionKey);
    expect(info.mock.calls.filter(([message]) => message.startsWith(OVERFLOWING))).toEqual([
      [expect.any(String), { path: databasePath, entries: ROOMS, maxEntries: 2 }],
    ]);
  });
});
