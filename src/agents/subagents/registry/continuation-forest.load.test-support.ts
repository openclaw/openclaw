// Continuation (karmaterminal/openclaw#1271): the burning annex under load. A seeded storm of
// mutations (head swaps at any depth, subtree resets, handovers of rooms, Gateway restarts) over a
// forest of a chosen size, judged by the same oracle; and the nexus, one head with every run of the
// forest retained by its reset, reincarnated twice, then releasing returns held while it changed.
// Every run writes a report: the seed and its schedule, the stories, timings and contention.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareContinuationResetRetention } from "../../../auto-reply/continuation/session-reset-retention.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { reportElection } from "./continuation-forest.fire.test-support.js";
import {
  AGENT_ID,
  type AnnexNode,
  type AnnexShape,
  ATTIC_DELAY_MS,
  annexRoomCount,
  realNowMs,
} from "./continuation-forest.model.test-support.js";
import { continuationForestSeams } from "./continuation-forest.seams.test-support.js";
import type { ContinuationForest } from "./continuation-forest.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";

/** One progress line on stderr: where the run is, and what the forest holds so far. */
export function progress(forest: ContinuationForest, label: string): void {
  const clock = forest.t0 ? `${Date.now() - forest.t0}ms` : "unlit";
  process.stderr.write(
    `[annex] ${label} clock=${clock} rooms=${forest.rooms.size} reports=${forest.reports.size} adoptions=${forest.adoptions.length} rss=${Math.round(process.memoryUsage().rss / 1_048_576)}MB\n`,
  );
}

/** Forest shapes for the load sizes (rooms, princes included). */
export const LOAD_SHAPES: Readonly<Record<number, AnnexShape>> = {
  10: { trees: 2, depth: 2, fanOut: 4 },
  1_000: { trees: 4, depth: 4, fanOut: 6 },
  // One whole-forest alarm: each `all` return writes and adopts a row in every room.
  100_000: { trees: 9, depth: 5, fanOut: 10, alarmTrees: 1 },
};

export function loadShape(size: number): AnnexShape {
  const shape = LOAD_SHAPES[size];
  if (shape) {
    return shape;
  }
  // Otherwise four generations of six children per tree, as many trees as the size needs.
  const perTree = annexRoomCount({ trees: 1, depth: 4, fanOut: 6 });
  return { trees: Math.max(1, Math.round(size / perTree)), depth: 4, fanOut: 6, alarmTrees: 1 };
}

/** mulberry32: a seeded generator, so any failing storm reproduces from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type StormEvent = {
  atMs: number;
  kind: "new" | "reset" | "handover" | "restart";
  nodeId?: string;
};

/**
 * The seeded schedule: a prince's /new, a Gateway reset of any room at any depth (a subtree
 * reset), a crane room handed over, or a Gateway restart, at whole steps of the first six seconds.
 * Handovers take crane rooms only: a relay or prince that changes hands retires its whole wing,
 * which the oracle would have to expect by hand.
 */
export function planStorm(forest: ContinuationForest, seed: number): StormEvent[] {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const nodes = [...forest.nodes.values()];
  const cranes = nodes.filter((node) => node.role === "crane");
  const count = Math.min(24, Math.max(4, Math.ceil(nodes.length / 40)));
  const events: StormEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const atMs = 250 * (1 + Math.floor(random() * 24));
    const roll = random();
    if (roll < 0.3) {
      events.push({ atMs, kind: "new", nodeId: pick(forest.princes).id });
    } else if (roll < 0.65) {
      events.push({ atMs, kind: "reset", nodeId: pick(nodes).id });
    } else if (roll < 0.85 && cranes.length > 0) {
      events.push({ atMs, kind: "handover", nodeId: pick(cranes).id });
    } else {
      events.push({ atMs, kind: "restart" });
    }
  }
  return events.toSorted((left, right) => left.atMs - right.atMs);
}

/**
 * Lights the forest and runs the schedule, then lets the night end and the Gateway's pending
 * sweep pass. Stops early, unfinished, once `budgetMs` of wall time is spent.
 */
export async function runStorm(
  forest: ContinuationForest,
  events: readonly StormEvent[],
  budgetMs: number,
): Promise<{ finished: boolean; eventsRun: number }> {
  const started = realNowMs();
  const overBudget = () => realNowMs() - started > budgetMs;
  progress(forest, "lighting");
  await forest.light();
  let eventsRun = 0;
  for (const event of events) {
    if (overBudget()) {
      return { finished: false, eventsRun };
    }
    if (forest.t0 + event.atMs > Date.now()) {
      await forest.advanceTo(event.atMs);
    }
    progress(forest, `event ${eventsRun + 1}/${events.length} ${event.kind} ${event.nodeId ?? ""}`);
    const node = event.nodeId ? forest.node(event.nodeId) : undefined;
    if (event.kind === "new") {
      await forest.changesClothes(node!);
    } else if (event.kind === "reset") {
      await forest.reset(node!);
    } else if (event.kind === "handover") {
      await forest.handOver(node!);
    } else {
      await forest.restart();
    }
    eventsRun += 1;
  }
  for (const atMs of [ATTIC_DELAY_MS + 1_000, 80_000]) {
    if (overBudget()) {
      return { finished: false, eventsRun };
    }
    progress(forest, `advancing to ${atMs}ms`);
    if (forest.t0 + atMs > Date.now()) {
      await forest.advanceTo(atMs, atMs > ATTIC_DELAY_MS + 1_000 ? 5_000 : undefined);
    }
  }
  return { finished: true, eventsRun };
}

/** Counts of each continuation log tag: refusals, held returns, claim races, deferrals. */
export function contention(forest: ContinuationForest): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of forest.logLines) {
    const tag = /^\[continuation:([\w-]+)\]/.exec(line.message)?.[1];
    if (tag) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  return counts;
}

export type MarkPass = {
  rows: number;
  ms: number;
  /** Serialized size of the rows the pass marked: the transaction's postimages. */
  bytes: number;
  heapBeforeMb: number;
  heapAfterMb: number;
  peakRssMb: number;
};

/** Measures every retention mark pass from now on: latency, rows, bytes and memory. */
export function measureMarkPasses(): MarkPass[] {
  const passes: MarkPass[] = [];
  const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;
  continuationForestSeams.measureMarks = async (pass) => {
    const before = process.memoryUsage();
    let peakRss = before.rss;
    // A real interval: the fake clock does not move setInterval.
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    const started = realNowMs();
    try {
      const marked = await pass();
      const ms = realNowMs() - started;
      let bytes = 0;
      for (const runId of marked) {
        bytes += JSON.stringify(subagentRuns.get(runId) ?? null).length;
      }
      const after = process.memoryUsage();
      passes.push({
        rows: marked.length,
        ms: Math.round(ms),
        bytes,
        heapBeforeMb: mb(before.heapUsed),
        heapAfterMb: mb(after.heapUsed),
        peakRssMb: mb(Math.max(peakRss, after.rss)),
      });
      return marked;
    } finally {
      clearInterval(sampler);
    }
  };
  return passes;
}

/**
 * Returns held while the nexus changes: its retention marks are pending while `count` children
 * report (each row written and held, never queued), the reset commits its successor revision,
 * and the reset's resolution releases them to the successor, which adopts them 20 at a time (the
 * system-event queue's capacity). Composed with the retention scope the reset flows use.
 */
export async function releaseHeldReturns(
  forest: ContinuationForest,
  nexus: AnnexNode,
  count: number,
  budgetMs: number,
): Promise<Record<string, number | boolean>> {
  const children = nexus.children.slice(0, count);
  const retention = prepareContinuationResetRetention({
    cfg: getRuntimeConfig(),
    sessionKey: nexus.sessionKey,
    agentId: AGENT_ID,
    storePath: forest.storePath,
  });
  const produceStarted = realNowMs();
  await retention.stopSubagents({ assertCurrent: () => {} }, async () => {
    for (const [index, child] of children.entries()) {
      await reportElection(forest, forest.electionOf(child));
      if ((index + 1) % 5_000 === 0) {
        progress(forest, `held ${index + 1}/${children.length} returns`);
      }
    }
  });
  const produceMs = realNowMs() - produceStarted;
  const held = contention(forest)["return-held"] ?? 0;
  await patchSessionEntryCore(
    { agentId: AGENT_ID, storePath: forest.storePath, sessionKey: nexus.sessionKey },
    (entry) => ({ ...entry, lifecycleRevision: retention.successorRevision }),
  );
  const resolveStarted = realNowMs();
  await retention.resolve();
  const resolveMs = realNowMs() - resolveStarted;
  const adoptStarted = realNowMs();
  const expected = new Set(children.map((child) => child.runId!));
  const adoptedRuns = new Set<string>();
  let scanned = 0;
  const adoptedCount = () => {
    for (; scanned < forest.adoptions.length; scanned += 1) {
      const adoption = forest.adoptions[scanned]!;
      if (adoption.sessionKey === nexus.sessionKey && expected.has(adoption.reportId)) {
        adoptedRuns.add(adoption.reportId);
      }
    }
    return adoptedRuns.size;
  };
  let fakeMs = 0;
  while (adoptedCount() < children.length && realNowMs() - adoptStarted < budgetMs) {
    await forest.advance(1_000);
    fakeMs += 1_000;
    if (fakeMs % 60_000 === 0) {
      progress(forest, `released ${adoptedCount()}/${children.length} adopted`);
    }
  }
  const adopted = adoptedCount();
  const duplicates = children.filter(
    (child) => (forest.adoptionCounts.get(`${child.runId}\u0000${nexus.sessionKey}`) ?? 0) > 1,
  ).length;
  return {
    returns: children.length,
    held,
    produceMs: Math.round(produceMs),
    resolveMs: Math.round(resolveMs),
    adopted,
    duplicates,
    adoptWallMs: Math.round(realNowMs() - adoptStarted),
    adoptClockMs: fakeMs,
    finished: adopted === children.length,
  };
}

/** Writes the run's report under `.artifacts/continuation-forest/` (or the given directory). */
export async function writeLoadReport(
  name: string,
  report: Record<string, unknown>,
  dir = process.env.OPENCLAW_CONTINUATION_FOREST_REPORT_DIR ??
    path.resolve(".artifacts", "continuation-forest"),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
