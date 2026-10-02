import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  killSubagentRun,
  resolveSubagentKillTargetState,
} from "./subagent-control-kill-runtime.js";
import {
  withSubagentKillScope,
  type KillTree,
  type KillScope,
  type KillSelection,
  type KillPublicationPreparation,
} from "./subagent-control-kill-scope.js";
import {
  ensureSubagentControllerOwnsRun,
  getLatestOwnedSubagentRun,
  type ResolvedSubagentController,
} from "./subagent-control-scope.js";
import {
  persistSubagentAbortedLastRun,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import type { SubagentAdminKillParams, SubagentAdminKillResult } from "./subagent-control.types.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./subagent-control.types.js";
import {
  listSubagentRunsForController,
  listSubagentRunsForRequester,
} from "./subagent-registry-read.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

async function killLatestSubagentRun(params: {
  cfg: OpenClawConfig;
  tree: KillTree;
  scope: KillScope;
  suppressTaskDelivery?: boolean;
  beforeSessionKill?: () => boolean;
  expectedGeneration?: number;
  expectedOwnerKey?: string;
}): Promise<{
  entry: SubagentRunRecord;
  session?: SubagentKillSession;
  result: Awaited<ReturnType<typeof killSubagentRun>>;
}> {
  const { tree, scope } = params;
  for (
    let pending = scope.cancellationControl.prepareRead?.();
    pending;
    pending = scope.cancellationControl.prepareRead?.()
  ) {
    await pending;
  }
  const matchesExpected = (entry: SubagentRunRecord) =>
    (params.expectedGeneration === undefined || entry.generation === params.expectedGeneration) &&
    (!params.expectedOwnerKey || entry.requesterSessionKey === params.expectedOwnerKey);
  scope.cancellationControl.assertCurrent();
  const entry = tree.entry;
  const session = tree.session;
  if (!session) {
    return { entry, result: { killed: false } };
  }
  if (!matchesExpected(entry)) {
    return { entry, session, result: { killed: false, superseded: true } };
  }
  const result = tree.isCurrent(entry)
    ? await killSubagentRun({
        ...params,
        entry,
        session,
        stateContext: scope.stateContext,
        cancellationControl: scope.cancellationControl,
        isCurrent: (candidate, requirePreparedSession) =>
          tree.isCurrent(candidate, requirePreparedSession) && matchesExpected(candidate),
        withdrawQueuedReservation: () => tree.dispatchHold?.withdraw(),
        refreshDescendants: scope.refresh,
      })
    : { killed: false, superseded: true };
  // A committed retirement ends mutation/discovery of this ancestor, but not
  // cancellation of its captured descendants. Refusals on a live row stay fenced.
  if (result.superseded && !tree.isCurrent(entry) && tree.canTraverse() && matchesExpected(entry)) {
    return {
      entry,
      session,
      result: { killed: false, targetState: resolveSubagentKillTargetState(entry) },
    };
  }
  return { entry, session, result };
}

function collectKillErrors(trees: KillTree[], unlabeledRoot?: KillTree) {
  let failed = 0;
  const errors: string[] = [];
  const collect = (tree: KillTree) => {
    if (tree.errors.size > 0) {
      failed += 1;
      for (const error of tree.errors) {
        errors.push(
          tree === unlabeledRoot ? error : `${resolveSubagentLabel(tree.entry)}: ${error}`,
        );
      }
    }
    tree.children.forEach(collect);
  };
  // No authority checks or I/O here: a later sibling can fault an already-visited node.
  // Failures count stable selected nodes, independent of later replacements and killed counts.
  trees.forEach(collect);
  return { errors, failed };
}

type KillTraversal = {
  cfg: OpenClawConfig;
  scope: KillScope;
  suppressTaskDelivery?: boolean;
};

async function visitAll(work: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

async function killSubagentRunTree(
  params: KillTraversal & { trees: KillTree[]; suppressCompletedWakes?: boolean },
): Promise<{ killed: number; labels: string[] }> {
  const visits = new Map<
    KillTree,
    { label?: string; descendants: boolean; suppressCompletedWakes: boolean }
  >();
  const visit = async (tree: KillTree, suppressCompletedWakes: boolean): Promise<void> => {
    let result = visits.get(tree);
    try {
      if (!result) {
        result = { descendants: false, suppressCompletedWakes };
        visits.set(tree, result);
        if (
          !tree.entry.execution.endedAt ||
          tree.entry.pauseReason === "sessions_yield" ||
          (params.suppressTaskDelivery && suppressCompletedWakes && tree.entry.requesterSettleWake)
        ) {
          const stopped = await killLatestSubagentRun({ ...params, tree });
          if (stopped.result.error) {
            tree.errors.add(stopped.result.error);
          }
          if (stopped.result.error || stopped.result.declined) {
            // A parent's failed Stop cannot retire the completion it still owns.
            // Keep trying live descendants under the existing best-effort policy.
            result.suppressCompletedWakes = false;
          }
          if (stopped.result.killed) {
            result.label = resolveSubagentLabel(stopped.entry);
          }
          if (stopped.result.superseded) {
            return;
          }
        }
        result.descendants = true;
      }
      if (result.descendants && tree.canTraverse()) {
        const suppressDescendantWakes = result.suppressCompletedWakes;
        await visitAll(tree.children.map((child) => visit(child, suppressDescendantWakes)));
      }
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      tree.errors.add(formatErrorMessage(error));
      if (result) {
        result.descendants = false;
      }
    }
  };
  let selected: number;
  do {
    selected = await params.scope.refresh();
    // First visits interrupt siblings together; descendants still wait for their parent.
    await visitAll(
      params.trees.map((tree) => visit(tree, params.suppressCompletedWakes !== false)),
    );
    // A sibling's drain can capture children beneath an already visited branch.
    // Complete that frontier before releasing holds, without stopping a session twice.
  } while ((await params.scope.refresh()) !== selected);
  const collectLabels = (trees: KillTree[]): string[] =>
    trees.flatMap((tree) => {
      const label = visits.get(tree)?.label;
      return [...(label === undefined ? [] : [label]), ...collectLabels(tree.children)];
    });
  const labels = collectLabels(params.trees);
  return { killed: labels.length, labels };
}

async function killSubagentRoot(params: Parameters<typeof killLatestSubagentRun>[0]) {
  let stopped: Awaited<ReturnType<typeof killLatestSubagentRun>> = {
    entry: params.tree.entry,
    result: { killed: false },
  };
  let cascade: Awaited<ReturnType<typeof killSubagentRunTree>> = { killed: 0, labels: [] };
  try {
    // Explicit root cancellation also reconciles terminal execution state.
    stopped = await killLatestSubagentRun(params);
    if (stopped.result.error) {
      params.tree.errors.add(stopped.result.error);
    }
    if (!stopped.result.superseded && !stopped.result.declined && params.tree.canTraverse()) {
      // Exact admin constraints belong only to its selected root, not each descendant.
      cascade = await killSubagentRunTree({
        cfg: params.cfg,
        suppressTaskDelivery: params.suppressTaskDelivery,
        suppressCompletedWakes: !stopped.result.error,
        scope: params.scope,
        trees: params.tree.children,
      });
    }
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    params.tree.errors.add(formatErrorMessage(error));
  }
  return { ...stopped, cascade };
}

/** Kills every currently controlled child run and its descendants. */
export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
  assertCurrent?: () => void;
  suppressTaskDelivery?: boolean;
  /** False declines traversal; the scope still releases every reservation hold. */
  beforeKill?: () => boolean | Promise<boolean>;
}) {
  if (params.controller.controlScope !== "children") {
    await params.beforeKill?.();
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  return killSelectedSubagentRuns(params);
}

/** Lifecycle cleanup owns both the completion requester and its separately scoped controller. */
export async function killSessionSubagentRuns(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => void;
}) {
  const controller = { controllerSessionKey: params.sessionKey, controllerAgentId: params.agentId };
  return killSelectedSubagentRuns({
    cfg: params.cfg,
    assertCurrent: params.assertCurrent,
    runs: [
      ...listSubagentRunsForRequester(params.sessionKey, { requesterAgentId: params.agentId }),
      ...listSubagentRunsForController(params.sessionKey, params.agentId),
    ],
    // Ordinary controller mutations retain their narrower authority. Only an admitted
    // lifecycle boundary can retire work whose completion belongs to this session.
    ownsRoot: (entry) =>
      !ensureSubagentControllerOwnsRun({ cfg: params.cfg, controller, entry }) ||
      (entry.requesterSessionKey === params.sessionKey &&
        resolveSubagentRequesterAgentId(params.cfg, entry) === params.agentId),
    suppressTaskDelivery: true,
  });
}

async function killSelectedSubagentRuns(
  params: KillSelection & {
    suppressTaskDelivery?: boolean;
    beforeKill?: () => boolean | Promise<boolean>;
  },
) {
  const result = await withSubagentKillScope(params, async (scope, trees) => {
    const accepted = params.beforeKill ? await params.beforeKill() : true;
    if (accepted) {
      await scope.refresh();
    }
    const acceptedTrees = accepted ? trees : [];
    // The bulk signal was consumed above; never forward caller hooks into child kills.
    const stopped = await killSubagentRunTree({
      cfg: params.cfg,
      suppressTaskDelivery: params.suppressTaskDelivery,
      trees: acceptedTrees,
      scope,
    });
    return { ...stopped, ...collectKillErrors(acceptedTrees) };
  });
  if (result.errors.length > 0) {
    return {
      status: "error" as const,
      error: result.errors.join("; "),
      failed: result.failed,
      killed: result.killed,
      labels: result.labels,
    };
  }
  return { status: "ok" as const, killed: result.killed, labels: result.labels };
}

/** Admin kill path for a subagent session key, bypassing caller ownership checks. */
export async function killSubagentRunAdmin(
  params: SubagentAdminKillParams,
  control?: {
    assertCurrent: () => void;
    prepareRead?: () => Promise<void> | undefined;
    beforeSessionKill?: () => boolean;
    preparePublication?: KillPublicationPreparation;
  },
): Promise<SubagentAdminKillResult> {
  const publish = (result: SubagentAdminKillResult): SubagentAdminKillResult => {
    if (params.onResult?.(result) !== undefined) {
      throw new TypeError("Subagent cancellation publication must be synchronous.");
    }
    return result;
  };
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return publish({ found: false as const, killed: false as const });
  }
  const entry = getLatestOwnedSubagentRun(targetSessionKey, params.agentId, params.cfg);
  if (!entry) {
    return publish({ found: false as const, killed: false as const });
  }
  const expectedRunId = params.expectedRunId?.trim();
  const expectedTaskRunId = params.expectedTaskRunId?.trim();
  if (
    (expectedRunId && entry.runId !== expectedRunId) ||
    (expectedTaskRunId && (entry.taskRunId ?? entry.runId) !== expectedTaskRunId)
  ) {
    return publish({ found: false as const, killed: false as const });
  }
  if (
    (params.expectedGeneration !== undefined && entry.generation !== params.expectedGeneration) ||
    (params.expectedOwnerKey?.trim() &&
      entry.requesterSessionKey !== params.expectedOwnerKey.trim())
  ) {
    return publish({ found: false as const, killed: false as const });
  }

  let rootStopSuperseded = false;
  return withSubagentKillScope<SubagentAdminKillResult>(
    {
      cfg: params.cfg,
      runs: [entry],
      assertCurrent: control?.assertCurrent,
      prepareRead: control?.prepareRead,
    },
    async (scope, [tree]) => {
      if (!tree) {
        return { found: false as const, killed: false as const };
      }
      const stopped = await killSubagentRoot({
        cfg: params.cfg,
        tree,
        scope,
        beforeSessionKill: control?.beforeSessionKill,
        expectedGeneration: params.expectedGeneration,
        expectedOwnerKey: params.expectedOwnerKey?.trim() || undefined,
      });
      const { result: stopResult, cascade } = stopped;
      rootStopSuperseded = stopResult.superseded === true;
      // Descendant cleanup can yield long enough for the target run to finish.
      // Return the freshest registry state so task cancellation cannot make a stale kill sticky.
      const targetState = resolveSubagentKillTargetState(stopped.entry) ?? stopResult.targetState;
      const killedTarget =
        targetState?.state === "terminal" &&
        targetState.task.status === "cancelled" &&
        targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
      const stopResultAlreadyClearedAbort =
        stopResult.targetState !== undefined &&
        !(
          stopResult.targetState.state === "terminal" &&
          stopResult.targetState.task.status === "cancelled" &&
          stopResult.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
        );
      const resolved = stopped.session;
      if (targetState && !killedTarget && !stopResultAlreadyClearedAbort && resolved) {
        await persistSubagentAbortedLastRun({
          childSessionKey: targetSessionKey,
          storePath: resolved.storePath,
          hasSessionEntry: resolved.entry !== undefined,
          expectedSessionId: resolved.entry?.sessionId,
          expectedLifecycleRevision: resolved.entry?.lifecycleRevision,
          abortedLastRun: false,
          isCurrent: () => tree.isCurrent(stopped.entry),
        });
      }

      return {
        found: true as const,
        killed: stopResult.killed || cascade.killed > 0,
        runId: stopped.entry.runId,
        sessionKey: stopped.entry.childSessionKey,
        cascadeKilled: cascade.killed,
        cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
      };
    },
    (result, [tree]) => {
      if (!result.found || !tree) {
        return publish(result);
      }
      // Completion can commit during the awaited handoff. Fence both the retained
      // run and its session incarnation before any synchronous result publication.
      const ownsOutcome = !rootStopSuperseded && tree.ownsRun() && tree.canTraverse();
      if (!ownsOutcome) {
        tree.errors.add("Subagent ownership changed during cancellation; retry.");
      }
      const targetState = ownsOutcome ? resolveSubagentKillTargetState(tree.entry) : undefined;
      const { errors } = collectKillErrors([tree], tree);
      return publish({
        ...result,
        ...(targetState ? { targetState } : {}),
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      });
    },
    control?.preparePublication,
  );
}
