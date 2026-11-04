// Continuation (karmaterminal/openclaw#1271): the burning annex, a world for continuation forests.
//
//   Winter, and the annex is burning. Each prince sends shadow clones down the halls; every clone
//   folds one paper crane and reports back up its line, one across to another wing, one shouting
//   to every room. Each prince leaves a runner on the stairs and asks to be woken to check the
//   attic again. Then trouble: princes change clothes, halls are reset, rooms change hands, the
//   Gateway restarts. When the smoke clears every crane was folded once, every report found its
//   room's current occupant once, and nobody who lost a room hears what was not meant for them.
//
// Real: the agent database (sessions, recipient authority epochs), the subagent registry and its
// reset-retention marks, continuation custody (elections, claims, re-arm, recovery), the durable
// session-delivery queue and its production retry runtime, the return router, the Gateway reset,
// chat /new, prompt adoption and acknowledgement, restart recovery. Doubled, and only at the edge
// of the Gateway: the spawn owner (it admits the child through the real registry, then the world
// folds that child's crane), the reply owner (a continue_work wake turn checks the attic; a room
// may run the real one instead, its admission, follow-up mailbox and drain, with only its provider
// doubled), and continuation wake requests (recorded: every head with queued events takes its
// turn, and the oracle requires a wake for every return a head adopted). Faked: the clock (Date,
// setTimeout, performance), and the world outside the Gateway: the crane bits and the
// append-only attempt log, which survive a Gateway restart as the outside world would. Relays and
// cranes are written through the registry writer as clones of one real registration.
//
// The world's modules: model (vocabulary), build (rooms, runs, elections), fire (folds, reports,
// the spawn, reply and provider doubles), trouble (swaps, handovers, restarts, crashes, cancels,
// users), oracle (the stories).
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resetContinuationCustodyProjection } from "../../../auto-reply/continuation/custody/custody-projection.js";
import {
  hydrateContinuationCustody,
  listContinuationRecords,
} from "../../../auto-reply/continuation/custody/custody-store.js";
import { resetDelegateDispatchHedgesForTests } from "../../../auto-reply/continuation/delegate-dispatch.js";
import type { cancelOwnedContinuationRecords } from "../../../auto-reply/continuation/session-reset.js";
import { resetContinuationWorkDispatchForTests } from "../../../auto-reply/continuation/work-dispatch.js";
import { withFullRuntimeReplyConfig } from "../../../auto-reply/reply/get-reply-fast-path.js";
import { getExistingFollowupQueue } from "../../../auto-reply/reply/queue/state.js";
import {
  resolveFinalSystemEventAdoption,
  settleManagedSystemEventsAfterTurnAdoption,
} from "../../../auto-reply/reply/session-system-event-adoption.js";
import { prepareFormattedSystemEvents } from "../../../auto-reply/reply/session-system-events.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { deliverQueuedSessionDelivery } from "../../../gateway/server-restart-sentinel.js";
import { GatewayScheduler } from "../../../infra/gateway-scheduler.js";
import { startSessionDeliveryRuntime } from "../../../infra/session-delivery-queue-runtime.js";
import { resolveSystemEventQueueKey } from "../../../infra/system-event-ownership.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../../infra/system-events.js";
import { defaultRuntime } from "../../../runtime.js";
import { isSessionRunActiveForKey } from "../../../sessions/session-controller.queries.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { buildForest, lightAnnex } from "./continuation-forest.build.test-support.js";
import {
  admitRunner,
  checkAttic,
  provideTurn,
  reportElection,
} from "./continuation-forest.fire.test-support.js";
import {
  AGENT_ID,
  ANNEX_STEP_MS,
  type Adoption,
  type AnnexElection,
  type AnnexNode,
  type AnnexShape,
  type AttemptLogLine,
  DEFAULT_ANNEX_SHAPE,
  type ElectionExpectation,
  type Handover,
  REPORT_TAG,
  type Report,
  realNowMs,
} from "./continuation-forest.model.test-support.js";
import { tellStories } from "./continuation-forest.oracle.test-support.js";
import {
  continuationForestSeams,
  type WorkMark,
} from "./continuation-forest.seams.test-support.js";
import * as trouble from "./continuation-forest.trouble.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";

const DELIVERED_TO = /\[continuation:targeted-return\] Delivered to (\S+) from (\S+)/;
/** Below this many rooms every settle round looks into every room; above, only rooms touched. */
const FULL_SCAN_ROOMS = 2_000;

type Gate = {
  point: string;
  reached: PromiseWithResolvers<void>;
  released: PromiseWithResolvers<void>;
  parked: boolean;
};

const opContext = new AsyncLocalStorage<{ parked: boolean }>();

/**
 * Installs the annex around each test: continuation enabled, custody hydrated, the fake clock, the
 * production session-delivery runtime on it, and the world's seams. Call after
 * useSubagentControlFixture(), whose state directory and registry the world uses. With
 * `realReplyOwner`, the configuration a room needs to run the real reply owner
 * (forest.runsRealReplyOwner); its suite mocks the provider with the world's `providerEdge` seam.
 */
export function useContinuationForest(
  stateDir: () => string,
  options: { realReplyOwner?: boolean } = {},
) {
  let world: ContinuationForest | undefined;
  beforeEach(async () => {
    const base: OpenClawConfig = {
      agents: { defaults: { workspace: stateDir(), continuation: { enabled: true } } },
      session: {
        // Direct rooms per sender, so a prince's chat /new lands on the prince's own room.
        dmScope: "per-account-channel-peer",
        // Room for the whole forest: past maxEntries (default 5,000) store maintenance evicts rooms,
        // owners of live elections included (karmaterminal/openclaw#1271 load findings).
        maintenance: { maxEntries: 1_000_000 },
      },
    };
    const config = options.realReplyOwner ? withRealReplyOwner(base) : base;
    await writeFile(path.join(stateDir(), "openclaw.json"), JSON.stringify(config));
    setRuntimeConfigSnapshot(config);
    await captureRuntimeConfigAsyncReader()();
    await hydrateContinuationCustody();
    // The work dispatcher imports the reply owner lazily; load the suite's double once up front so
    // concurrent first imports cannot race its mock factory.
    await import("../../../auto-reply/reply/get-reply.js");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    world = new ContinuationForest(stateDir(), observeRootWork(), options.realReplyOwner === true);
  });
  afterEach(async () => {
    await world?.dispose();
    world = undefined;
    vi.useRealTimers();
    resetContinuationWorkDispatchForTests();
    resetDelegateDispatchHedgesForTests();
    resetContinuationCustodyProjection();
  });
  return {
    async build(shape: AnnexShape = DEFAULT_ANNEX_SHAPE): Promise<ContinuationForest> {
      if (!world) {
        throw new Error("useContinuationForest: build() runs inside a test");
      }
      await world.build(shape);
      return world;
    },
  };
}

/**
 * What a room's real reply owner needs: the full reply runtime, a model whose provider the world
 * stands in for, no plugins, and a user's turn that queues as a follow-up behind a running one.
 */
function withRealReplyOwner(config: OpenClawConfig): OpenClawConfig {
  return withFullRuntimeReplyConfig({
    ...config,
    agents: {
      defaults: {
        ...config.agents?.defaults,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-4o" },
        models: { "mock-openai/gpt-4o": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    messages: { queue: { mode: "followup" } },
  });
}

export class ContinuationForest {
  readonly storePath: string;
  shape: AnnexShape = DEFAULT_ANNEX_SHAPE;
  /** When the fire was lit; story times are relative to it. */
  t0 = 0;
  /** Gateway process generation: a restart begins the next one. */
  generation = 0;
  /** The world's event order, for adoptions, reports and handovers that share a clock time. */
  seq = 0;
  readonly nodes = new Map<string, AnnexNode>();
  readonly princes: AnnexNode[] = [];
  readonly rooms = new Set<string>();
  readonly elections = new Map<string, AnnexElection>();
  /** The append-only attempt log, and its lines by election. */
  readonly attempts: AttemptLogLine[] = [];
  readonly attemptsByElection = new Map<string, AttemptLogLine[]>();
  /** The crane bits: 1 once a fold committed. Never the oracle on its own. */
  readonly bits = new Map<string, 0 | 1>();
  readonly reports = new Map<string, Report>();
  /** Elections whose child the Gateway stopped before it could report, with why. */
  readonly stopped = new Map<string, string>();
  readonly adoptions: Adoption[] = [];
  readonly adoptionCounts = new Map<string, number>();
  /** Every block a head adopted, with its room and time. */
  readonly adoptedBlocks: Array<{ sessionKey: string; text: string; at: number }> = [];
  readonly wakes: Array<{ sessionKey: string; deliveryIds: readonly string[] }> = [];
  /** Durable rows a head's turn adopted and acknowledged. */
  readonly adoptedDeliveryIds = new Set<string>();
  /** Once disposed, work a released barrier lets go of stops before it reaches the Gateway. */
  disposed = false;
  readonly spawns: Array<{ electionId: string; childRunId: string; at: number }> = [];
  /** `Delivered to` lines: the rooms named, and the child whose return it was. */
  readonly deliveredLines: Array<{ keys: string[]; from: string; at: number }> = [];
  readonly logLines: Array<{ subsystem: string; message: string; at: number }> = [];
  readonly handovers: Handover[] = [];
  /** When the Gateway was down: from the restart until its boot finished. */
  readonly downtimes: Array<{ from: number; to: number }> = [];
  /** How often each row's queued copy was dropped by a reset or a restart. */
  readonly drops = new Map<string, number>();
  /** Return rows by `${sourceRunId}\0${room}`. */
  readonly rows = new Map<string, string>();
  readonly cancelReceipts: Array<Awaited<ReturnType<typeof cancelOwnedContinuationRecords>>> = [];
  /** Refused destinations a scenario expects, `${reportId}\0${room}` to reason. */
  readonly expectedRefusals = new Map<string, string>();
  readonly failures: string[] = [];
  /** Wall-time totals (`name`) and call counts (`name:calls`) for the load report. */
  readonly timings: Record<string, number> = {};
  /** Child reports each relay or prince adopted, `pending:<branch>` for a runner on its way. */
  readonly childReports = new Map<string, Set<string>>();
  readonly relayReported = new Set<string>();
  /** Relays that adopted a report since their readiness was last looked at. */
  readonly relaysToCheck = new Set<AnnexNode>();
  /** Runner (branch) elections by the id of the room that elected them. */
  readonly runners = new Map<string, AnnexElection[]>();
  /** Rooms whose turns run the real reply owner (runsRealReplyOwner). */
  readonly realReplyRooms = new Set<string>();
  /** The Gateway dies as the work dispatcher writes this wake's `mark` (crashMidWake). */
  dying: { flowId: string; mark: WorkMark; died: () => void } | undefined;
  stopDeliveryRuntime: (() => Promise<void>) | undefined;

  private readonly ops = new Set<Promise<unknown>>();
  private readonly parked = new WeakMap<Promise<unknown>, { parked: boolean }>();
  private readonly gates: Gate[] = [];
  private readonly heldTurns = new Set<string>();
  private readonly touchedRooms = new Set<string>();
  private readonly queueKeys = new Map<string, string>();
  private parkSignal = Promise.withResolvers<void>();

  constructor(
    readonly stateDir: string,
    private readonly settleRootWork: (keepObserving?: boolean) => Promise<void>,
    private readonly replyRuntime: boolean,
  ) {
    this.storePath = path.join(stateDir, "agents", AGENT_ID, "sessions", "sessions.json");
  }

  // ---------------------------------------------------------------------------------------------
  // The story's verbs

  async build(shape: AnnexShape): Promise<void> {
    const started = realNowMs();
    this.shape = shape;
    this.installSeams();
    this.startDeliveryRuntime();
    await buildForest(this, shape);
    this.timings.buildMs = realNowMs() - started;
  }

  /** Lights the annex: every clone starts folding; runners and attic wakes are elected. */
  async light(): Promise<void> {
    await lightAnnex(this);
    await this.settle();
  }

  changesClothes = (prince: AnnexNode) => trouble.changesClothes(this, prince);
  reset = (node: AnnexNode, reason?: "new" | "reset") => trouble.resetRoom(this, node, reason);
  handOver = (node: AnnexNode, how?: Handover["how"]) => trouble.handOver(this, node, how);
  restart = () => trouble.restartGateway(this);
  crashMidWake = (attic: AnnexElection, after: "effect" | "delivered mark") =>
    trouble.crashMidWake(this, attic, after);
  cancel = (owner: AnnexNode, electionIds: string[]) =>
    trouble.cancelElections(this, owner, electionIds);
  says = (node: AnnexNode, who: string) => trouble.userSays(this, node, who);

  /** From now on the room's turns run the real reply owner; the world stands in for its provider. */
  runsRealReplyOwner(node: AnnexNode): void {
    if (!this.replyRuntime) {
      throw new Error("runsRealReplyOwner: install the annex with { realReplyOwner: true }");
    }
    this.realReplyRooms.add(node.sessionKey);
  }

  /** Every way the forest broke, told as the story. Empty when everything held. */
  async stories(): Promise<string[]> {
    await this.settle();
    return await tellStories(this);
  }

  /** Asserts the forest held, with the story of every break as the failure message. */
  async expectForestHolds(): Promise<void> {
    const stories = await this.stories();
    expect(stories, `the annex broke:\n  ${stories.join("\n  ")}`).toEqual([]);
  }

  /** The scenario expects this election to end without running (refused at `stage`, cancelled). */
  expectElection(election: AnnexElection, expected: ElectionExpectation): void {
    election.expected = expected;
    // A relay waiting on a runner it will no longer see may be ready now.
    if (election.owner?.role === "relay") {
      this.relaysToCheck.add(election.owner);
    }
  }

  /** The scenario expects `electionId`'s report to `sessionKey` to be refused with `reason`. */
  expectRefusedDelivery(electionId: string, sessionKey: string, reason: string): void {
    this.expectedRefusals.set(`${electionId}\u0000${sessionKey}`, reason);
  }

  // ---------------------------------------------------------------------------------------------
  // Lookups

  node(id: string): AnnexNode {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`no node ${id} in the annex`);
    }
    return node;
  }

  /** The election a relay or crane runs. */
  electionOf(node: AnnexNode): AnnexElection {
    return this.elections.get(node.runId!)!;
  }

  election(name: string): AnnexElection {
    const found = [...this.elections.values()].find((election) => election.name === name);
    if (!found) {
      throw new Error(`no election "${name}" in the annex`);
    }
    return found;
  }

  attic = (tree: number) => this.election(`the attic inspector of tree ${tree}`);
  lateRunner = (tree: number) => this.election(`the late runner of tree ${tree}`);
  cellarRunner = (tree: number) => this.election(`the cellar runner of tree ${tree}`);

  /** The room tree `tree`'s across relay reports to besides its prince. */
  acrossTarget(tree: number): AnnexNode {
    const routing = this.princes[tree]!.children[1]?.routing;
    if (routing?.kind !== "out-of-tree") {
      throw new Error(`tree ${tree} has no report across`);
    }
    return routing.target;
  }

  /** The election's custody record, for branches and attics. */
  async record(election: AnnexElection) {
    return (await listContinuationRecords({ recordIds: [election.id] }))[0];
  }

  /** The room's current head: its session and the lifecycle revision a reset commits. */
  head(sessionKey: string): string | undefined {
    const entry = loadSessionEntry({
      storePath: this.storePath,
      sessionKey,
      readConsistency: "latest",
    });
    return entry ? `${entry.sessionId}@${entry.lifecycleRevision ?? "initial"}` : undefined;
  }

  /** The prompts queued in the room's follow-up mailbox (a room running the real reply owner). */
  followups(sessionKey: string): string[] {
    return (getExistingFollowupQueue(sessionKey)?.items ?? []).map((item) => item.prompt);
  }

  /** Whether a turn is running in the room. */
  turnRunning(sessionKey: string): boolean {
    return isSessionRunActiveForKey(sessionKey);
  }

  /** The child run behind an election: its node's run, or the run a branch spawned. */
  runIdOf(election: AnnexElection): string {
    if (election.node?.runId) {
      return election.node.runId;
    }
    const spawn = this.spawns.findLast((candidate) => candidate.electionId === election.id);
    if (!spawn) {
      throw new Error(`${election.name} never spawned`);
    }
    return spawn.childRunId;
  }

  // ---------------------------------------------------------------------------------------------
  // The world's books

  logAttempt(electionId: string, kind: AttemptLogLine["kind"]): void {
    const line = { electionId, kind, at: Date.now(), generation: this.generation };
    this.attempts.push(line);
    const lines = this.attemptsByElection.get(electionId) ?? [];
    lines.push(line);
    this.attemptsByElection.set(electionId, lines);
  }

  /** Accumulates wall time under `name` and counts the calls under `${name}:calls`. */
  time(name: string, startedAt: number): void {
    this.timings[name] = (this.timings[name] ?? 0) + realNowMs() - startedAt;
    this.timings[`${name}:calls`] = (this.timings[`${name}:calls`] ?? 0) + 1;
  }

  childReportsFor(node: AnnexNode): Set<string> {
    let reports = this.childReports.get(node.id);
    if (!reports) {
      reports = new Set();
      this.childReports.set(node.id, reports);
    }
    return reports;
  }

  addRoom(sessionKey: string): void {
    this.rooms.add(sessionKey);
    this.touchedRooms.add(sessionKey);
  }

  private queueKey(sessionKey: string): string {
    let key = this.queueKeys.get(sessionKey);
    if (!key) {
      key = resolveSystemEventQueueKey(sessionKey, AGENT_ID);
      this.queueKeys.set(sessionKey, key);
    }
    return key;
  }

  queuedEvents(sessionKey: string) {
    return peekSystemEventEntries(this.queueKey(sessionKey));
  }

  /** Queued copies of durable rows a reset or restart drops; their sweep or replay wakes again. */
  recordDrops(sessionKeys: Iterable<string>): void {
    for (const sessionKey of sessionKeys) {
      for (const event of this.queuedEvents(sessionKey)) {
        const id = event.sessionDeliveryAckId;
        if (id) {
          this.drops.set(id, (this.drops.get(id) ?? 0) + 1);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The edge of the Gateway

  private installSeams(): void {
    continuationForestSeams.spawn = (params, context) => admitRunner(this, params, context);
    continuationForestSeams.reply = (ctx, opts) => checkAttic(this, ctx, opts);
    continuationForestSeams.realReplyRoom = (sessionKey) => this.realReplyRooms.has(sessionKey);
    continuationForestSeams.provider = (params) => provideTurn(this, params);
    continuationForestSeams.wake = (request) => {
      this.wakes.push({ sessionKey: request.sessionKey, deliveryIds: request.deliveryIds });
      this.touchedRooms.add(request.sessionKey);
    };
    continuationForestSeams.afterDeliveryRowWritten = async (payload, id) => {
      this.touchedRooms.add(payload.sessionKey);
      const sourceRunId =
        payload.kind === "systemEvent" ? payload.continuationSourceRunId : undefined;
      if (sourceRunId) {
        this.rows.set(`${sourceRunId}\u0000${payload.sessionKey}`, id);
        await this.gate(`row:${sourceRunId}>${payload.sessionKey}`);
      }
    };
    continuationForestSeams.clockWait = () => this.clockWait();
    continuationForestSeams.beforeResetKill = (sessionKey) => this.gate(`reset-kill:${sessionKey}`);
    continuationForestSeams.beforeWorkMark = async (mark, work) => {
      const dying = this.dying;
      if (dying && dying.flowId === work.flowId && dying.mark === mark) {
        this.dying = undefined;
        dying.died();
        await this.die();
      }
    };
    continuationForestSeams.logLine = (subsystem, message) => {
      if (message.startsWith("[continuation:")) {
        this.logLines.push({ subsystem, message, at: Date.now() });
      }
    };
    vi.spyOn(defaultRuntime, "log").mockImplementation((...args: unknown[]) => {
      const match = DELIVERED_TO.exec(String(args[0]));
      if (match) {
        this.deliveredLines.push({ keys: match[1]!.split(","), from: match[2]!, at: Date.now() });
      }
    });
  }

  /** The production session-delivery runtime; its timers run on the fake clock. */
  startDeliveryRuntime(): void {
    const scheduler = new GatewayScheduler({
      clock: {
        now: () => Date.now(),
        monotonicNow: () => performance.now(),
        // Each wake joins the drains it starts, so settle() waits for them.
        arm: (run, delayMs) => {
          const timer = setTimeout(() => void this.track(Promise.resolve(run())), delayMs);
          return () => clearTimeout(timer);
        },
      },
    });
    this.stopDeliveryRuntime = startSessionDeliveryRuntime({
      scheduler,
      queueContext: captureOpenClawStateWorkerContext(),
      deliver: (entry, { queueContext }) =>
        deliverQueuedSessionDelivery({ deps: {} as never, entry, queueContext }),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      random: () => 0.5,
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const gate of this.gates) {
      gate.released.resolve();
    }
    this.heldTurns.clear();
    await this.stopDeliveryRuntime?.();
    this.stopDeliveryRuntime = undefined;
    for (const key of Object.keys(continuationForestSeams) as Array<
      keyof typeof continuationForestSeams
    >) {
      delete continuationForestSeams[key];
    }
    resetSystemEventsForTest();
  }

  // ---------------------------------------------------------------------------------------------
  // Barriers and the clock

  /**
   * Holds the next actor that reaches `point` until released: `before-flip:<election>` and
   * `after-flip:<election>` (a crane's or runner's fold; the latter is the replay barrier),
   * `report:<election>` (a relay about to report), the row barrier from rowPoint(), or
   * `reset-kill:<room>` (a reset of the room between its retention marks and its kill).
   */
  hold(point: string) {
    const gate: Gate = {
      point,
      reached: Promise.withResolvers<void>(),
      released: Promise.withResolvers<void>(),
      parked: false,
    };
    this.gates.push(gate);
    return {
      point,
      reached: gate.reached.promise,
      release: async () => {
        gate.released.resolve();
        await this.settle();
      },
    };
  }

  /**
   * The barrier inside a return's producer: its durable row for `sessionKey` is written, its
   * event not yet queued, its recipient authority not yet checked again.
   */
  rowPoint(election: AnnexElection, sessionKey: string): string {
    return `row:${this.runIdOf(election)}>${sessionKey}`;
  }

  async gate(point: string): Promise<void> {
    const gate = this.gates.find((candidate) => candidate.point === point && !candidate.parked);
    if (!gate) {
      return;
    }
    gate.parked = true;
    const ended = this.clockWait();
    gate.reached.resolve();
    await gate.released.promise;
    ended();
    this.gates.splice(this.gates.indexOf(gate), 1);
  }

  /** Marks the current world operation as waiting until the returned callback runs. */
  private clockWait(): () => void {
    const op = opContext.getStore();
    if (!op) {
      return () => {};
    }
    op.parked = true;
    this.parkSignal.resolve();
    return () => {
      op.parked = false;
    };
  }

  /**
   * The process running the current world operation dies here: the operation never resumes, so
   * nothing after this point runs, and settle() no longer waits for it.
   */
  async die(): Promise<never> {
    if (!opContext.getStore()) {
      throw new Error("only a world operation can die: run it with forest.run()");
    }
    this.clockWait();
    return await new Promise<never>(() => {});
  }

  /** A world operation's wait on the clock: settle() does not wait for it. */
  async sleep(ms: number): Promise<void> {
    const ended = this.clockWait();
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    } finally {
      ended();
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.ops.add(work);
    void work.finally(() => this.ops.delete(work)).catch(() => {});
    return work;
  }

  /** Runs `work` as a world operation: settle() waits for it unless it waits on the clock. */
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return new Promise<T>(() => {});
    }
    const state = { parked: false };
    const promise = opContext.run(state, work);
    this.parked.set(promise, state);
    return this.track(promise);
  }

  /** World operations still running, and how many of them wait on the clock or a barrier. */
  opStats(): { live: number; parked: number } {
    const ops = [...this.ops];
    return { live: ops.length, parked: ops.filter((op) => this.parked.get(op)?.parked).length };
  }

  /** Lets everything that is not waiting on the clock or a barrier finish. */
  async settle(): Promise<void> {
    const started = realNowMs();
    try {
      for (let round = 0; round < 100_000; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await this.settleRootWork(true);
        const live = [...this.ops].filter((op) => !this.parked.get(op)?.parked);
        if (live.length > 0) {
          this.parkSignal = Promise.withResolvers<void>();
          await Promise.race([Promise.allSettled(live), this.parkSignal.promise]);
          continue;
        }
        if ((await this.takeTurns()) || this.reportReadyRelays()) {
          continue;
        }
        return;
      }
      throw new Error("the annex never settled");
    } finally {
      this.time("settleMs", started);
    }
  }

  /**
   * Advances the clock in steps, settling the forest at every step. Longer steps are only for
   * stretches with no election due: an action a timer starts finishes at the end of its step.
   */
  async advance(ms: number, stepMs = ANNEX_STEP_MS): Promise<void> {
    if (ms % ANNEX_STEP_MS !== 0 || stepMs % ANNEX_STEP_MS !== 0) {
      throw new Error(`advance(${ms}, ${stepMs}) is not in whole ${ANNEX_STEP_MS}ms steps`);
    }
    for (let elapsed = 0; elapsed < ms;) {
      const step = Math.min(stepMs, ms - elapsed);
      await vi.advanceTimersByTimeAsync(step);
      elapsed += step;
      await this.settle();
    }
  }

  /** Advances to `t0 + atMs`. */
  async advanceTo(atMs: number, stepMs = ANNEX_STEP_MS): Promise<void> {
    await this.advance(this.t0 + atMs - Date.now(), stepMs);
  }

  /** Advances step by step until `barrier` is reached; fails the story if it is not by `t0 + byMs`. */
  async until(barrier: { point: string; reached: Promise<void> }, byMs: number): Promise<void> {
    const state = { reached: false };
    void barrier.reached.then(() => {
      state.reached = true;
    });
    await this.settle();
    while (!state.reached) {
      if (Date.now() - this.t0 >= byMs) {
        throw new Error(`nobody reached the barrier ${barrier.point} by ${byMs}ms`);
      }
      await this.advance(ANNEX_STEP_MS);
    }
  }

  /**
   * Advances the clock step by step until `work` (world operations) settles; fails the story after
   * `maxMs`. settle() returns only once every operation still running waits on the clock, so the
   * clock never runs ahead of real work.
   */
  async whileTimePasses<T>(work: Promise<T>, what: string, maxMs = 120_000): Promise<T> {
    const state = { done: false };
    const finish = () => {
      state.done = true;
    };
    void work.then(finish, finish);
    const deadline = Date.now() + maxMs;
    await this.settle();
    while (!state.done) {
      if (Date.now() >= deadline) {
        throw new Error(`${what} never finished within ${maxMs}ms`);
      }
      await this.advance(ANNEX_STEP_MS);
    }
    return await work;
  }

  /** Until released, `sessionKey`'s head takes no turns: its queued returns wait. */
  holdTurns(sessionKey: string) {
    this.heldTurns.add(sessionKey);
    return {
      release: async () => {
        this.heldTurns.delete(sessionKey);
        this.touchedRooms.add(sessionKey);
        await this.settle();
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Heads, turns and relays

  /** Every head with queued events takes a turn. True when a turn consumed anything. */
  private async takeTurns(): Promise<boolean> {
    const candidates =
      this.rooms.size <= FULL_SCAN_ROOMS ? [...this.rooms] : [...this.touchedRooms];
    this.touchedRooms.clear();
    let progressed = false;
    for (const sessionKey of candidates) {
      const before = this.queuedEvents(sessionKey).length;
      if (before === 0) {
        continue;
      }
      if (this.heldTurns.has(sessionKey)) {
        this.touchedRooms.add(sessionKey);
        continue;
      }
      const adopted = await this.run(() => this.nextTurn(sessionKey));
      const after = this.queuedEvents(sessionKey).length;
      if (after > 0) {
        this.touchedRooms.add(sessionKey);
      }
      progressed ||= adopted > 0 || after < before;
    }
    return progressed;
  }

  /** The head's next turn adopts and acknowledges what it may (as the refused-return suite runs it). */
  private async nextTurn(sessionKey: string): Promise<number> {
    const started = realNowMs();
    const prepared = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: AGENT_ID,
      sessionKey,
      isMainSession: false,
      isNewSession: false,
    });
    let adoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
    while (adoption.kind === "settle-stale") {
      await adoption.settle();
      adoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
    }
    const ackIds = [...adoption.managedDeliveries.keys()];
    for (const id of ackIds) {
      this.adoptedDeliveryIds.add(id);
    }
    await settleManagedSystemEventsAfterTurnAdoption({
      deliveries: adoption.managedDeliveries.values(),
      persistedMessage: { __openclaw: { sessionDeliveryAckIds: ackIds } },
    });
    const head = this.head(sessionKey) ?? "missing";
    this.time("turnMs", started);
    let count = 0;
    for (const block of adoption.blocks) {
      this.adoptedBlocks.push({ sessionKey, text: block.text, at: Date.now() });
      for (const match of block.text.matchAll(REPORT_TAG)) {
        this.noteAdoption(sessionKey, match[1]!, head);
        count += 1;
      }
    }
    return count;
  }

  private noteAdoption(sessionKey: string, reportId: string, head: string): void {
    const at = Date.now();
    this.adoptions.push({
      reportId,
      sessionKey,
      head,
      at,
      generation: this.generation,
      seq: ++this.seq,
    });
    const key = `${reportId}\u0000${sessionKey}`;
    this.adoptionCounts.set(key, (this.adoptionCounts.get(key) ?? 0) + 1);
    const election = this.elections.get(reportId);
    const parent = election?.kind === "branch" ? election.owner : election?.node?.parent;
    if (parent?.sessionKey !== sessionKey) {
      return;
    }
    const reports = this.childReportsFor(parent);
    reports.delete(`pending:${reportId}`);
    reports.add(reportId);
    if (parent.role === "relay") {
      this.relaysToCheck.add(parent);
    }
  }

  /** A relay reports once every child of its wing, and any runner it sent, reported to it. */
  private reportReadyRelays(): boolean {
    let started = false;
    for (const relay of this.relaysToCheck) {
      this.relaysToCheck.delete(relay);
      if (this.relayReported.has(relay.id) || !this.relayReady(relay)) {
        continue;
      }
      this.relayReported.add(relay.id);
      const election = this.electionOf(relay);
      this.logAttempt(election.id, "attempt");
      this.logAttempt(election.id, "effect");
      void this.run(async () => {
        await this.gate(`report:${election.id}`);
        await reportElection(this, election);
      }).catch((error: unknown) => this.failures.push(`${election.name}: ${String(error)}`));
      started = true;
    }
    return started;
  }

  private relayReady(relay: AnnexNode): boolean {
    const reports = this.childReportsFor(relay);
    if ([...reports].some((report) => report.startsWith("pending:"))) {
      return false;
    }
    const runners = (this.runners.get(relay.id) ?? []).filter(
      (runner) => runner.expected.outcome === "executed",
    );
    return (
      runners.every((runner) => reports.has(runner.id)) &&
      relay.children.every((child) => reports.has(child.runId!))
    );
  }
}
