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
// folds that child's crane), the reply owner (a continue_work wake turn checks the attic), and
// continuation wake requests (recorded; the world runs each woken head's turn itself). Faked: the
// clock (Date, setTimeout, performance), and the world outside the Gateway: the crane bits and the
// append-only attempt log, which survive a Gateway restart as the outside world would.
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resolveContinuationRuntimeConfig } from "../../../auto-reply/continuation/config.js";
import { runContinuationCustodyBoot } from "../../../auto-reply/continuation/custody-boot.js";
import { resetContinuationCustodyProjection } from "../../../auto-reply/continuation/custody/custody-projection.js";
import {
  hydrateContinuationCustody,
  listContinuationRecords,
} from "../../../auto-reply/continuation/custody/custody-store.js";
import { custodyStateForTest } from "../../../auto-reply/continuation/custody/custody.test-support.js";
import {
  dispatchToolDelegates,
  resetDelegateDispatchHedgesForTests,
} from "../../../auto-reply/continuation/delegate-dispatch.js";
import { enqueuePendingDelegate } from "../../../auto-reply/continuation/delegate-store.js";
import {
  captureContinuationRecipientAuthorities,
  resolveSpawnRecipientAuthorityBinding,
} from "../../../auto-reply/continuation/recipient-authority-binding.js";
import { resolveContinuationResetRetentions } from "../../../auto-reply/continuation/session-reset-retention-resolve.js";
import { cancelOwnedContinuationRecords } from "../../../auto-reply/continuation/session-reset.js";
import {
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
} from "../../../auto-reply/continuation/work-dispatch.js";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import {
  resolveFinalSystemEventAdoption,
  settleManagedSystemEventsAfterTurnAdoption,
} from "../../../auto-reply/reply/session-system-event-adoption.js";
import { prepareFormattedSystemEvents } from "../../../auto-reply/reply/session-system-events.js";
import { initSessionState } from "../../../auto-reply/reply/session.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import * as accessor from "../../../config/sessions/session-accessor.js";
import type { ContinuationRecipientAuthorityBinding } from "../../../config/sessions/session-recipient-authority-types.js";
import { addSessionMember } from "../../../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  deliverQueuedSessionDelivery,
  recoverPendingProducedSessionDeliveries,
} from "../../../gateway/server-restart-sentinel.js";
import { performGatewaySessionReset } from "../../../gateway/session-reset-service.js";
import { inspectDeliveryQueueReceipt } from "../../../infra/delivery-queue-sqlite.js";
import { captureDeliveryQueueStateContext } from "../../../infra/delivery-queue-state-context.js";
import { GatewayScheduler } from "../../../infra/gateway-scheduler.js";
import {
  schedulePendingSessionDeliveries,
  startSessionDeliveryRuntime,
} from "../../../infra/session-delivery-queue-runtime.js";
import { resolveSystemEventQueueKey } from "../../../infra/system-event-ownership.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../../infra/system-events.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { routeSubagentContinuationReturn } from "../../subagent-announce.continuation-return.js";
import { buildSubagentContinuationRegistrationFields } from "../spawn/subagent-spawn-continuation.js";
import { continuationForestSeams } from "./continuation-forest.seams.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeChildSession } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Trees, generations below each prince (prince included), children per node. */
export type AnnexShape = { trees: number; depth: number; fanOut: number };
export const DEFAULT_ANNEX_SHAPE: AnnexShape = { trees: 3, depth: 4, fanOut: 3 };

/** The clock moves in steps of this size; every due time in the annex is a multiple of it. */
export const ANNEX_STEP_MS = 250;
/** A clone folds its crane over one second. */
export const FOLD_MS = 1_000;
/** The cellar runner (relay 0 of each tree) and the late runner (each prince) wait this long. */
export const CELLAR_RUNNER_DELAY_MS = 1_500;
export const LATE_RUNNER_DELAY_MS = 2_500;
/** Each prince asks to be woken this long after the fire starts to check the attic again (the minimum delay). */
export const ATTIC_DELAY_MS = 5_000;

const AGENT_ID = "main";
const OWNER_A = { type: "human" as const, source: "unknown" as const, id: "owner-a" };
const OWNER_B = { type: "human" as const, id: "owner-b" };
const CHAIN = { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 };

type Routing = { kind: "requester" } | { kind: "out-of-tree"; target: AnnexNode } | { kind: "all" };

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

type ElectionKind = "crane" | "relay" | "branch" | "attic";
type ElectionOutcome = "executed" | "refused" | "cancelled" | "interrupted";
type ElectionExpectation = { outcome: ElectionOutcome; reason?: string; stage?: string };

export type AnnexElection = {
  /** The election id: the child run (crane, relay), the custody record (branch, attic). */
  id: string;
  kind: ElectionKind;
  name: string;
  tree: number;
  ownerSessionKey: string;
  node?: AnnexNode;
  dueAt?: number;
  expected: ElectionExpectation;
};

/** One line of the append-only attempt log, kept outside the Gateway. */
type AttemptLogLine = {
  electionId: string;
  kind: "attempt" | "effect";
  at: number;
  generation: number;
};

type Report = {
  electionId: string;
  runId: string;
  name: string;
  text: string;
  at: number;
  intended: string[];
};

type Adoption = {
  reportId: string;
  sessionKey: string;
  head: string;
  at: number;
  generation: number;
};

type WakeRequest = { sessionKey: string; deliveryIds: readonly string[]; generation: number };
type Handover = { sessionKey: string; at: number; how: "delete and recreate" | "owner change" };

type Gate = {
  point: string;
  reached: PromiseWithResolvers<void>;
  released: PromiseWithResolvers<void>;
  parked: boolean;
};

const REPORT_TAG = /\[annex:report ([^\]]+)\]/g;
const DELIVERED_TO = /\[continuation:targeted-return\] Delivered to (\S+) from (\S+)/;

const opContext = new AsyncLocalStorage<{ parked: boolean }>();

function princeKey(tree: number): string {
  return `agent:main:telegram:default:direct:prince-${tree}`;
}

function nodeKey(id: string): string {
  return `agent:main:subagent:annex-${id.replaceAll(".", "-")}`;
}

/** Wall time, which the fake clock does not move. */
export function realNowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function describeTimes(lines: readonly AttemptLogLine[], t0: number): string {
  return lines.map((line) => `${line.at - t0}ms (gen ${line.generation})`).join(", ");
}

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

/**
 * Installs the annex around each test: continuation enabled, custody hydrated, the fake clock, the
 * production session-delivery runtime on it, and the world's seams. Call after
 * useSubagentControlFixture(), whose state directory and registry the world uses.
 */
export function useContinuationForest(stateDir: () => string) {
  let world: ContinuationForest | undefined;
  beforeEach(async () => {
    const config = {
      agents: { defaults: { workspace: stateDir(), continuation: { enabled: true } } },
      // Direct rooms per sender, so a prince's chat /new lands on the prince's own room.
      session: { dmScope: "per-account-channel-peer" as const },
    };
    await writeFile(path.join(stateDir(), "openclaw.json"), JSON.stringify(config));
    setRuntimeConfigSnapshot(config);
    await captureRuntimeConfigAsyncReader()();
    await hydrateContinuationCustody();
    // The work dispatcher imports the reply owner lazily; load the suite's double once up front so
    // concurrent first imports cannot race its mock factory.
    await import("../../../auto-reply/reply/get-reply.js");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    world = new ContinuationForest(stateDir(), observeRootWork());
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

export class ContinuationForest {
  readonly nodes = new Map<string, AnnexNode>();
  readonly princes: AnnexNode[] = [];
  readonly elections = new Map<string, AnnexElection>();
  readonly attempts: AttemptLogLine[] = [];
  readonly bits = new Map<string, 0 | 1>();
  readonly reports = new Map<string, Report>();
  readonly adoptions: Adoption[] = [];
  /** Every block a head adopted, with its room and time. */
  readonly adoptedBlocks: Array<{ sessionKey: string; text: string; at: number }> = [];
  readonly wakes: WakeRequest[] = [];
  readonly spawns: Array<{ electionId: string; childRunId?: string; at: number }> = [];
  readonly deliveredLines: Array<{ keys: string[]; at: number }> = [];
  readonly logLines: Array<{ subsystem: string; message: string; at: number }> = [];
  readonly handovers: Handover[] = [];
  /** Return rows by source run and recipient. */
  readonly rows = new Map<string, string>();
  readonly cancelReceipts: Array<Awaited<ReturnType<typeof cancelOwnedContinuationRecords>>> = [];
  /** Stories a scenario expects; a refused destination is `${reportId} -> ${sessionKey}`. */
  readonly expectedRefusals = new Map<string, string>();
  readonly failures: string[] = [];
  generation = 0;
  t0 = 0;
  shape: AnnexShape = DEFAULT_ANNEX_SHAPE;
  readonly timings: Record<string, number> = {};

  private readonly ops = new Set<Promise<unknown>>();
  private readonly gates: Gate[] = [];
  private readonly heldTurns = new Set<string>();
  private readonly relayReports = new Set<string>();
  private readonly childReports = new Map<string, Set<string>>();
  private readonly branchOwners = new Map<string, AnnexNode>();
  private readonly sessionKeys = new Set<string>();
  private parkSignal = Promise.withResolvers<void>();
  private stopDeliveryRuntime: (() => Promise<void>) | undefined;
  private readonly storePath: string;

  constructor(
    readonly stateDir: string,
    private readonly settleRootWork: (keepObserving?: boolean) => Promise<void>,
  ) {
    this.storePath = path.join(stateDir, "agents", AGENT_ID, "sessions", "sessions.json");
  }

  // ---------------------------------------------------------------------------------------------
  // Building the forest

  async build(shape: AnnexShape): Promise<void> {
    const started = realNowMs();
    this.shape = shape;
    this.installSeams();
    this.startDeliveryRuntime();
    for (let tree = 0; tree < shape.trees; tree += 1) {
      const prince: AnnexNode = {
        id: `t${tree}`,
        name: `prince ${tree}`,
        tree,
        role: "prince",
        sessionKey: princeKey(tree),
        children: [],
        routing: { kind: "requester" },
      };
      this.princes.push(prince);
      this.addNode(prince);
      this.grow(prince, 1);
    }
    // Route the princes' children: the first returns home, the second to a wing of the next tree,
    // the third shouts to every room.
    for (const prince of this.princes) {
      const [, across, alarm] = prince.children;
      const next = this.princes[(prince.tree + 1) % shape.trees]!;
      let target = next.children[0];
      while (target && target.role !== "crane") {
        target = target.children[0];
      }
      if (across && next !== prince && target) {
        across.routing = { kind: "out-of-tree", target };
      }
      if (alarm) {
        alarm.routing = { kind: "all" };
      }
    }
    await this.writePrinces();
    await this.writeRuns();
    this.timings.buildMs = realNowMs() - started;
  }

  private addNode(node: AnnexNode): void {
    this.nodes.set(node.id, node);
    this.sessionKeys.add(node.sessionKey);
  }

  private grow(parent: AnnexNode, generation: number): void {
    if (generation >= this.shape.depth) {
      return;
    }
    for (let index = 0; index < this.shape.fanOut; index += 1) {
      const id = `${parent.id}.${index}`;
      const leaf = generation === this.shape.depth - 1;
      const node: AnnexNode = {
        id,
        name: `${leaf ? "crane" : "relay"} ${id}`,
        tree: parent.tree,
        role: leaf ? "crane" : "relay",
        sessionKey: nodeKey(id),
        parent,
        children: [],
        runId: `annex-${id.replaceAll(".", "-")}`,
        routing: { kind: "requester" },
      };
      parent.children.push(node);
      this.addNode(node);
      this.elections.set(node.runId!, {
        id: node.runId!,
        kind: leaf ? "crane" : "relay",
        name: node.name,
        tree: node.tree,
        ownerSessionKey: parent.sessionKey,
        node,
        expected: { outcome: "executed" },
      });
      this.grow(node, generation + 1);
    }
  }

  private scope(sessionKey: string) {
    return { agentId: AGENT_ID, env: process.env, sessionKey };
  }

  /** Each prince's room: owned by owner A, shared, with one member, its authority recorded. */
  private async writePrinces(): Promise<void> {
    for (const prince of this.princes) {
      const scope = this.scope(prince.sessionKey);
      await accessor.upsertSessionEntryCore(scope, {
        sessionId: `${prince.id}-head-1`,
        updatedAt: Date.now(),
        createdActor: OWNER_A,
        visibility: "shared",
      });
      await addSessionMember(scope, {
        identityId: "member-a",
        addedBy: OWNER_A.id,
        addedAt: Date.now(),
      });
      await accessor.captureSessionRecipientAuthority(scope);
    }
  }

  /**
   * Every relay and crane is a continuation child admitted and paused after yield, waiting for its
   * subtree: one real registration, the rest written through the registry writer in one batch,
   * each with its recipient authority bound at election.
   */
  private async writeRuns(): Promise<void> {
    const nodes = [...this.nodes.values()].filter((node) => node.role !== "prince");
    const sessions = nodes.map((node) => ({
      sessionKey: node.sessionKey,
      entry: { sessionId: `${node.id}-head-1`, updatedAt: Date.now() } as SessionEntry,
    }));
    for (let at = 0; at < sessions.length; at += 500) {
      await accessor.applySessionEntryLifecycleMutation({
        agentId: AGENT_ID,
        storePath: this.storePath,
        upserts: sessions.slice(at, at + 500),
        skipMaintenance: true,
      });
    }
    const bindings = new Map<string, ContinuationRecipientAuthorityBinding>();
    const bindingFor = async (keys: string[]) => {
      const cacheKey = keys.join("\u0000");
      let binding = bindings.get(cacheKey);
      if (!binding) {
        binding = await captureContinuationRecipientAuthorities(keys);
        bindings.set(cacheKey, binding);
      }
      return binding;
    };
    const [first] = nodes;
    if (!first) {
      return;
    }
    const template = await this.registerTemplate(first);
    const rows = new Map<string, SubagentRunRecord>();
    for (const node of nodes) {
      const requester = node.parent!.sessionKey;
      const routing = node.routing;
      const binding: ContinuationRecipientAuthorityBinding =
        routing.kind === "all"
          ? { version: 1, selection: "pending", fanoutMode: "all" }
          : await bindingFor(
              routing.kind === "out-of-tree" ? [requester, routing.target.sessionKey] : [requester],
            );
      const row: SubagentRunRecord = {
        ...structuredClone(template),
        runId: node.runId!,
        childSessionKey: node.sessionKey,
        requesterSessionKey: requester,
        requesterDisplayKey: requester,
        task: node.name,
        label: node.name,
        continuationRecipientAuthorityBinding: binding,
      };
      delete row.continuationTargetSessionKeys;
      delete row.continuationFanoutMode;
      if (routing.kind === "out-of-tree") {
        row.continuationTargetSessionKeys = [requester, routing.target.sessionKey];
      } else if (routing.kind === "all") {
        row.continuationFanoutMode = "all";
      }
      rows.set(row.runId, row);
    }
    for (const batch of chunk([...rows.keys()], 2_000)) {
      await mutateSubagentRuns(batch, () => ({
        value: undefined,
        postimages: new Map(batch.map((runId) => [runId, rows.get(runId)!])),
      }));
    }
  }

  /** The production registration of the first child, paused after yield: the row every clone copies. */
  private async registerTemplate(node: AnnexNode): Promise<SubagentRunRecord> {
    const requester = node.parent!.sessionKey;
    await registerSubagentRun({
      runId: node.runId!,
      childSessionKey: node.sessionKey,
      childAgentId: AGENT_ID,
      sessionEntry: { sessionId: `${node.id}-head-1` },
      requesterSessionKey: requester,
      requesterAgentId: AGENT_ID,
      requesterDisplayKey: requester,
      task: node.name,
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const binding = await captureContinuationRecipientAuthorities([requester]);
    return await mutateSubagentRuns([node.runId!], (rows) => {
      const draft = structuredClone(rows.get(node.runId!)!);
      expect(markSubagentRunPausedAfterYield({ entry: draft })).toBe(true);
      draft.continuationRecipientAuthorityBinding = binding;
      return { value: draft, postimages: new Map([[node.runId!, draft]]) };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // The fire

  /**
   * Lights the annex: every clone starts folding, each prince elects its late runner and its
   * attic wake, relay 0 of each tree elects its cellar runner. All three are elected through the
   * production election paths.
   */
  async light(): Promise<void> {
    this.t0 = Date.now();
    for (const node of this.nodes.values()) {
      if (node.role === "crane") {
        this.fold(this.elections.get(node.runId!)!);
      }
    }
    for (const prince of this.princes) {
      const cellarOwner = prince.children[0];
      if (cellarOwner && cellarOwner.role === "relay") {
        await this.electBranch(
          cellarOwner,
          `the cellar runner of tree ${prince.tree}`,
          CELLAR_RUNNER_DELAY_MS,
        );
      }
      await this.electBranch(
        prince,
        `the late runner of tree ${prince.tree}`,
        LATE_RUNNER_DELAY_MS,
      );
      await this.electAttic(prince);
    }
    await this.settle();
  }

  private async electBranch(owner: AnnexNode, name: string, delayMs: number): Promise<void> {
    const record = await enqueuePendingDelegate(owner.sessionKey, {
      task: `${name}: fold one more crane on the stairs`,
      delayMs,
    });
    this.elections.set(record.recordId, {
      id: record.recordId,
      kind: "branch",
      name,
      tree: owner.tree,
      ownerSessionKey: owner.sessionKey,
      dueAt: this.t0 + delayMs,
      expected: { outcome: "executed" },
    });
    this.branchOwners.set(record.recordId, owner);
    // The electing turn's dispatch after its response: nothing is due, so it arms the hedge.
    await dispatchToolDelegates({
      sessionKey: owner.sessionKey,
      chainState: { ...CHAIN, chainStartedAt: Date.now() },
      ctx: { sessionKey: owner.sessionKey },
      maxChainLength: 8,
    });
  }

  private async electAttic(prince: AnnexNode): Promise<void> {
    const reason = `check the attic again (tree ${prince.tree})`;
    const result = await scheduleContinuationWork({
      sessionKey: prince.sessionKey,
      chainState: { ...CHAIN, chainStartedAt: Date.now() },
      request: { reason, delaySeconds: ATTIC_DELAY_MS / 1_000 },
      config: resolveContinuationRuntimeConfig(),
    });
    expect(result.scheduled, `the attic wake of tree ${prince.tree} was not elected`).toBe(true);
    const [record] = (
      await listContinuationRecords({
        ownerSessionKey: prince.sessionKey,
        kinds: ["work"],
        statuses: ["queued"],
      })
    ).filter((candidate) => candidate.stateJson.includes(reason));
    expect(record?.dueAt, `the attic wake of tree ${prince.tree} has no due time`).toBeDefined();
    this.elections.set(record!.recordId, {
      id: record!.recordId,
      kind: "attic",
      name: `the attic inspector of tree ${prince.tree}`,
      tree: prince.tree,
      ownerSessionKey: prince.sessionKey,
      dueAt: record!.dueAt,
      expected: { outcome: "executed" },
    });
  }

  /** A clone folds: attempt, one second, the bit flips, then it reports. */
  private fold(election: AnnexElection): void {
    this.logAttempt(election.id, "attempt");
    void (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, FOLD_MS));
      await this.gate(`before-flip:${election.id}`);
      this.bits.set(election.id, 1);
      this.logAttempt(election.id, "effect");
      // The replay barrier: the effect is committed, its completion is not recorded yet.
      await this.gate(`after-flip:${election.id}`);
      await this.run(() => this.report(election));
    })().catch((error: unknown) => this.failures.push(`${election.name}: ${String(error)}`));
  }

  private logAttempt(electionId: string, kind: AttemptLogLine["kind"]): void {
    this.attempts.push({ electionId, kind, at: Date.now(), generation: this.generation });
  }

  /** The child's continuation return through the production router, as the announce flow runs it. */
  private async report(election: AnnexElection): Promise<void> {
    const node = election.node;
    const runId = node?.runId ?? this.branchRunId(election.id);
    const entry = subagentRuns.get(runId);
    if (!entry) {
      throw new Error(`${election.name} has no registry row (${runId})`);
    }
    const text = `[annex:report ${election.id}] ${election.name} ${
      election.kind === "relay" ? "relays its wing" : "folded its crane"
    }`;
    const report: Report = {
      electionId: election.id,
      runId,
      name: election.name,
      text,
      at: Date.now(),
      intended: this.intendedRecipients(entry),
    };
    this.reports.set(election.id, report);
    const started = realNowMs();
    const result = await routeSubagentContinuationReturn({
      cfg: getRuntimeConfig(),
      continuationEnabled: true,
      isContinuationChainDelegate: true,
      maxChainLength: 10,
      task: election.name,
      taskLabel: election.name,
      triggerMessage: text,
      announceId: `annex:${election.id}`,
      childSessionKey: entry.childSessionKey,
      childAgentId: AGENT_ID,
      childRunId: runId,
      targetRequesterSessionKey: entry.requesterSessionKey,
      targetRequesterAgentId: AGENT_ID,
      continuationTargetSessionKey: entry.continuationTargetSessionKey,
      continuationTargetSessionKeys: entry.continuationTargetSessionKeys,
      continuationFanoutMode: entry.continuationFanoutMode,
      continuationRecipientAuthorityBinding: entry.continuationRecipientAuthorityBinding,
      persistContinuationRecipientAuthorityBinding: (binding) =>
        this.persistBinding(entry, binding),
    });
    this.time("routeMs", started);
    expect(result.handled, `${election.name}'s return was not routed`).toBe(true);
  }

  /** Accumulates wall time under `name` and counts the calls under `${name}:calls`. */
  private time(name: string, startedAt: number): void {
    this.timings[name] = (this.timings[name] ?? 0) + realNowMs() - startedAt;
    this.timings[`${name}:calls`] = (this.timings[`${name}:calls`] ?? 0) + 1;
  }

  /** The registry's completion-time selection of an `all` return (subagent-registry-announce-flow). */
  private async persistBinding(
    entry: SubagentRunRecord,
    binding: ContinuationRecipientAuthorityBinding,
  ): Promise<boolean> {
    return await mutateSubagentRuns([entry.runId], (rows) => {
      const current = rows.get(entry.runId);
      if (!current) {
        return { value: false };
      }
      return {
        value: true,
        postimages: new Map([
          [entry.runId, { ...current, continuationRecipientAuthorityBinding: binding }],
        ]),
      };
    });
  }

  private intendedRecipients(entry: SubagentRunRecord): string[] {
    if (entry.continuationFanoutMode === "all") {
      return [...this.sessionKeys].filter((key) => key !== entry.childSessionKey).toSorted();
    }
    if (entry.continuationTargetSessionKeys?.length) {
      return [...new Set(entry.continuationTargetSessionKeys)];
    }
    return [entry.requesterSessionKey];
  }

  private branchRunId(electionId: string): string {
    const spawn = this.spawns.findLast((candidate) => candidate.electionId === electionId);
    if (!spawn?.childRunId) {
      throw new Error(`branch ${electionId} never spawned`);
    }
    return spawn.childRunId;
  }

  // ---------------------------------------------------------------------------------------------
  // The edge of the Gateway

  private installSeams(): void {
    continuationForestSeams.spawn = async (params, context) => {
      const electionId = params.continuationDelegateFlowId;
      const election = electionId ? this.elections.get(electionId) : undefined;
      const owner = electionId ? this.branchOwners.get(electionId) : undefined;
      if (!election || !owner || !context.agentSessionKey) {
        throw new Error(`unexpected spawn: ${params.task}`);
      }
      try {
        context.continuationDelegateAdmission?.assertCurrent("child-session");
      } catch (error) {
        return { status: "cancelled", error: String(error) };
      }
      const childRunId = params.continuationChildRunId ?? `annex-branch-${this.spawns.length}`;
      const childId = `${owner.id}.runner-${this.spawns.length}`;
      const childSessionKey = nodeKey(childId);
      await writeChildSession(this.stateDir, childSessionKey, `${childId}-head-1`);
      this.sessionKeys.add(childSessionKey);
      const binding = await resolveSpawnRecipientAuthorityBinding({
        binding: params.continuationRecipientAuthorityBinding,
        requesterSessionKey: context.agentSessionKey,
        targetSessionKey: params.continuationTargetSessionKey,
        targetSessionKeys: params.continuationTargetSessionKeys,
        fanoutMode: params.continuationFanoutMode,
      });
      await registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        childAgentId: AGENT_ID,
        sessionEntry: { sessionId: `${childId}-head-1` },
        requesterSessionKey: context.agentSessionKey,
        requesterAgentId: AGENT_ID,
        requesterDisplayKey: context.agentSessionKey,
        task: params.task,
        cleanup: "keep",
        expectsCompletionMessage: true,
        ...buildSubagentContinuationRegistrationFields(params, {
          continuationTargetSessionKeys: params.continuationTargetSessionKeys,
          continuationRecipientAuthorityBinding: binding,
        }),
      });
      await mutateSubagentRuns([childRunId], (rows) => {
        const draft = structuredClone(rows.get(childRunId)!);
        markSubagentRunPausedAfterYield({ entry: draft });
        return { value: undefined, postimages: new Map([[childRunId, draft]]) };
      });
      this.spawns.push({ electionId: election.id, childRunId, at: Date.now() });
      this.childReportsFor(owner).add(`pending:${election.id}`);
      this.fold(election);
      return { status: "accepted", childSessionKey, runId: childRunId };
    };
    continuationForestSeams.reply = async (ctx, opts) => {
      const body = typeof ctx.Body === "string" ? ctx.Body : "";
      const flowId = /\bFlow: ([\w-]+)/.exec(body)?.[1];
      const election = flowId ? this.elections.get(flowId) : undefined;
      if (!election || election.kind !== "attic") {
        throw new Error(`unexpected reply turn for ${ctx.SessionKey}: ${body.slice(0, 120)}`);
      }
      opts?.onPreparedAgentRunStart?.({ runId: `attic-turn-${this.attempts.length}` } as never);
      this.logAttempt(election.id, "attempt");
      await this.gate(`wake:${election.id}`);
      this.bits.set(election.id, 1);
      this.logAttempt(election.id, "effect");
      await this.gate(`after-flip:${election.id}`);
      opts?.onAgentRunTerminalOutcome?.("completed");
      return { text: `${election.name} checked the attic` };
    };
    continuationForestSeams.wake = (request) => {
      this.wakes.push({
        sessionKey: request.sessionKey,
        deliveryIds: request.deliveryIds,
        generation: this.generation,
      });
    };
    continuationForestSeams.afterDeliveryRowWritten = async (payload, id) => {
      if (payload.kind === "systemEvent" && payload.continuationSourceRunId) {
        this.rows.set(`${payload.continuationSourceRunId}\u0000${payload.sessionKey}`, id);
      }
      await this.gate(`row:${payload.sessionKey}`);
    };
    continuationForestSeams.logLine = (subsystem, message) => {
      if (message.startsWith("[continuation:")) {
        this.logLines.push({ subsystem, message, at: Date.now() });
      }
    };
    vi.spyOn(defaultRuntime, "log").mockImplementation((...args: unknown[]) => {
      const match = DELIVERED_TO.exec(String(args[0]));
      if (match) {
        this.deliveredLines.push({ keys: match[1]!.split(","), at: Date.now() });
      }
    });
  }

  private startDeliveryRuntime(): void {
    // The runtime's timers run on the fake clock; each wake joins the drains it starts.
    const scheduler = new GatewayScheduler({
      clock: {
        now: () => Date.now(),
        monotonicNow: () => performance.now(),
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
   * Holds the next actor that reaches `point` (`before-flip:<election>`, `after-flip:<election>`,
   * `wake:<election>`, `row:<sessionKey>`) until released.
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
      reached: gate.reached.promise,
      release: async () => {
        gate.released.resolve();
        await this.settle();
      },
    };
  }

  private async gate(point: string): Promise<void> {
    const gate = this.gates.find((candidate) => candidate.point === point && !candidate.parked);
    if (!gate) {
      return;
    }
    gate.parked = true;
    const op = opContext.getStore();
    if (op) {
      op.parked = true;
    }
    gate.reached.resolve();
    this.parkSignal.resolve();
    await gate.released.promise;
    if (op) {
      op.parked = false;
    }
    this.gates.splice(this.gates.indexOf(gate), 1);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.ops.add(work);
    void work.finally(() => this.ops.delete(work)).catch(() => {});
    return work;
  }

  /** Runs `work` as a world operation that settle() waits for unless it parks at a barrier. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    const state = { parked: false };
    const promise = opContext.run(state, work);
    this.parked.set(promise, state);
    return this.track(promise);
  }

  private readonly parked = new WeakMap<Promise<unknown>, { parked: boolean }>();

  /** Lets everything that is not waiting on the clock or a barrier finish. */
  async settle(): Promise<void> {
    const started = realNowMs();
    try {
      await this.settleRounds();
    } finally {
      this.time("settleMs", started);
    }
  }

  private async settleRounds(): Promise<void> {
    for (let round = 0; round < 10_000; round += 1) {
      await vi.advanceTimersByTimeAsync(0);
      await this.settleRootWork(true);
      const live = [...this.ops].filter((op) => !this.parked.get(op)?.parked);
      if (live.length > 0) {
        this.parkSignal = Promise.withResolvers<void>();
        await Promise.race([Promise.allSettled(live), this.parkSignal.promise]);
        continue;
      }
      if (await this.takeTurns()) {
        continue;
      }
      if (this.reportReadyRelays()) {
        continue;
      }
      return;
    }
    throw new Error("the annex never settled");
  }

  /** Advances the clock in steps, settling the forest at every step. */
  async advance(ms: number): Promise<void> {
    if (ms % ANNEX_STEP_MS !== 0) {
      throw new Error(`advance(${ms}) is not a multiple of ${ANNEX_STEP_MS}ms`);
    }
    for (let elapsed = 0; elapsed < ms; elapsed += ANNEX_STEP_MS) {
      await vi.advanceTimersByTimeAsync(ANNEX_STEP_MS);
      await this.settle();
    }
  }

  /** Advances to `t0 + atMs`. */
  async advanceTo(atMs: number): Promise<void> {
    await this.advance(this.t0 + atMs - Date.now());
  }

  /** Until released, `sessionKey`'s head takes no turns: its queued returns wait. */
  holdTurns(sessionKey: string) {
    this.heldTurns.add(sessionKey);
    return {
      release: async () => {
        this.heldTurns.delete(sessionKey);
        await this.settle();
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Heads, turns and relays

  /** The room's current head: its session and the lifecycle revision a reset commits. */
  head(sessionKey: string): string | undefined {
    const entry = accessor.loadSessionEntry({
      storePath: this.storePath,
      sessionKey,
      readConsistency: "latest",
    });
    return entry ? `${entry.sessionId}@${entry.lifecycleRevision ?? "initial"}` : undefined;
  }

  /** Every head with queued events takes a turn. True when a turn consumed anything. */
  private async takeTurns(): Promise<boolean> {
    const queued = (sessionKey: string) =>
      peekSystemEventEntries(resolveSystemEventQueueKey(sessionKey, AGENT_ID)).length;
    const ready = [...this.sessionKeys]
      .filter((sessionKey) => !this.heldTurns.has(sessionKey))
      .map((sessionKey) => ({ sessionKey, before: queued(sessionKey) }))
      .filter(({ before }) => before > 0);
    let progressed = false;
    for (const { sessionKey, before } of ready) {
      const adopted = await this.run(() => this.nextTurn(sessionKey));
      progressed ||= adopted > 0 || queued(sessionKey) < before;
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
        const reportId = match[1]!;
        this.adoptions.push({
          reportId,
          sessionKey,
          head,
          at: Date.now(),
          generation: this.generation,
        });
        this.noteChildReport(sessionKey, reportId);
        count += 1;
      }
    }
    return count;
  }

  private childReportsFor(node: AnnexNode): Set<string> {
    let reports = this.childReports.get(node.id);
    if (!reports) {
      reports = new Set();
      this.childReports.set(node.id, reports);
    }
    return reports;
  }

  private noteChildReport(sessionKey: string, reportId: string): void {
    const election = this.elections.get(reportId);
    if (!election) {
      return;
    }
    const parent =
      election.kind === "branch" ? this.branchOwners.get(election.id) : election.node?.parent;
    if (parent?.sessionKey === sessionKey) {
      const reports = this.childReportsFor(parent);
      reports.delete(`pending:${reportId}`);
      reports.add(reportId);
    }
  }

  /** A relay reports once every child of its wing (and its runner) has reported to it. */
  private reportReadyRelays(): boolean {
    let started = false;
    for (const node of this.nodes.values()) {
      if (node.role !== "relay" || this.relayReports.has(node.id)) {
        continue;
      }
      const reports = this.childReportsFor(node);
      const waitingOnRunner = [...reports].some((report) => report.startsWith("pending:"));
      const runnerElected = [...this.branchOwners.entries()].filter(
        ([electionId, owner]) =>
          owner === node && this.elections.get(electionId)?.expected.outcome === "executed",
      );
      const runnersReported = runnerElected.every(([electionId]) => reports.has(electionId));
      if (
        waitingOnRunner ||
        !runnersReported ||
        !node.children.every((child) => reports.has(child.runId!))
      ) {
        continue;
      }
      this.relayReports.add(node.id);
      const election = this.elections.get(node.runId!)!;
      this.logAttempt(election.id, "attempt");
      this.logAttempt(election.id, "effect");
      void this.run(async () => {
        await this.gate(`report:${election.id}`);
        await this.report(election);
      }).catch((error: unknown) => this.failures.push(`${election.name}: ${String(error)}`));
      started = true;
    }
    return started;
  }

  // ---------------------------------------------------------------------------------------------
  // Trouble

  /** The prince changes 🎽🩲: a chat /new on the prince's room. */
  async changesClothes(prince: AnnexNode): Promise<void> {
    const result = await initSessionState({
      ctx: finalizeInboundContext({
        Body: "/new",
        From: `telegram:prince-${prince.tree}`,
        To: `telegram:prince-${prince.tree}`,
        ChatType: "direct",
        SessionKey: prince.sessionKey,
        Provider: "telegram",
      }),
      cfg: getRuntimeConfig(),
      commandAuthorized: true,
    });
    expect(result.resetTriggered, `${prince.name}'s /new did not reset`).toBe(true);
    expect(result.sessionKey, `${prince.name}'s /new reset another room`).toBe(prince.sessionKey);
    await this.settle();
  }

  /** A same-owner Gateway reset (`sessions.reset`) of any room. */
  async reset(node: AnnexNode, reason: "new" | "reset" = "reset"): Promise<void> {
    const result = await performGatewaySessionReset({
      key: node.sessionKey,
      agentId: AGENT_ID,
      reason,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      workerPlacementContext: {},
    });
    expect(result.ok && "entry" in result, `${node.name}'s reset did not commit`).toBe(true);
    await this.settle();
  }

  /** A real handover of the room: the row is deleted and recreated, which advances its epoch. */
  async handOver(node: AnnexNode, how: Handover["how"] = "delete and recreate"): Promise<void> {
    const scope = this.scope(node.sessionKey);
    if (how === "delete and recreate") {
      await accessor.deleteSessionEntryLifecycle({
        agentId: AGENT_ID,
        archiveTranscript: false,
        storePath: this.storePath,
        target: { canonicalKey: node.sessionKey, storeKeys: [node.sessionKey] },
      });
      await accessor.upsertSessionEntryCore(scope, {
        sessionId: `${node.id}-new-occupant`,
        updatedAt: Date.now(),
      });
    } else {
      accessor.assignSessionOwner(scope, {
        owner: OWNER_B,
        assignedBy: OWNER_A,
        assignedAt: Date.now(),
      });
    }
    this.handovers.push({ sessionKey: node.sessionKey, at: Date.now(), how });
    await this.settle();
  }

  /**
   * A Gateway restart: every in-memory queue, timer and claim of the old process is gone; the new
   * process recovers in the production boot order (server-runtime-services.ts): the delivery
   * runtime and produced-delivery recovery, then custody boot and pending reset-retention marks.
   */
  async restart(): Promise<void> {
    await this.stopDeliveryRuntime?.();
    resetSystemEventsForTest();
    resetContinuationWorkDispatchForTests();
    resetDelegateDispatchHedgesForTests();
    resetContinuationCustodyProjection();
    this.generation += 1;
    const armedAt = Date.now();
    this.startDeliveryRuntime();
    const queueContext = captureOpenClawStateWorkerContext();
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    await recoverPendingProducedSessionDeliveries({
      deps: {} as never,
      queueContext,
      log,
      maxEnqueuedAt: armedAt,
    });
    await schedulePendingSessionDeliveries();
    await runContinuationCustodyBoot({ armedAt, whenSubagentRegistryActivated: async () => {} });
    await resolveContinuationResetRetentions({ cfg: getRuntimeConfig(), markedBefore: armedAt });
    await this.settle();
  }

  /** The owner's explicit `/continuations cancel <id...>`. */
  async cancel(owner: AnnexNode, electionIds: string[]) {
    const receipt = await cancelOwnedContinuationRecords({
      ownerSessionKey: owner.sessionKey,
      recordIds: electionIds,
    });
    this.cancelReceipts.push(receipt);
    await this.settle();
    return receipt;
  }

  // ---------------------------------------------------------------------------------------------
  // Expectations and the oracle

  election(predicate: (election: AnnexElection) => boolean): AnnexElection {
    const found = [...this.elections.values()].find(predicate);
    if (!found) {
      throw new Error("no such election in the annex");
    }
    return found;
  }

  attic(tree: number): AnnexElection {
    return this.election((election) => election.kind === "attic" && election.tree === tree);
  }

  lateRunner(tree: number): AnnexElection {
    return this.election((election) => election.name === `the late runner of tree ${tree}`);
  }

  cellarRunner(tree: number): AnnexElection {
    return this.election((election) => election.name === `the cellar runner of tree ${tree}`);
  }

  node(id: string): AnnexNode {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`no node ${id} in the annex`);
    }
    return node;
  }

  /** The scenario expects this election to end without running (refused at `stage`, cancelled). */
  expectElection(election: AnnexElection, expected: ElectionExpectation): void {
    election.expected = expected;
  }

  /** The scenario expects `report`'s delivery to `sessionKey` to be refused with `reason`. */
  expectRefusedDelivery(electionId: string, sessionKey: string, reason: string): void {
    this.expectedRefusals.set(`${electionId}\u0000${sessionKey}`, reason);
  }

  private async receipt(id: string): Promise<string | undefined> {
    const context = captureDeliveryQueueStateContext(this.stateDir);
    return (await inspectDeliveryQueueReceipt("session", id, false, context)).status;
  }

  /** Every way the forest broke, told as the story. Empty when everything held. */
  async stories(): Promise<string[]> {
    await this.settle();
    const stories = [...this.failures];
    const at = (time: number) => `${time - this.t0}ms`;
    const records = new Map(
      (await listContinuationRecords({ recordIds: [...this.elections.keys()] })).map((record) => [
        record.recordId,
        record,
      ]),
    );
    for (const election of this.elections.values()) {
      const lines = this.attempts.filter((line) => line.electionId === election.id);
      const attempts = lines.filter((line) => line.kind === "attempt");
      const effects = lines.filter((line) => line.kind === "effect");
      const expected = election.expected;
      if (expected.outcome === "executed") {
        if (attempts.length !== 1) {
          stories.push(
            attempts.length === 0
              ? `${election.name} never ran`
              : `${election.name} ran ${attempts.length} times (at ${describeTimes(attempts, this.t0)})`,
          );
        }
        if (effects.length !== 1) {
          stories.push(
            `${election.name} committed its effect ${effects.length} times${
              effects.length > 0 ? ` (at ${describeTimes(effects, this.t0)})` : ""
            }${this.bits.get(election.id) === 1 && effects.length > 1 ? "; its bit still reads 1" : ""}`,
          );
        }
      } else if (expected.outcome === "interrupted") {
        if (attempts.length > 1) {
          stories.push(`${election.name} was interrupted yet ran ${attempts.length} times`);
        }
      } else if (attempts.length > 0) {
        stories.push(
          `${election.name} should have been ${expected.outcome} but ran (at ${describeTimes(attempts, this.t0)})`,
        );
      }
      const record = records.get(election.id);
      if (election.kind === "branch" && expected.outcome === "executed") {
        const spawns = this.spawns.filter((spawn) => spawn.electionId === election.id);
        if (spawns.length !== 1) {
          stories.push(`${election.name} spawned ${spawns.length} times`);
        } else if (
          election.dueAt !== undefined &&
          (spawns[0]!.at < election.dueAt || spawns[0]!.at >= election.dueAt + ANNEX_STEP_MS)
        ) {
          stories.push(
            `${election.name} spawned at ${at(spawns[0]!.at)}, not at its due time ${at(election.dueAt)}`,
          );
        }
      }
      if (election.kind === "attic") {
        if (expected.outcome === "executed" && record) {
          const releasedAt = custodyStateForTest(record).releasedAt as number | undefined;
          if (
            election.dueAt !== undefined &&
            (releasedAt === undefined ||
              releasedAt < election.dueAt ||
              releasedAt >= election.dueAt + ANNEX_STEP_MS)
          ) {
            stories.push(
              `${election.name} woke at ${releasedAt === undefined ? "no time" : at(releasedAt)}, not at its due time ${at(election.dueAt)}`,
            );
          }
          if (record.status !== "succeeded") {
            stories.push(`${election.name}'s election ended ${record.status}, not succeeded`);
          }
        }
        if (expected.outcome === "refused") {
          if (record?.status !== "failed" || record.failureReason !== expected.reason) {
            stories.push(
              `${election.name} was not refused with ${expected.reason} (status ${record?.status}, reason ${record?.failureReason})`,
            );
          }
          const line = `[continuation:work-refused] stage=${expected.stage} reason=${expected.reason} session=${election.ownerSessionKey} flowId=${election.id}`;
          if (!this.logLines.some((logged) => logged.message === line)) {
            stories.push(`${election.name} was not reported refused at its ${expected.stage}`);
          }
        }
        if (expected.outcome === "cancelled" && record?.status !== "cancelled") {
          stories.push(`${election.name} was not cancelled (status ${record?.status})`);
        }
      }
    }
    // Every report reaches the current head of each intended recipient exactly once.
    for (const report of this.reports.values()) {
      for (const sessionKey of report.intended) {
        const adopted = this.adoptions.filter(
          (adoption) =>
            adoption.reportId === report.electionId && adoption.sessionKey === sessionKey,
        );
        const refusal = this.expectedRefusals.get(`${report.electionId}\u0000${sessionKey}`);
        const rowId = this.rows.get(`${report.runId}\u0000${sessionKey}`);
        if (refusal) {
          if (adopted.length > 0) {
            stories.push(
              `${sessionKey} adopted ${report.name}'s report although it was handed over`,
            );
          }
          const refused = this.logLines.some(
            (line) =>
              line.message.startsWith("[continuation:return-refused]") &&
              line.message.includes(`reason=${refusal} session=${sessionKey}`),
          );
          if (!refused) {
            stories.push(
              `${report.name}'s report to ${sessionKey} was never refused with ${refusal}`,
            );
          }
          if (rowId && (await this.receipt(rowId)) !== "failed") {
            stories.push(`${report.name}'s refused row for ${sessionKey} is not a failed receipt`);
          }
          const handedOverAt = this.handovers.find((h) => h.sessionKey === sessionKey)?.at;
          if (
            handedOverAt !== undefined &&
            this.deliveredLines.some(
              (line) => line.at >= handedOverAt && line.keys.includes(sessionKey),
            )
          ) {
            stories.push(`"Delivered to" named ${sessionKey} after its handover`);
          }
          continue;
        }
        if (adopted.length !== 1) {
          stories.push(
            adopted.length === 0
              ? `${report.name}'s report never reached ${this.describeRoom(sessionKey)}`
              : `${this.describeRoom(sessionKey)} adopted ${report.name}'s report ${adopted.length} times (heads ${adopted.map((a) => a.head).join(", ")})`,
          );
        }
      }
      for (const adoption of this.adoptions.filter((a) => a.reportId === report.electionId)) {
        if (!report.intended.includes(adoption.sessionKey)) {
          stories.push(
            `${this.describeRoom(adoption.sessionKey)} adopted ${report.name}'s report it was never sent`,
          );
        }
      }
    }
    // A wake names each row once per process lifetime.
    const wakeCounts = new Map<string, number>();
    for (const wake of this.wakes) {
      for (const id of wake.deliveryIds) {
        const key = `${wake.generation}\u0000${id}`;
        wakeCounts.set(key, (wakeCounts.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of wakeCounts) {
      if (count > 1) {
        const [generation, id] = key.split("\u0000");
        stories.push(
          `delivery ${id} woke its recipient ${count} times in process generation ${generation}`,
        );
      }
    }
    return stories;
  }

  private describeRoom(sessionKey: string): string {
    const node = [...this.nodes.values()].find((candidate) => candidate.sessionKey === sessionKey);
    return node ? `${node.name}'s room` : sessionKey;
  }

  /** Asserts the forest held, with the story of every break as the failure message. */
  async expectForestHolds(): Promise<void> {
    const stories = await this.stories();
    expect(stories, `the annex broke:\n  ${stories.join("\n  ")}`).toEqual([]);
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    chunks.push(items.slice(at, at + size));
  }
  return chunks;
}
