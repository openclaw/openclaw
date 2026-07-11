/**
 * Node-host exec orchestration.
 * Combines local policy, remote node policy, auto-review, approval follow-ups,
 * and `node.invoke system.run` execution for host=node calls.
 */
import { randomUUID } from "node:crypto";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "../gateway/operator-scopes.js";
import type { InterpreterInlineEvalHit } from "../infra/command-analysis/inline-eval.js";
import {
  buildExecDenylistRuleKey,
  evaluateExecDenylist,
  type ExecDenylistEntry,
  resolveEffectiveExecDenylist,
} from "../infra/exec-approvals-denylist.js";
import {
  type AllowAlwaysPersistenceDecision,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  maxAsk,
  requiresExecApproval,
  resolveExecApprovalsFromFile,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
  type ExecCommandSegment,
} from "../infra/exec-approvals.js";
import { defaultExecAutoReviewer, type ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import { tail } from "./bash-process-registry.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  analyzeNodeApprovalRequirement,
  buildNodeSystemRunInvoke,
  formatNodeRunToolResult,
  invokeNodeSystemRunDirect,
  prepareNodeSystemRun,
  resolveNodeExecutionTarget,
  shouldSkipNodeApprovalPrepare,
} from "./bash-tools.exec-host-node-phases.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";
import {
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  normalizeNotifyOutput,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { callGatewayTool } from "./tools/gateway.js";

const APPROVED_NODE_INVOKE_SCOPES = [WRITE_SCOPE, APPROVALS_SCOPE];

type NodeGatewayDispatchAuthority =
  | "current-policy"
  | "human-approval"
  | "auto-review"
  | "ask-fallback";

type NodeGatewayPolicyCheckpoint = {
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ExecSecurity;
};

type NodeGatewayDenylistDispatchBinding = {
  approvedRuleKeys: readonly string[];
  screenings: readonly {
    command: string;
    segments: readonly ExecCommandSegment[];
    analysisOk: boolean;
  }[];
  resolveCurrentConfigDenylist?: () => readonly ExecDenylistEntry[];
  configDenylist: readonly ExecDenylistEntry[];
};

function assertCurrentNodeGatewayDenylistAllowsDispatch(
  binding: NodeGatewayDenylistDispatchBinding | undefined,
): void {
  if (!binding) {
    return;
  }
  const currentConfigDenylist = binding.resolveCurrentConfigDenylist?.() ?? binding.configDenylist;
  const currentEffective = resolveEffectiveExecDenylist({
    layers: [currentConfigDenylist],
  });
  const approvedRuleKeys = new Set(binding.approvedRuleKeys);
  const newlyCurrent = currentEffective.filter(
    (entry) => !approvedRuleKeys.has(buildExecDenylistRuleKey(entry)),
  );
  if (newlyCurrent.length === 0) {
    return;
  }
  for (const screening of binding.screenings) {
    const evaluation = evaluateExecDenylist({
      command: screening.command,
      segments: screening.segments,
      denylist: newlyCurrent,
      analysisOk: screening.analysisOk,
    });
    if (evaluation.match !== null || evaluation.conservativeApproval) {
      throw new Error("Exec approval changed before execution");
    }
  }
}

async function assertCurrentNodeGatewayPolicyAllowsDispatch(params: {
  request: ExecuteNodeHostCommandParams;
  authority: NodeGatewayDispatchAuthority;
  currentPolicyAllows?: (policy: { hostSecurity: ExecSecurity; hostAsk: ExecAsk }) => boolean;
  fallbackPolicy?: NodeGatewayPolicyCheckpoint;
  denylistBinding?: NodeGatewayDenylistDispatchBinding;
}): Promise<void> {
  assertCurrentNodeGatewayDenylistAllowsDispatch(params.denylistBinding);
  const current = await execHostShared.resolveExecHostApprovalContext({
    agentId: params.request.agentId,
    security: params.request.security,
    ask: params.request.ask,
    host: "node",
  });
  // A human grant may bypass ask/allowlist, but never a later deny. Auto-review
  // additionally cannot stand in for a newly required human decision.
  if (current.hostSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
  }
  if (params.authority === "human-approval") {
    return;
  }
  if (params.authority === "auto-review") {
    if (current.hostAsk === "always") {
      throw new Error("exec denied: host=node ask=always requires human approval");
    }
    return;
  }
  if (params.authority === "ask-fallback") {
    const expected = params.fallbackPolicy;
    if (
      !expected ||
      current.hostSecurity !== expected.hostSecurity ||
      current.hostAsk !== expected.hostAsk ||
      current.askFallback !== expected.askFallback
    ) {
      throw new Error("exec denied: host=node fallback policy changed before dispatch");
    }
    return;
  }
  if (!params.currentPolicyAllows?.(current)) {
    throw new Error("exec denied: host=node policy changed before dispatch");
  }
}

function resolveNodeAutoReviewReason(params: {
  inlineEvalHit: InterpreterInlineEvalHit | null;
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): ExecAutoReviewInput["reason"] {
  if (params.inlineEvalHit !== null) {
    return "strict-inline-eval";
  }
  if (
    params.hostSecurity === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied) &&
    !params.durableApprovalSatisfied
  ) {
    return "allowlist-miss";
  }
  return "approval-required";
}

function execSecurityFloorRank(security: ExecSecurity): number {
  switch (security) {
    case "full":
      return 0;
    case "allowlist":
      return 1;
    case "deny":
      return 2;
  }
  throw new Error("Unsupported exec security floor");
}

function nodePolicyBlocksAutoReview(params: {
  hostSecurity: ExecSecurity;
  nodeApprovalPolicyKnown: boolean;
  nodeSecurity?: ExecSecurity;
  nodeAsk?: "off" | "on-miss" | "always";
}): boolean {
  // Remote node policy can be stricter than local host policy; do not auto-approve across that gap.
  return (
    !params.nodeApprovalPolicyKnown ||
    params.nodeAsk === "always" ||
    (params.nodeSecurity !== undefined &&
      execSecurityFloorRank(params.nodeSecurity) > execSecurityFloorRank(params.hostSecurity))
  );
}

function createOneShotAllowAlwaysDecision(): AllowAlwaysPersistenceDecision {
  return { kind: "one-shot", reasons: ["no-reusable-pattern"] };
}

async function fetchNodeApprovalsFileDenylist(params: {
  nodeId: string;
  agentId?: string;
}): Promise<ExecDenylistEntry[] | null> {
  try {
    const approvalsSnapshot = await callGatewayTool<{ file: unknown }>(
      "exec.approvals.node.get",
      { timeoutMs: 10_000 },
      { nodeId: params.nodeId },
    );
    if (!approvalsSnapshot || typeof approvalsSnapshot !== "object") {
      return null;
    }
    const approvalsFile = approvalsSnapshot.file;
    if (!approvalsFile || typeof approvalsFile !== "object") {
      // A well-formed snapshot without a file (ExecApprovalsNodeSnapshotSchema
      // keeps `file` optional) means the node has no approvals file, so the
      // file-layer denylist is known empty. Only transport failures stay
      // unknown and fail closed into the prepare path.
      return [];
    }
    const resolved = resolveExecApprovalsFromFile({
      file: approvalsFile as ExecApprovalsFile,
      agentId: params.agentId,
      overrides: { security: "full" },
    });
    return resolveEffectiveExecDenylist({ layers: [resolved.denylist] });
  } catch {
    return null;
  }
}

/**
 * Executes a command on a remote node, requesting approval when policy requires it.
 * Node-host approval combines caller policy and remote node approval snapshots.
 */
export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const { hostSecurity, hostAsk, askFallback } =
    await execHostShared.resolveExecHostApprovalContext({
      agentId: params.agentId,
      security: params.security,
      ask: params.ask,
      host: "node",
    });
  const target = await resolveNodeExecutionTarget(params);
  params.signal?.throwIfAborted();
  const configDenylist = resolveEffectiveExecDenylist({
    layers: [params.execConfigDenylist],
  });
  let fastPathApprovalsFileDenylist: ExecDenylistEntry[] | null = null;
  if (
    hostSecurity === "full" &&
    hostAsk === "off" &&
    params.strictInlineEval !== true &&
    configDenylist.length === 0
  ) {
    fastPathApprovalsFileDenylist = await fetchNodeApprovalsFileDenylist({
      nodeId: target.nodeId,
      agentId: params.agentId,
    });
  }
  const fastPathDenylistKnownEmpty =
    configDenylist.length === 0 &&
    fastPathApprovalsFileDenylist !== null &&
    fastPathApprovalsFileDenylist.length === 0;
  if (
    shouldSkipNodeApprovalPrepare({
      hostSecurity,
      hostAsk,
      strictInlineEval: params.strictInlineEval,
      denylistMayApply: !fastPathDenylistKnownEmpty,
    })
  ) {
    await assertCurrentNodeGatewayPolicyAllowsDispatch({
      request: params,
      authority: "current-policy",
      currentPolicyAllows: (current) =>
        shouldSkipNodeApprovalPrepare({
          hostSecurity: current.hostSecurity,
          hostAsk: current.hostAsk,
          strictInlineEval: params.strictInlineEval,
          denylistMayApply: !fastPathDenylistKnownEmpty,
        }),
    });
    return await invokeNodeSystemRunDirect({ request: params, target });
  }

  const preparedDenylist = resolveEffectiveExecDenylist({
    layers: [configDenylist, fastPathApprovalsFileDenylist ?? undefined],
  });
  const prepared = await prepareNodeSystemRun({ request: params, target });
  const approvalAnalysis = await analyzeNodeApprovalRequirement({
    request: params,
    target,
    prepared,
    hostSecurity,
    hostAsk,
    effectiveDenylist: preparedDenylist,
  });
  params.signal?.throwIfAborted();
  const {
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied,
    nodeApprovalPolicyKnown,
    nodeSecurity,
    nodeAsk,
    inlineEvalHit,
    requiresSecurityAuditSuppressionApproval,
    requiresDenylistApproval,
    denylistWarning,
    denylistScreenings,
    autoReviewArgv,
    allowAlwaysPersistence,
  } = approvalAnalysis;
  const gatewayDenylistBinding: NodeGatewayDenylistDispatchBinding = {
    // Every rule effective before the approval wait (config + approvals-file
    // layers) was already screened; only rules beyond these keys can revoke.
    approvedRuleKeys: preparedDenylist.map(buildExecDenylistRuleKey),
    screenings: denylistScreenings,
    configDenylist,
    ...(params.resolveCurrentExecConfigDenylist
      ? { resolveCurrentConfigDenylist: params.resolveCurrentExecConfigDenylist }
      : {}),
  };
  const approvalDecisionAsk =
    nodeApprovalPolicyKnown && nodeAsk !== undefined ? maxAsk(hostAsk, nodeAsk) : "always";
  const effectiveAllowAlwaysPersistence = requiresDenylistApproval
    ? createOneShotAllowAlwaysDecision()
    : allowAlwaysPersistence;
  const allowedDecisions = resolveExecApprovalAllowedDecisions({
    ask: approvalDecisionAsk,
    allowAlwaysPersistence: effectiveAllowAlwaysPersistence,
  });
  const unavailableDecisions = resolveExecApprovalUnavailableDecisions({
    ask: approvalDecisionAsk,
    allowAlwaysPersistence: effectiveAllowAlwaysPersistence,
  });
  const unavailableDecisionRequestParams =
    unavailableDecisions.length > 0 ? { unavailableDecisions } : {};
  const policyRequiresAsk = requiresExecApproval({
    ask: hostAsk,
    security: hostSecurity,
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied,
    denylisted: requiresDenylistApproval,
  });
  const requiresAsk =
    requiresDenylistApproval ||
    policyRequiresAsk ||
    inlineEvalHit !== null ||
    requiresSecurityAuditSuppressionApproval;
  if (requiresDenylistApproval && denylistWarning) {
    params.warnings.push(denylistWarning);
  }
  if (requiresSecurityAuditSuppressionApproval) {
    params.warnings.push(
      "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.",
    );
  }
  const registerNodeApproval = async (
    approvalId: string,
    options: { requireDeliveryRoute?: boolean; suppressDelivery?: boolean } = {},
  ) =>
    await registerExecApprovalRequestForHostOrThrow({
      approvalId,
      systemRunPlan: prepared.plan,
      env: target.env,
      workdir: prepared.cwd,
      host: "node",
      nodeId: target.nodeId,
      security: hostSecurity,
      ask: hostAsk,
      ...unavailableDecisionRequestParams,
      commandHighlighting: params.commandHighlighting,
      ...buildExecApprovalRequesterContext({
        agentId: prepared.agentId,
        sessionKey: prepared.sessionKey,
      }),
      approvalReviewerDeviceIds: params.approvalReviewerDeviceId
        ? [params.approvalReviewerDeviceId]
        : undefined,
      ...(options.requireDeliveryRoute !== undefined
        ? { requireDeliveryRoute: options.requireDeliveryRoute }
        : {}),
      ...(options.suppressDelivery !== undefined
        ? { suppressDelivery: options.suppressDelivery }
        : {}),
      ...buildExecApprovalTurnSourceContext(params),
    });

  const resolveCurrentTimeoutFallback = async (): Promise<{
    approvedByAsk: boolean;
    deniedReason: string | null;
    hostSecurity: ExecSecurity;
    hostAsk: typeof hostAsk;
    askFallback: ExecSecurity;
    requiresExplicitApproval: boolean;
  }> => {
    try {
      // A timeout is policy, not a human grant. Re-read the Gateway-owned
      // host policy at the decision point so a concurrent revoke wins.
      const current = await execHostShared.resolveExecHostApprovalContext({
        agentId: params.agentId,
        security: params.security,
        ask: params.ask,
        host: "node",
      });
      if (current.askFallback === "deny") {
        return {
          approvedByAsk: false,
          deniedReason: "approval-timeout",
          hostSecurity: current.hostSecurity,
          hostAsk: current.hostAsk,
          askFallback: current.askFallback,
          requiresExplicitApproval: false,
        };
      }
      const currentAnalysis = await analyzeNodeApprovalRequirement({
        request: { ...params, warnings: [] },
        target,
        prepared,
        hostSecurity: current.hostSecurity,
        hostAsk: current.hostAsk,
        effectiveDenylist: preparedDenylist,
      });
      if (current.askFallback === "full") {
        return {
          approvedByAsk: true,
          deniedReason: null,
          hostSecurity: current.hostSecurity,
          hostAsk: current.hostAsk,
          askFallback: current.askFallback,
          requiresExplicitApproval:
            currentAnalysis.inlineEvalHit !== null ||
            currentAnalysis.requiresSecurityAuditSuppressionApproval,
        };
      }
      const authorizationSatisfied =
        currentAnalysis.durableApprovalSatisfied ||
        (currentAnalysis.analysisOk && currentAnalysis.allowlistSatisfied);
      return {
        approvedByAsk: authorizationSatisfied,
        deniedReason: authorizationSatisfied ? null : "approval-timeout: allowlist-miss",
        hostSecurity: current.hostSecurity,
        hostAsk: current.hostAsk,
        askFallback: current.askFallback,
        requiresExplicitApproval:
          currentAnalysis.inlineEvalHit !== null ||
          currentAnalysis.requiresSecurityAuditSuppressionApproval,
      };
    } catch {
      return {
        approvedByAsk: false,
        deniedReason: "approval-timeout: policy-unavailable",
        hostSecurity: "deny",
        hostAsk,
        askFallback: "deny",
        requiresExplicitApproval: false,
      };
    }
  };

  let inlineApprovedByAsk = false;
  let inlineApprovalDecision: "allow-once" | "allow-always" | null = null;
  let inlineApprovalSource: "ask-fallback" | undefined;
  let inlineApprovalId: string | undefined;
  let inlineDispatchAuthority: NodeGatewayDispatchAuthority = "current-policy";
  let inlineFallbackPolicy: NodeGatewayPolicyCheckpoint | undefined;
  if (requiresAsk) {
    const autoReviewHasBoundCommand = analysisOk && autoReviewArgv !== undefined;
    const autoReviewBlockedByNodePolicy =
      params.autoReview === true &&
      hostAsk !== "always" &&
      nodePolicyBlocksAutoReview({
        hostSecurity,
        nodeApprovalPolicyKnown,
        nodeSecurity,
        nodeAsk,
      });
    let autoReviewRequiresHumanApproval =
      autoReviewBlockedByNodePolicy ||
      (params.autoReview === true && hostAsk !== "always" && !autoReviewHasBoundCommand) ||
      requiresSecurityAuditSuppressionApproval ||
      requiresDenylistApproval;
    if (
      params.autoReview === true &&
      hostAsk !== "always" &&
      autoReviewHasBoundCommand &&
      !autoReviewBlockedByNodePolicy &&
      !requiresSecurityAuditSuppressionApproval &&
      !requiresDenylistApproval
    ) {
      const reviewer = params.autoReviewer ?? defaultExecAutoReviewer;
      const decision = await reviewer({
        command: prepared.rawCommand,
        argv: autoReviewArgv,
        cwd: prepared.cwd,
        envKeys: Object.keys(params.requestedEnv ?? {}).toSorted(),
        host: "node",
        reason: resolveNodeAutoReviewReason({
          inlineEvalHit,
          hostSecurity,
          analysisOk,
          allowlistSatisfied,
          durableApprovalSatisfied,
        }),
        analysis: {
          parsed: analysisOk,
          allowlistMatched: allowlistSatisfied,
          durableApprovalMatched: durableApprovalSatisfied,
          inlineEval: inlineEvalHit !== null,
        },
        agent: {
          id: prepared.agentId,
          sessionKey: prepared.sessionKey,
        },
      });
      params.signal?.throwIfAborted();
      const autoReviewAllowed = decision.decision === "allow-once" && decision.risk === "low";
      if (autoReviewAllowed) {
        const approvalId = randomUUID();
        await registerNodeApproval(approvalId, {
          requireDeliveryRoute: false,
          suppressDelivery: true,
        });
        await callGatewayTool(
          "exec.approval.resolve",
          { timeoutMs: 15_000 },
          { id: approvalId, decision: "allow-once" },
          { scopes: [APPROVALS_SCOPE], requireAgentRuntimeIdentity: true },
        );
        inlineApprovedByAsk = true;
        inlineApprovalDecision = "allow-once";
        inlineApprovalId = approvalId;
        inlineDispatchAuthority = "auto-review";
      }
      if (!autoReviewAllowed) {
        autoReviewRequiresHumanApproval = true;
        params.warnings.push(
          `Exec auto-review deferred to human approval (risk=${decision.risk}): ${decision.rationale}`,
        );
      }
    }

    if (!inlineApprovedByAsk) {
      // Human approval may complete after this tool call returns, so follow-up delivery owns invocation.
      const requestArgs = execHostShared.buildDefaultExecApprovalRequestArgs({
        warnings: params.warnings,
        approvalRunningNoticeMs: params.approvalRunningNoticeMs,
        createApprovalSlug,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceAccountId: params.turnSourceAccountId,
      });
      const {
        approvalId,
        approvalSlug,
        warningText,
        expiresAtMs,
        preResolvedDecision,
        initiatingSurface,
        sentApproverDms,
        unavailableReason,
      } = await execHostShared.createAndRegisterDefaultExecApprovalRequest({
        ...requestArgs,
        register: registerNodeApproval,
      });
      if (
        execHostShared.shouldResolveExecApprovalUnavailableInline({
          trigger: params.trigger,
          unavailableReason,
          preResolvedDecision,
        })
      ) {
        const {
          baseDecision,
          approvedByAsk: initialApprovedByAsk,
          deniedReason: initialDeniedReason,
        } = execHostShared.createExecApprovalDecisionState({
          decision: preResolvedDecision,
          askFallback,
        });
        let approvedByAsk = initialApprovedByAsk;
        let deniedReason = initialDeniedReason;
        const currentFallback = baseDecision.timedOut
          ? await resolveCurrentTimeoutFallback()
          : null;
        if (currentFallback) {
          approvedByAsk = currentFallback.approvedByAsk;
          deniedReason = currentFallback.deniedReason;
        }
        const strictInlineEvalDecision = execHostShared.enforceStrictInlineEvalApprovalBoundary({
          baseDecision,
          approvedByAsk,
          deniedReason,
          requiresInlineEvalApproval:
            currentFallback?.requiresExplicitApproval ?? inlineEvalHit !== null,
          requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
        });
        if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
          throw new Error(
            execHostShared.buildHeadlessExecApprovalDeniedMessage({
              trigger: params.trigger,
              host: "node",
              security: currentFallback?.hostSecurity ?? hostSecurity,
              ask: currentFallback?.hostAsk ?? hostAsk,
              askFallback: currentFallback?.askFallback ?? askFallback,
            }),
          );
        }
        inlineApprovedByAsk = strictInlineEvalDecision.approvedByAsk;
        inlineApprovalSource = preResolvedDecision === null ? "ask-fallback" : undefined;
        if (inlineApprovalSource) {
          inlineDispatchAuthority = "ask-fallback";
          inlineFallbackPolicy = currentFallback ?? undefined;
        } else {
          inlineDispatchAuthority = "human-approval";
        }
        inlineApprovalDecision = inlineApprovalSource
          ? null
          : strictInlineEvalDecision.approvedByAsk
            ? "allow-once"
            : null;
        inlineApprovalId = approvalId;
      } else {
        const followupTarget = execHostShared.buildExecApprovalFollowupTarget({
          approvalId,
          sessionKey: params.notifySessionKey ?? params.sessionKey,
          expectedSessionId: params.sessionId,
          sessionStore: params.sessionStore,
          bashElevated: params.bashElevated,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
        });

        void (async () => {
          const decision = await execHostShared.resolveApprovalDecisionOrUndefined({
            approvalId,
            preResolvedDecision,
            onFailure: () =>
              void execHostShared.sendExecApprovalFollowupResult(
                followupTarget,
                `Exec denied (node=${target.nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
              ),
          });
          if (decision === undefined) {
            return;
          }

          const {
            baseDecision,
            approvedByAsk: initialApprovedByAsk,
            deniedReason: baseDeniedReason,
          } = execHostShared.createExecApprovalDecisionState({
            decision,
            askFallback,
          });
          let approvedByAsk = initialApprovedByAsk;
          let approvalDecision: "allow-once" | "allow-always" | null = null;
          const approvalSource = decision === null ? "ask-fallback" : undefined;
          let deniedReason = baseDeniedReason;
          const currentFallback = baseDecision.timedOut
            ? await resolveCurrentTimeoutFallback()
            : null;

          if (currentFallback) {
            approvedByAsk = currentFallback.approvedByAsk;
            deniedReason = currentFallback.deniedReason;
            approvalDecision = approvedByAsk ? "allow-once" : null;
          } else if (decision === "allow-once") {
            approvedByAsk = true;
            approvalDecision = "allow-once";
          } else if (decision === "allow-always") {
            approvedByAsk = true;
            approvalDecision = requiresDenylistApproval ? "allow-once" : "allow-always";
          }

          const strictBoundaryDecision = execHostShared.enforceStrictInlineEvalApprovalBoundary({
            baseDecision,
            approvedByAsk,
            deniedReason,
            requiresInlineEvalApproval:
              currentFallback?.requiresExplicitApproval ?? inlineEvalHit !== null,
            requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
          });
          approvedByAsk = strictBoundaryDecision.approvedByAsk;
          deniedReason = strictBoundaryDecision.deniedReason;
          if (deniedReason) {
            approvalDecision = null;
          }

          if (deniedReason) {
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, ${deniedReason}): ${params.command}`,
            );
            return;
          }

          try {
            await assertCurrentNodeGatewayPolicyAllowsDispatch({
              request: params,
              authority: approvalSource ? "ask-fallback" : "human-approval",
              fallbackPolicy: currentFallback ?? undefined,
              denylistBinding: gatewayDenylistBinding,
            });
            // Approved follow-up invocations need approval scopes because they mutate remote node state.
            const raw = await callGatewayTool(
              "node.invoke",
              { timeoutMs: target.invokeTimeoutMs },
              buildNodeSystemRunInvoke({
                target,
                command: prepared.argv,
                rawCommand: prepared.transportRawCommand,
                cwd: prepared.cwd,
                agentId: prepared.agentId,
                sessionKey: prepared.sessionKey,
                turnSourceChannel: params.turnSourceChannel,
                turnSourceTo: params.turnSourceTo,
                turnSourceAccountId: params.turnSourceAccountId,
                turnSourceThreadId: params.turnSourceThreadId,
                approved: approvalSource ? undefined : approvedByAsk,
                approvalDecision: approvalSource
                  ? null
                  : approvalDecision === "allow-always" &&
                      (inlineEvalHit !== null || requiresDenylistApproval)
                    ? "allow-once"
                    : approvalDecision,
                approvalSource,
                runId: approvalId,
                suppressNotifyOnExit: true,
                notifyOnExit: params.notifyOnExit,
                systemRunPlan: prepared.plan,
              }),
              { scopes: APPROVED_NODE_INVOKE_SCOPES },
            );
            const payload =
              raw?.payload && typeof raw.payload === "object"
                ? (raw.payload as {
                    stdout?: string;
                    stderr?: string;
                    error?: string | null;
                    exitCode?: number | null;
                    timedOut?: boolean;
                  })
                : {};
            const combined = [payload.stdout, payload.stderr, payload.error]
              .filter(Boolean)
              .join("\n");
            const output = normalizeNotifyOutput(tail(combined, DEFAULT_NOTIFY_TAIL_CHARS));
            const exitLabel = payload.timedOut ? "timeout" : `code ${payload.exitCode ?? "?"}`;
            const summary = output
              ? `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})\n${output}`
              : `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})`;
            await execHostShared.sendExecApprovalFollowupResult(followupTarget, summary);
          } catch {
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
            );
          }
        })();

        return execHostShared.buildExecApprovalPendingToolResult({
          host: "node",
          command: params.command,
          cwd: params.workdir,
          warningText,
          approvalId,
          approvalSlug,
          expiresAtMs,
          initiatingSurface,
          sentApproverDms,
          unavailableReason,
          allowedDecisions,
          nodeId: target.nodeId,
        });
      }
    }
  }

  const startedAt = Date.now();
  params.signal?.throwIfAborted();
  const invoke = buildNodeSystemRunInvoke({
    target,
    command: prepared.argv,
    rawCommand: prepared.transportRawCommand,
    cwd: prepared.cwd,
    agentId: prepared.agentId,
    sessionKey: prepared.sessionKey,
    approved: inlineApprovalSource ? undefined : inlineApprovedByAsk,
    approvalDecision: inlineApprovalSource ? null : inlineApprovalDecision,
    approvalSource: inlineApprovalSource,
    runId: inlineApprovalId,
    notifyOnExit: params.notifyOnExit,
    systemRunPlan: prepared.plan,
  });
  await assertCurrentNodeGatewayPolicyAllowsDispatch({
    request: params,
    authority: inlineDispatchAuthority,
    fallbackPolicy: inlineFallbackPolicy,
    denylistBinding: gatewayDenylistBinding,
    currentPolicyAllows: (current) =>
      !requiresExecApproval({
        ask: current.hostAsk,
        security: current.hostSecurity,
        analysisOk,
        allowlistSatisfied,
        durableApprovalSatisfied,
      }) &&
      inlineEvalHit === null &&
      !requiresSecurityAuditSuppressionApproval,
  });
  const raw =
    (inlineApprovedByAsk || inlineApprovalSource) && inlineApprovalId
      ? await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke, {
          scopes: APPROVED_NODE_INVOKE_SCOPES,
        })
      : await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke);
  return formatNodeRunToolResult({
    raw,
    startedAt,
    cwd: params.workdir,
    warnings: [...params.warnings, ...(params.foregroundWarnings ?? [])],
  });
}
