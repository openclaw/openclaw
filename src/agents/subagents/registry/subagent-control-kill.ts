import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isCurrentChatAbortExecution } from "../../../gateway/chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../../../gateway/chat-abort.types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { captureSubagentCommands } from "./subagent-control-commands.js";
import { mutateSubagentRunForKill } from "./subagent-control-kill-runtime.js";
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
  type captureExecRequestSubagentSelection,
} from "./subagent-control-scope.js";
import {
  persistSubagentAbortedLastRun,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import type {
  ResolvedSubagentController,
  SubagentAdminKillParams,
  SubagentAdminKillResult,
} from "./subagent-control.types.js";
import { resolveSubagentKillTargetState } from "./subagent-registry-completion.js";
import {
  captureSubagentExecution,
  getSubagentExecutionCleanup,
} from "./subagent-registry-execution-cleanup.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import { listRunsForControllerFromRuns } from "./subagent-registry-queries.js";
import { listSubagentRunsForRequester } from "./subagent-registry-read.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

async function killSubagentRun(
  params: Parameters<typeof mutateSubagentRunForKill>[0],
): ReturnType<typeof mutateSubagentRunForKill> {
  let captured = captureSubagentExecution(params);
  let retiredCleanup = captured
    ? undefined
    : getSubagentExecutionCleanup(params.entry, params.session.entry);
  const stopAcceptance = { accepted: false };
  let result: Awaited<ReturnType<typeof mutateSubagentRunForKill>> = {
    killed: false,
    targetState: resolveSubagentKillTargetState(params.entry),
  };
  let settlementFailure:
    | { error: unknown; settlement: NonNullable<ChatAbortControllerEntry["executionSettlement"]> }
    | undefined;
  try {
    result = await mutateSubagentRunForKill(
      params,
      () => {
        captured ??= captureSubagentExecution(params);
        return captured;
      },
      stopAcceptance,
    );
  } finally {
    // Disposal may mutate the session. Join outside the exclusive mutation while
    // the caller still owns this execution's retirement and scheduler holds.
    const execution = captured?.execution;
    retiredCleanup ??= captured
      ? undefined
      : getSubagentExecutionCleanup(params.entry, params.session.entry);
    const settlement = execution?.executionSettlement ?? retiredCleanup?.settlement;
    if (
      settlement &&
      !(execution ? isCurrentChatAbortExecution(execution) : retiredCleanup?.isSelf()) &&
      (result.killed ||
        result.targetState ||
        stopAcceptance.accepted ||
        settlement.status === "rejected" ||
        (!result.declined &&
          (retiredCleanup ||
            execution?.controller.signal.aborted ||
            execution?.registrationCleanupRequested)))
    ) {
      try {
        await settlement.completion;
      } catch (error) {
        settlementFailure = { error, settlement };
      }
    }
  }
  if (!stopAcceptance.accepted) {
    params.cancellationControl.assertCurrent();
  }
  if (captured) {
    const entry = getCurrentSubagentRunOwner(subagentRuns, params.entry) ?? captured.entry;
    const resolver = getGatewayContextResolver(entry);
    const cleanup =
      resolver === undefined ? getSubagentExecutionCleanup(entry, params.session.entry) : undefined;
    const releasedToSelfCleanup =
      cleanup !== undefined &&
      cleanup.settlement === captured.execution.executionSettlement &&
      cleanup.isCurrent() &&
      cleanup.isSelf();
    if (releasedToSelfCleanup) {
      params.session.assertCurrent();
    }
    const releasedBinding =
      resolver === undefined &&
      (captured.execution.executionSettlement?.cleanupSettled === true || releasedToSelfCleanup);
    if (
      entry.runId !== captured.runId ||
      (resolver !== captured.resolver && !releasedBinding) ||
      captured.resolver?.() !== captured.context ||
      (captured.context.chatAbortControllers.has(captured.runId) &&
        captured.context.chatAbortControllers.get(captured.runId) !== captured.execution)
    ) {
      throw new Error("Subagent execution owner changed during cancellation");
    }
  } else if (retiredCleanup) {
    params.session.assertCurrent();
    if (
      !retiredCleanup.isCurrent() ||
      (!retiredCleanup.isSelf() && !retiredCleanup.settlement.cleanupSettled)
    ) {
      throw new Error("Subagent execution owner changed during cancellation");
    }
  }
  if (settlementFailure) {
    const message = `Subagent execution settlement failed: ${formatErrorMessage(settlementFailure.error)}`;
    const { settlement } = settlementFailure;
    if (
      (captured?.execution.executionSettlement ?? retiredCleanup?.settlement) === settlement &&
      settlement.status === "rejected" &&
      settlement.cleanupSettled
    ) {
      result = { ...result, completedCleanupError: message };
    } else {
      result = { ...result, error: [result.error, message].filter(Boolean).join(" ") };
    }
  }
  return result;
}

async function killLatestSubagentRun(params: {
  tree: KillTree;
  scope: KillScope;
  suppressTaskDelivery?: boolean;
  beforeSessionKill?: () => boolean | Promise<boolean>;
  expectedGeneration?: number;
  expectedOwnerKey?: string;
  commands?: ReturnType<typeof captureSubagentCommands>;
  onKilled?: (entry: SubagentRunRecord) => void;
  onContinuationRetired?: () => void;
}): Promise<{
  entry: SubagentRunRecord;
  session?: SubagentKillSession;
  result: Awaited<ReturnType<typeof killSubagentRun>>;
}> {
  const { tree, scope } = params;
  const cancellationControl = {
    assertCurrent: scope.cancellationControl.assertCurrent,
    prepareRead: () => {
      const pending = [scope.cancellationControl.prepareRead?.(), tree.prepareRead()].filter(
        (publication) => publication !== undefined,
      );
      return pending.length > 0 ? Promise.all(pending).then(() => {}) : undefined;
    },
  };
  for (
    let pending = cancellationControl.prepareRead();
    pending;
    pending = cancellationControl.prepareRead()
  ) {
    await pending;
    cancellationControl.assertCurrent();
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
  const commands = params.commands;
  let result: Awaited<ReturnType<typeof killSubagentRun>> = tree.isCurrent(entry)
    ? await killSubagentRun({
        ...params,
        entry,
        session,
        stateContext: scope.stateContext,
        cancellationControl,
        isCurrent: (candidate, requirePreparedSession) =>
          tree.isCurrent(candidate, requirePreparedSession) && matchesExpected(candidate),
        withdrawQueuedReservation: () => tree.dispatchHold?.withdraw(),
        refreshDescendants: scope.refresh,
      })
    : { killed: false, superseded: true };
  tree.completedCleanupError = result.completedCleanupError;
  // Committed retirement preserves the captured request and descendant scope;
  // a newer generation or a refusal on a live row remains fenced.
  if (result.superseded && !tree.isCurrent(entry) && tree.canTraverse() && matchesExpected(entry)) {
    result = {
      killed: false,
      targetState: resolveSubagentKillTargetState(tree.entry),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.completedCleanupError !== undefined
        ? { completedCleanupError: result.completedCleanupError }
        : {}),
    };
  }
  if (result.continuationRetired) {
    params.onContinuationRetired?.();
  }
  if (result.killed) {
    // Later command or ownership failures cannot erase the committed native outcome.
    params.onKilled?.(tree.entry);
  }
  if (commands && !result.superseded && !result.declined && !result.error) {
    for (
      let pending = cancellationControl.prepareRead();
      pending;
      pending = cancellationControl.prepareRead()
    ) {
      await pending;
      cancellationControl.assertCurrent();
    }
    cancellationControl.assertCurrent();
    if (!tree.canTraverse() || !matchesExpected(tree.entry)) {
      return { entry: tree.entry, session, result: { ...result, superseded: true } };
    }
    // A terminal model result can retain ordinary commands after its run signal
    // is gone. Drain that exact request without replacing the completed task receipt.
    commands.observe(tree.entry);
    commands.cancel(() => {
      cancellationControl.assertCurrent();
      if (!tree.canTraverse() || !matchesExpected(tree.entry)) {
        throw new Error("Subagent ownership changed during command cancellation.");
      }
    });
  }
  return { entry: tree.entry, session, result };
}

function collectKillErrors(trees: KillTree[], unlabeledRoot?: KillTree) {
  let failed = 0;
  const errors: string[] = [];
  const collect = (tree: KillTree) => {
    const diagnostics = [...tree.errors];
    if (tree.completedCleanupError) {
      diagnostics.push(tree.completedCleanupError);
    }
    if (diagnostics.length > 0) {
      failed += 1;
      for (const error of diagnostics) {
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
  scope: KillScope;
  suppressTaskDelivery?: boolean;
  stopRequestCommands?: boolean;
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
): Promise<{ killed: number; labels: string[]; execAborted: boolean; continuationRetired?: true }> {
  let continuationRetired = false;
  const visits = new Map<
    KillTree,
    { label?: string; descendants: boolean; suppressCompletedWakes: boolean; execAborted: boolean }
  >();
  const visit = async (tree: KillTree, suppressCompletedWakes: boolean): Promise<void> => {
    let result = visits.get(tree);
    try {
      if (!result) {
        result = { descendants: false, suppressCompletedWakes, execAborted: false };
        visits.set(tree, result);
        const commands = params.stopRequestCommands
          ? captureSubagentCommands(tree.entry, tree.session)
          : undefined;
        if (
          !tree.entry.execution.endedAt ||
          (tree.session &&
            (captureSubagentExecution({ entry: tree.entry, session: tree.session })?.execution
              .executionSettlement ||
              getSubagentExecutionCleanup(tree.entry, tree.session.entry))) ||
          tree.entry.pauseReason === "sessions_yield" ||
          (params.suppressTaskDelivery &&
            suppressCompletedWakes &&
            tree.entry.requesterSettleWake) ||
          commands?.owners.length
        ) {
          let stopped: Awaited<ReturnType<typeof killLatestSubagentRun>> | undefined;
          let failure: { error: unknown } | undefined;
          const visitResult = result;
          try {
            stopped = await killLatestSubagentRun({
              ...params,
              tree,
              commands,
              onContinuationRetired: () => {
                continuationRetired = true;
              },
              onKilled: (entry) => {
                visitResult.label = resolveSubagentLabel(entry);
              },
            });
          } catch (error) {
            failure = { error };
          }
          // Observe every captured owner even when another authorized path canceled
          // it before a freshness failure, decline, replacement, or output eviction.
          result.execAborted = commands?.owners.some((owner) => owner.signal.aborted) === true;
          try {
            await commands?.settle();
          } catch (error) {
            const message = `Subagent command cleanup failed: ${formatErrorMessage(error)}`;
            if (failure) {
              failure = {
                error: new AggregateError([failure.error, error], message),
              };
            } else if (stopped) {
              stopped.result = {
                ...stopped.result,
                error: [stopped.result.error, message].filter(Boolean).join(" "),
              };
            }
          }
          if (failure) {
            throw failure.error;
          }
          if (!stopped) {
            return;
          }
          if (stopped.result.error) {
            tree.errors.add(stopped.result.error);
          }
          if (
            stopped.result.error ||
            stopped.result.completedCleanupError ||
            stopped.result.declined
          ) {
            // A parent's failed Stop cannot retire the completion it still owns.
            // Keep trying live descendants under the existing best-effort policy.
            result.suppressCompletedWakes = false;
          }
          if (stopped.result.superseded) {
            return;
          }
        }
        result.descendants = true;
      }
      for (let pending = tree.prepareRead(); pending; pending = tree.prepareRead()) {
        await pending;
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
  return {
    killed: labels.length,
    labels,
    execAborted: [...visits.values()].some((result) => result.execAborted),
    ...(continuationRetired ? { continuationRetired: true as const } : {}),
  };
}

async function killSubagentRoot(params: Parameters<typeof killLatestSubagentRun>[0]) {
  let stopped: Awaited<ReturnType<typeof killLatestSubagentRun>> = {
    entry: params.tree.entry,
    result: { killed: false },
  };
  let cascade: Awaited<ReturnType<typeof killSubagentRunTree>> = {
    killed: 0,
    labels: [],
    execAborted: false,
  };
  try {
    // Explicit root cancellation also reconciles terminal execution state.
    stopped = await killLatestSubagentRun(params);
    if (stopped.result.error) {
      params.tree.errors.add(stopped.result.error);
    }
    for (let pending = params.tree.prepareRead(); pending; pending = params.tree.prepareRead()) {
      await pending;
    }
    if (!stopped.result.superseded && !stopped.result.declined && params.tree.canTraverse()) {
      // Exact admin constraints belong only to its selected root, not each descendant.
      cascade = await killSubagentRunTree({
        suppressTaskDelivery: params.suppressTaskDelivery,
        suppressCompletedWakes: !stopped.result.error && !stopped.result.completedCleanupError,
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
  requestSelection?: ReturnType<typeof captureExecRequestSubagentSelection>;
  assertCurrent?: () => void;
  suppressTaskDelivery?: boolean;
  /** False declines traversal; the scope still releases every reservation hold. */
  beforeKill?: (sealRootSelection: () => void) => boolean | Promise<boolean>;
}): Promise<
  | Awaited<ReturnType<typeof killSelectedSubagentRuns>>
  | {
      status: "forbidden";
      error: string;
      killed: 0;
      labels: string[];
      execAborted?: boolean;
      continuationRetired?: true;
    }
> {
  if (params.controller.controlScope !== "children") {
    await params.beforeKill?.(() => {});
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  const selection = params.requestSelection
    ? {
        ...params,
        runs: params.requestSelection.runs,
        controller: undefined,
        ownsRoot: params.requestSelection.ownsRoot,
        selectPublishedRoot: params.requestSelection.selectPublishedRoot,
      }
    : params;
  const origin = params.requestSelection?.sessionGeneration;
  if (!origin) {
    return killSelectedSubagentRuns(selection);
  }
  let generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
  const assertCurrent = () => {
    params.assertCurrent?.();
    generation?.assertCurrent();
  };
  try {
    return await killSelectedSubagentRuns({
      ...selection,
      assertCurrent,
      prepareRead: () => generation?.prepareRead(),
      beforeKill: async (sealRootSelection) => {
        // The native scope already holds every selected root. Retain the fresh
        // source generation before its first effect, independently of old turns.
        generation = await prepareSessionGenerationFacts(origin);
        assertCurrent();
        return params.beforeKill ? await params.beforeKill(sealRootSelection) : true;
      },
    });
  } finally {
    generation?.release();
  }
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
      ...listRunsForControllerFromRuns(subagentRuns, params.sessionKey, params.agentId),
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
    beforeKill?: (sealRootSelection: () => void) => boolean | Promise<boolean>;
  },
) {
  const result = await withSubagentKillScope(params, async (scope, trees) => {
    const accepted = params.beforeKill ? await params.beforeKill(scope.sealRootSelection) : true;
    scope.sealRootSelection();
    if (accepted) {
      await scope.refresh();
    }
    const acceptedTrees = accepted ? trees : [];
    // The bulk signal was consumed above; never forward caller hooks into child kills.
    const stopped = await killSubagentRunTree({
      suppressTaskDelivery: params.suppressTaskDelivery,
      stopRequestCommands: true,
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
      ...(result.execAborted ? { execAborted: true } : {}),
      ...(result.continuationRetired ? { continuationRetired: true as const } : {}),
    };
  }
  return {
    status: "ok" as const,
    killed: result.killed,
    labels: result.labels,
    ...(result.execAborted ? { execAborted: true } : {}),
    ...(result.continuationRetired ? { continuationRetired: true as const } : {}),
  };
}

/** Admin kill path for a subagent session key, bypassing caller ownership checks. */
export async function killSubagentRunAdmin(
  params: SubagentAdminKillParams,
  control?: {
    assertCurrent: () => void;
    prepareRead?: () => Promise<void> | undefined;
    beforeSessionKill?: () => boolean | Promise<boolean>;
    preparePublication?: KillPublicationPreparation<SubagentAdminKillResult>;
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
    (expectedTaskRunId && (entry.taskRunId ?? entry.runId) !== expectedTaskRunId) ||
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
      const targetState = resolveSubagentKillTargetState(tree.entry) ?? stopResult.targetState;
      const killedTarget =
        targetState?.state === "terminal" && targetState.task.status === "cancelled";
      const stopResultAlreadyClearedAbort =
        stopResult.targetState !== undefined &&
        !(
          stopResult.targetState.state === "terminal" &&
          stopResult.targetState.task.status === "cancelled"
        );
      const resolved = stopped.session;
      if (targetState && !killedTarget && !stopResultAlreadyClearedAbort && resolved) {
        await persistSubagentAbortedLastRun({
          childSessionKey: targetSessionKey,
          session: resolved,
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
        return result;
      }
      // Completion can commit during the awaited handoff. Fence both the retained
      // run and its session incarnation before any synchronous result publication.
      const ownsOutcome = !rootStopSuperseded && tree.ownsRun() && tree.canTraverse();
      if (!ownsOutcome) {
        tree.errors.add("Subagent ownership changed during cancellation; retry.");
      }
      const targetState = ownsOutcome ? resolveSubagentKillTargetState(tree.entry) : undefined;
      const { errors } = collectKillErrors([tree], tree);
      return {
        ...result,
        ...(targetState ? { targetState } : {}),
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      };
    },
    control?.preparePublication,
    publish,
  );
}
