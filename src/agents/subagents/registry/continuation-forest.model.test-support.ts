// Continuation (karmaterminal/openclaw#1271): the burning annex's vocabulary. Shapes, rooms,
// elections and the clock's units, shared by the world (continuation-forest.test-support.ts) and
// its build, fire, trouble and oracle modules.

/**
 * Trees, generations per tree (prince included), children per node, and how many trees' third
 * child shouts to every room (default: every tree's; one `all` return writes a row per room).
 */
export type AnnexShape = { trees: number; depth: number; fanOut: number; alarmTrees?: number };
export const DEFAULT_ANNEX_SHAPE: AnnexShape = { trees: 3, depth: 4, fanOut: 3 };

/** The clock moves in steps of this size; every due time in the annex is a multiple of it. */
export const ANNEX_STEP_MS = 250;
/** A clone folds its crane over one second. */
export const FOLD_MS = 1_000;
/** The cellar runner (relay 0 of each tree) and the late runner (each prince) wait this long. */
export const CELLAR_RUNNER_DELAY_MS = 1_500;
export const LATE_RUNNER_DELAY_MS = 2_500;
/** Each prince asks to be woken this long after the fire starts (the minimum continue_work delay). */
export const ATTIC_DELAY_MS = 5_000;

export const AGENT_ID = "main";
export const OWNER_A = { type: "human" as const, source: "unknown" as const, id: "owner-a" };
export const OWNER_B = { type: "human" as const, id: "owner-b" };

export type Routing =
  | { kind: "requester" }
  | { kind: "out-of-tree"; target: AnnexNode }
  | { kind: "all" };

export type AnnexNode = {
  /** Story id: `t1` is prince 1, `t1.0.2` the third child of its first child. */
  id: string;
  name: string;
  tree: number;
  role: "prince" | "relay" | "crane";
  sessionKey: string;
  parent?: AnnexNode;
  children: AnnexNode[];
  /** The admitted child run; its id is the election id of its fold or relay. */
  runId?: string;
  routing: Routing;
};

/**
 * `interrupted`: an attic wake whose turn ran once, then whose Gateway died before its delivery was
 * recorded. It never runs again; its record fails as interrupted and its room is told once.
 */
export type ElectionOutcome = "executed" | "interrupted" | "refused" | "cancelled";
export type ElectionExpectation = { outcome: ElectionOutcome; reason?: string; stage?: string };

export type AnnexElection = {
  /** The election id: the child run (crane, relay), the custody record (branch, attic). */
  id: string;
  kind: "crane" | "relay" | "branch" | "attic";
  name: string;
  tree: number;
  ownerSessionKey: string;
  node?: AnnexNode;
  /** A branch's owner: its runner reports back to this room. */
  owner?: AnnexNode;
  dueAt?: number;
  expected: ElectionExpectation;
};

/** One line of the append-only attempt log, kept outside the Gateway. */
export type AttemptLogLine = {
  electionId: string;
  kind: "attempt" | "effect";
  at: number;
  generation: number;
};

export type Report = {
  electionId: string;
  runId: string;
  name: string;
  at: number;
  /** The rooms this report is meant for when it is made. */
  intended: string[];
  /** When its recipient authority was bound: at election (0), or when an `all` return selects. */
  boundSeq: number;
};

export type Adoption = {
  reportId: string;
  sessionKey: string;
  head: string;
  at: number;
  generation: number;
  /** The world's event order; clock times tie within a step. */
  seq: number;
};

export type Handover = {
  sessionKey: string;
  at: number;
  how: "delete and recreate" | "owner change";
  seq: number;
};

export function princeKey(tree: number): string {
  return `agent:main:telegram:default:direct:prince-${tree}`;
}

export function nodeKey(id: string): string {
  return `agent:main:subagent:annex-${id.replaceAll(".", "-")}`;
}

export function nodeRunId(id: string): string {
  return `annex-${id.replaceAll(".", "-")}`;
}

export function reportText(election: AnnexElection): string {
  return `[annex:report ${election.id}] ${election.name} ${
    election.kind === "relay" ? "relays its wing" : "folded its crane"
  }`;
}

export const REPORT_TAG = /\[annex:report ([^\]]+)\]/g;

/** A user's message to a room whose turns run the real reply owner: `[annex:user <who>] …`. */
export function userText(who: string): string {
  return `[annex:user ${who}] is the attic all right?`;
}

export const USER_TAG = /\[annex:user ([^\]]+)\]/;

/** Wall time, which the fake clock does not move. */
export function realNowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** The scale knob: OPENCLAW_CONTINUATION_FOREST_{TREES,DEPTH,FANOUT}, default 3 x 4 x 3. */
export function annexShapeFromEnv(env: NodeJS.ProcessEnv = process.env): AnnexShape {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer, got ${raw}`);
    }
    return value;
  };
  return {
    trees: read("OPENCLAW_CONTINUATION_FOREST_TREES", DEFAULT_ANNEX_SHAPE.trees),
    depth: read("OPENCLAW_CONTINUATION_FOREST_DEPTH", DEFAULT_ANNEX_SHAPE.depth),
    fanOut: read("OPENCLAW_CONTINUATION_FOREST_FANOUT", DEFAULT_ANNEX_SHAPE.fanOut),
  };
}

/** Rooms in a forest of this shape, princes included. */
export function annexRoomCount(shape: AnnexShape): number {
  let perTree = 0;
  for (let generation = 0, width = 1; generation < shape.depth; generation += 1) {
    perTree += width;
    width *= shape.fanOut;
  }
  return perTree * shape.trees;
}
