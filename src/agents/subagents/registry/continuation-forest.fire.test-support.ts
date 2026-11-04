// Continuation (karmaterminal/openclaw#1271): the fire in the burning annex. Clones fold cranes
// in the world outside the Gateway and report through the production return router; the doubles
// at the Gateway's edge admit runners through the real registry and run the attic wake's turn, or,
// in a room whose turns run the real reply owner, stand in for its provider.
import { resolveSpawnRecipientAuthorityBinding } from "../../../auto-reply/continuation/recipient-authority-binding.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply/get-reply.js";
import { getRuntimeConfig } from "../../../config/config.js";
import type { ContinuationRecipientAuthorityBinding } from "../../../config/sessions/session-recipient-authority-types.js";
import type { EmbeddedAgentRunResult, runEmbeddedAgent } from "../../embedded-agent.js";
import { routeSubagentContinuationReturn } from "../../subagent-announce.continuation-return.js";
import { buildSubagentContinuationRegistrationFields } from "../spawn/subagent-spawn-continuation.js";
import type { spawnSubagentDirect } from "../spawn/subagent-spawn.js";
import {
  AGENT_ID,
  type AnnexElection,
  FOLD_MS,
  nodeKey,
  realNowMs,
  reportText,
  USER_TAG,
} from "./continuation-forest.model.test-support.js";
import type { ContinuationForest } from "./continuation-forest.test-support.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeChildSession } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** A clone folds: attempt, one second, the bit flips, then it reports. */
export function foldCrane(forest: ContinuationForest, election: AnnexElection): void {
  forest.logAttempt(election.id, "attempt");
  void (async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, FOLD_MS);
    });
    await forest.gate(`before-flip:${election.id}`);
    forest.bits.set(election.id, 1);
    forest.logAttempt(election.id, "effect");
    // The replay barrier: the effect is committed, its completion is not recorded yet.
    await forest.gate(`after-flip:${election.id}`);
    if (!forest.disposed) {
      await forest.run(() => reportElection(forest, election));
    }
  })().catch((error: unknown) => forest.failures.push(`${election.name}: ${String(error)}`));
}

/** The child's continuation return through the production router, as the announce flow runs it. */
export async function reportElection(
  forest: ContinuationForest,
  election: AnnexElection,
): Promise<void> {
  const runId = forest.runIdOf(election);
  const entry = subagentRuns.get(runId);
  // A child the Gateway stopped never completes: its report is never made.
  if (!entry || entry.killIntent || entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    forest.stopped.set(election.id, entry ? "its run was killed" : "its registry row is gone");
    return;
  }
  const text = reportText(election);
  forest.reports.set(election.id, {
    electionId: election.id,
    runId,
    name: election.name,
    at: Date.now(),
    intended: intendedRecipients(forest, election),
    boundSeq: entry.continuationFanoutMode === "all" ? ++forest.seq : 0,
  });
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
    persistContinuationRecipientAuthorityBinding: (binding) => persistBinding(entry, binding),
  });
  forest.time("routeMs", started);
  if (!result.handled) {
    throw new Error(`${election.name}'s return was not routed`);
  }
  if (forest.childrenSettleOnReport) {
    await settleRun(runId);
  }
}

/** The child's run goes home: its completion is delivered, as the announce flow records it. */
export async function settleRun(runId: string): Promise<void> {
  await mutateSubagentRuns([runId], (rows) => {
    const draft = structuredClone(rows.get(runId)!);
    delete draft.pauseReason;
    draft.delivery = { status: "delivered", announcedAt: Date.now() };
    return { value: undefined, postimages: new Map([[runId, draft]]) };
  });
}

/** The registry's completion-time selection of an `all` return (subagent-registry-announce-flow). */
async function persistBinding(
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

/**
 * The rooms a report is meant for, from the world's own model, never from the product's rows: a
 * runner reports to the room that elected it; a node to its parent, plus its target across, or to
 * every room but its own (`all`).
 */
function intendedRecipients(forest: ContinuationForest, election: AnnexElection): string[] {
  if (election.owner) {
    return [election.owner.sessionKey];
  }
  const node = election.node!;
  const parent = node.parent!.sessionKey;
  if (node.routing.kind === "all") {
    return [...forest.rooms].filter((key) => key !== node.sessionKey).toSorted();
  }
  return node.routing.kind === "out-of-tree" ? [parent, node.routing.target.sessionKey] : [parent];
}

/**
 * The spawn owner's double: admits the runner through the real registry with the registration
 * fields production builds from the spawn request, then the runner folds its crane.
 */
export async function admitRunner(
  forest: ContinuationForest,
  params: Parameters<typeof spawnSubagentDirect>[0],
  context: Parameters<typeof spawnSubagentDirect>[1],
): ReturnType<typeof spawnSubagentDirect> {
  const electionId = params.continuationDelegateFlowId;
  const election = electionId ? forest.elections.get(electionId) : undefined;
  const owner = election?.owner;
  if (!election || !owner || !context.agentSessionKey) {
    throw new Error(`unexpected spawn: ${params.task}`);
  }
  try {
    context.continuationDelegateAdmission?.assertCurrent("child-session");
  } catch (error) {
    return { status: "cancelled", error: String(error) };
  }
  const childRunId = params.continuationChildRunId ?? `annex-runner-${forest.spawns.length}`;
  const childId = `${owner.id}.runner-${forest.spawns.length}`;
  const childSessionKey = nodeKey(childId);
  await writeChildSession(forest.stateDir, childSessionKey, `${childId}-head-1`);
  forest.addRoom(childSessionKey);
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
  forest.spawns.push({ electionId: election.id, childRunId, at: Date.now() });
  forest.childReportsFor(owner).add(`pending:${election.id}`);
  foldCrane(forest, election);
  return { status: "accepted", context: "isolated", childSessionKey, runId: childRunId };
}

/** The attic election a continue_work wake's text names, if any. */
function atticOf(forest: ContinuationForest, text: string): AnnexElection | undefined {
  const flowId = /\bFlow: ([\w-]+)/.exec(text)?.[1];
  const election = flowId ? forest.elections.get(flowId) : undefined;
  return election?.kind === "attic" ? election : undefined;
}

/** The inspector checks the attic: the attempt, then the effect. */
function inspectAttic(forest: ContinuationForest, election: AnnexElection): void {
  forest.logAttempt(election.id, "attempt");
  forest.bits.set(election.id, 1);
  forest.logAttempt(election.id, "effect");
}

/** The reply owner's double: a continue_work wake turn, in which the inspector checks the attic. */
export async function checkAttic(
  forest: ContinuationForest,
  ...[ctx, opts]: Parameters<typeof getReplyFromConfig>
): ReturnType<typeof getReplyFromConfig> {
  const body = typeof ctx.Body === "string" ? ctx.Body : "";
  const election = atticOf(forest, body);
  if (!election) {
    throw new Error(`unexpected reply turn for ${ctx.SessionKey}: ${body.slice(0, 120)}`);
  }
  opts?.onPreparedAgentRunStart?.({
    runId: `attic-turn-${forest.attempts.length}`,
    transcriptStart: null,
  });
  inspectAttic(forest, election);
  opts?.onAgentRunTerminalOutcome?.("completed");
  return { text: `${election.name} checked the attic` };
}

/**
 * The provider behind a room's real reply owner: a wake's turn checks the attic; a user's turn
 * (`[annex:user <who>]`) takes its time at the barrier `turn:<who>`.
 */
export async function provideTurn(
  forest: ContinuationForest,
  params: Parameters<typeof runEmbeddedAgent>[0],
): Promise<EmbeddedAgentRunResult> {
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
  const election = atticOf(forest, params.prompt);
  const who = election?.name ?? USER_TAG.exec(params.prompt)?.[1];
  if (!who) {
    throw new Error(`unexpected provider turn: ${params.prompt.slice(0, 120)}`);
  }
  forest.providerTurns.push({ sessionKey: params.sessionKey ?? "", who, at: Date.now() });
  if (election) {
    inspectAttic(forest, election);
  } else {
    await forest.gate(`turn:${who}`);
  }
  return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
}
