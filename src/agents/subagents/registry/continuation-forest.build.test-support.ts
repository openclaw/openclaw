// Continuation (karmaterminal/openclaw#1271): building the burning annex. Princes are owned,
// shared rooms with a recorded recipient authority; relays and cranes are continuation children
// admitted and paused after yield; runners and attic wakes are elected through production paths.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { resolveContinuationRuntimeConfig } from "../../../auto-reply/continuation/config.js";
import { listContinuationRecords } from "../../../auto-reply/continuation/custody/custody-store.js";
import { dispatchToolDelegates } from "../../../auto-reply/continuation/delegate-dispatch.js";
import { enqueuePendingDelegate } from "../../../auto-reply/continuation/delegate-store.js";
import { captureContinuationRecipientAuthorities } from "../../../auto-reply/continuation/recipient-authority-binding.js";
import { scheduleContinuationWork } from "../../../auto-reply/continuation/work-dispatch.js";
import {
  applySessionEntryLifecycleMutation,
  captureSessionRecipientAuthority,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { ContinuationRecipientAuthorityBinding } from "../../../config/sessions/session-recipient-authority-types.js";
import { addSessionMember } from "../../../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { foldCrane } from "./continuation-forest.fire.test-support.js";
import {
  AGENT_ID,
  type AnnexNode,
  type AnnexShape,
  ATTIC_DELAY_MS,
  CELLAR_RUNNER_DELAY_MS,
  LATE_RUNNER_DELAY_MS,
  nodeKey,
  nodeRunId,
  OWNER_A,
  princeKey,
} from "./continuation-forest.model.test-support.js";
import type { ContinuationForest } from "./continuation-forest.test-support.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { registerSubagentRun } from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const CHAIN = { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 };
const SESSION_BATCH = 500;
const RUN_BATCH = 2_000;

export function sessionScope(sessionKey: string) {
  return { agentId: AGENT_ID, env: process.env, sessionKey };
}

/**
 * The forest: `shape.trees` princes, each with `shape.depth - 1` generations of `shape.fanOut`
 * children. Each prince's first child returns home, the second reports to the first crane of the
 * next tree as well (across), the third shouts to every room (`all`).
 */
export async function buildForest(forest: ContinuationForest, shape: AnnexShape): Promise<void> {
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
    forest.princes.push(prince);
    addNode(forest, prince);
    grow(forest, prince, 1);
  }
  for (const prince of forest.princes) {
    const [, across, alarm] = prince.children;
    const next = forest.princes[(prince.tree + 1) % shape.trees]!;
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
  await writePrinces(forest);
  await writeRuns(forest);
}

function addNode(forest: ContinuationForest, node: AnnexNode): void {
  forest.nodes.set(node.id, node);
  forest.addRoom(node.sessionKey);
}

function grow(forest: ContinuationForest, parent: AnnexNode, generation: number): void {
  if (generation >= forest.shape.depth) {
    return;
  }
  for (let index = 0; index < forest.shape.fanOut; index += 1) {
    const id = `${parent.id}.${index}`;
    const leaf = generation === forest.shape.depth - 1;
    const node: AnnexNode = {
      id,
      name: `${leaf ? "crane" : "relay"} ${id}`,
      tree: parent.tree,
      role: leaf ? "crane" : "relay",
      sessionKey: nodeKey(id),
      parent,
      children: [],
      runId: nodeRunId(id),
      routing: { kind: "requester" },
    };
    parent.children.push(node);
    addNode(forest, node);
    forest.elections.set(node.runId!, {
      id: node.runId!,
      kind: leaf ? "crane" : "relay",
      name: node.name,
      tree: node.tree,
      ownerSessionKey: parent.sessionKey,
      node,
      expected: { outcome: "executed" },
    });
    grow(forest, node, generation + 1);
  }
}

/** Each prince's room: owned by owner A, shared, with one member, its authority recorded. */
async function writePrinces(forest: ContinuationForest): Promise<void> {
  for (const prince of forest.princes) {
    const scope = sessionScope(prince.sessionKey);
    await upsertSessionEntryCore(scope, {
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
    await captureSessionRecipientAuthority(scope);
  }
}

/**
 * Every relay and crane is a continuation child admitted and paused after yield, waiting for its
 * subtree: one production registration, the rest written through the registry writer in batches,
 * each with its recipient authority bound at election.
 */
async function writeRuns(forest: ContinuationForest): Promise<void> {
  const nodes = [...forest.nodes.values()].filter((node) => node.role !== "prince");
  const [first] = nodes;
  if (!first) {
    return;
  }
  for (let at = 0; at < nodes.length; at += SESSION_BATCH) {
    await applySessionEntryLifecycleMutation({
      agentId: AGENT_ID,
      storePath: forest.storePath,
      upserts: nodes.slice(at, at + SESSION_BATCH).map((node) => ({
        sessionKey: node.sessionKey,
        entry: { sessionId: `${node.id}-head-1`, updatedAt: Date.now() } as SessionEntry,
      })),
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
  const template = await registerTemplate(first);
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
    // Every identity the registration minted is the clone's own: run, child session, controller.
    const row: SubagentRunRecord = {
      ...structuredClone(template),
      runId: node.runId!,
      taskRunId: node.runId!,
      childSessionKey: node.sessionKey,
      childSessionIdentity: { sessionId: `${node.id}-head-1` },
      controllerSessionKey: requester,
      requesterSessionKey: requester,
      requesterDisplayKey: requester,
      task: node.name,
      label: node.name,
      execution: { ...template.execution, lifecycleGeneration: randomUUID() },
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
  const runIds = [...rows.keys()];
  for (let at = 0; at < runIds.length; at += RUN_BATCH) {
    const batch = runIds.slice(at, at + RUN_BATCH);
    await mutateSubagentRuns(batch, () => ({
      value: undefined,
      postimages: new Map(batch.map((runId) => [runId, rows.get(runId)!])),
    }));
  }
}

/** The production registration of the first child, paused after yield: the row every clone copies. */
async function registerTemplate(node: AnnexNode): Promise<SubagentRunRecord> {
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

/**
 * Lights the annex: every clone starts folding; each prince elects its late runner and its attic
 * wake, relay 0 of each tree its cellar runner, through the production election paths.
 */
export async function lightAnnex(forest: ContinuationForest): Promise<void> {
  forest.t0 = Date.now();
  for (const node of forest.nodes.values()) {
    if (node.role === "crane") {
      foldCrane(forest, forest.electionOf(node));
    }
  }
  for (const prince of forest.princes) {
    const cellarOwner = prince.children[0];
    if (cellarOwner?.role === "relay") {
      await electRunner(
        forest,
        cellarOwner,
        `the cellar runner of tree ${prince.tree}`,
        CELLAR_RUNNER_DELAY_MS,
      );
    }
    await electRunner(
      forest,
      prince,
      `the late runner of tree ${prince.tree}`,
      LATE_RUNNER_DELAY_MS,
    );
    await electAttic(forest, prince);
  }
}

/** A continue_delegate with a delay, enqueued and dispatched as its electing turn would. */
async function electRunner(
  forest: ContinuationForest,
  owner: AnnexNode,
  name: string,
  delayMs: number,
): Promise<void> {
  const record = await enqueuePendingDelegate(owner.sessionKey, {
    task: `${name}: fold one more crane on the stairs`,
    delayMs,
  });
  const election = {
    id: record.recordId,
    kind: "branch" as const,
    name,
    tree: owner.tree,
    ownerSessionKey: owner.sessionKey,
    owner,
    dueAt: forest.t0 + delayMs,
    expected: { outcome: "executed" as const },
  };
  forest.elections.set(election.id, election);
  forest.runners.set(owner.id, [...(forest.runners.get(owner.id) ?? []), election]);
  // The electing turn's dispatch after its response: nothing is due, so it arms the hedge.
  await dispatchToolDelegates({
    sessionKey: owner.sessionKey,
    chainState: { ...CHAIN, chainStartedAt: Date.now() },
    ctx: { sessionKey: owner.sessionKey },
    maxChainLength: 8,
  });
}

/** The prince's continue_work: check the attic again, after the minimum delay. */
async function electAttic(forest: ContinuationForest, prince: AnnexNode): Promise<void> {
  const reason = `check the attic again (tree ${prince.tree})`;
  const result = await scheduleContinuationWork({
    sessionKey: prince.sessionKey,
    chainState: { ...CHAIN, chainStartedAt: Date.now() },
    request: { reason, delaySeconds: ATTIC_DELAY_MS / 1_000 },
    config: resolveContinuationRuntimeConfig(),
  });
  expect(result.scheduled, `the attic wake of tree ${prince.tree} was not elected`).toBe(true);
  const record = (
    await listContinuationRecords({
      ownerSessionKey: prince.sessionKey,
      kinds: ["work"],
      statuses: ["queued"],
    })
  ).find((candidate) => candidate.stateJson.includes(reason));
  expect(record?.dueAt, `the attic wake of tree ${prince.tree} has no due time`).toBeDefined();
  forest.elections.set(record!.recordId, {
    id: record!.recordId,
    kind: "attic",
    name: `the attic inspector of tree ${prince.tree}`,
    tree: prince.tree,
    ownerSessionKey: prince.sessionKey,
    dueAt: record!.dueAt,
    expected: { outcome: "executed" },
  });
}
