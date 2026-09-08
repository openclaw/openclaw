/**
 * Node-host exec orchestration.
 * Combines local policy, remote node policy, auto-review, approval follow-ups,
 * and `node.invoke system.run` execution for host=node calls.
 */
import { randomUUID } from "node:crypto";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "../gateway/operator-scopes.js";
import {
  type ExecSecurity,
  maxAsk,
  minSecurity,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
} from "../infra/exec-approvals.js";
import {
  defaultExecAutoReviewer,
  EXEC_AUTO_REVIEW_SHELL_STARTUP_WARNING,
  resolveExecAutoReviewDecision,
} from "../infra/exec-auto-review.js";
import {
  buildExecAutoReviewDeniedToolResult,
  formatExecApprovalContinuationSourceOutput,
} from "./bash-tools.exec-approval-output.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  isExecApprovalRunAbortedError,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  formatNodeInvokeFailureFollowup,
  invokeNodeSystemRun,
} from "./bash-tools.exec-host-node-failure.js";
import {
  analyzeNodeApprovalRequirement,
  buildNodeSystemRunInvoke,
  dispatchNodeSystemRun,
  prepareNodeSystemRun,
  resolveNodeExecutionTarget,
} from "./bash-tools.exec-host-node-phases.js";
import {
  assertCurrentNodeGatewayPolicyAllowsDispatch,
  type NodeGatewayDispatchAuthority,
  type NodeGatewayPolicyCheckpoint,
} from "./bash-tools.exec-host-node-policy.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";
import { createApprovalSlug } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";
import type { AgentToolResult } from "./runtime/index.js";
import { callGatewayTool } from "./tools/gateway.js";

const APPROVED_NODE_INVOKE_SCOPES = [WRITE_SCOPE, APPROVALS_SCOPE];

/**
 * Executes a command on a remote node, requesting approval when policy requires it.
 * Node-host approval combines caller policy and remote node approval snapshots.
 */
export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const target = await resolveNodeExecutionTarget(params);
  params.signal?.throwIfAborted();
  const { hostSecurity, hostAsk, askFallback } = params.bypassHostApprovalFloors
    ? { hostSecurity: params.security, hostAsk: params.ask, askFallback: "deny" as const }
    : await execHostShared.resolveExecHostApprovalContext({
        agentId: params.agentId,
        security: params.security,
        ask: params.ask,
        host: "node",
      });

  const prepared = await prepareNodeSystemRun({
    request: { ...params, security: hostSecurity, ask: hostAsk },
    target,
  });
  const approvalAnalysis = await analyzeNodeApprovalRequirement({
    request: params,
    target,
    prepared,
    hostSecurity,
    hostAsk,
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
    autoReviewBlockedByShellStartup,
    autoReviewEligibility,
    autoReviewArgv,
    allowAlwaysPersistence,
  } = approvalAnalysis;
  const approvalDecisionAsk =
    nodeApprovalPolicyKnown && nodeAsk !== undefined ? maxAsk(hostAsk, nodeAsk) : "always";
  const allowedDecisions = resolveExecApprovalAllowedDecisions({
    ask: approvalDecisionAsk,
    allowAlwaysPersistence,
  });
  const unavailableDecisions = resolveExecApprovalUnavailableDecisions({
    ask: approvalDecisionAsk,
    allowAlwaysPersistence,
  });
  const unavailableDecisionRequestParams =
    unavailableDecisions.length > 0 ? { unavailableDecisions } : {};
  const effectiveSecurity =
    nodeSecurity === undefined ? hostSecurity : minSecurity(hostSecurity, nodeSecurity);
  const effectiveAsk = nodeAsk === undefined ? hostAsk : maxAsk(hostAsk, nodeAsk);
  if (effectiveSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
  }
  const requiresAsk =
    requiresExecApproval({
      ask: effectiveAsk,
      security: effectiveSecurity,
      analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied,
    }) ||
    inlineEvalHit !== null ||
    requiresSecurityAuditSuppressionApproval;
  if (
    !requiresAsk &&
    effectiveSecurity === "allowlist" &&
    !(durableApprovalSatisfied || (analysisOk && allowlistSatisfied))
  ) {
    throw new Error("exec denied: host=node allowlist miss (ask=off)");
  }
  if (requiresAsk && params.nonInteractiveApproval) {
    const text = `Exec denied (approval_required): ${params.command}`;
    return {
      content: [{ type: "text", text }],
      details: {
        status: "failed",
        exitCode: null,
        failureKind: "approval_required",
        durationMs: 0,
        aggregated: text,
        timedOut: false,
        cwd: prepared.cwd,
      },
    };
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
      trigger: params.trigger,
      toolCallId: params.toolCallId,
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
      ...options,
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
    if (params.autoReview === true && hostAsk !== "always" && autoReviewBlockedByShellStartup) {
      params.warnings.push(EXEC_AUTO_REVIEW_SHELL_STARTUP_WARNING);
    }
    if (
      params.autoReview === true &&
      hostAsk !== "always" &&
      !autoReviewBlockedByShellStartup &&
      !autoReviewEligibility.eligible
    ) {
      params.warnings.push(autoReviewEligibility.reason);
    }
    const autoReviewHasBoundCommand = analysisOk && autoReviewArgv !== undefined;
    // Remote policy may be stricter; local auto-review cannot bypass that floor.
    const autoReviewBlockedByNodePolicy =
      params.autoReview === true &&
      hostAsk !== "always" &&
      (!nodeApprovalPolicyKnown ||
        nodeAsk === "always" ||
        (nodeSecurity !== undefined && minSecurity(hostSecurity, nodeSecurity) !== hostSecurity));
    let autoReviewRequiresHumanApproval =
      autoReviewBlockedByNodePolicy ||
      (params.autoReview === true && autoReviewBlockedByShellStartup) ||
      (params.autoReview === true && !autoReviewEligibility.eligible) ||
      (params.autoReview === true && hostAsk !== "always" && !autoReviewHasBoundCommand) ||
      requiresSecurityAuditSuppressionApproval;
    if (
      params.autoReview === true &&
      hostAsk !== "always" &&
      autoReviewHasBoundCommand &&
      !autoReviewBlockedByNodePolicy &&
      !autoReviewBlockedByShellStartup &&
      autoReviewEligibility.eligible &&
      !requiresSecurityAuditSuppressionApproval
    ) {
      const reviewer = params.autoReviewer ?? defaultExecAutoReviewer;
      const autoReviewReason =
        inlineEvalHit !== null
          ? "strict-inline-eval"
          : hostSecurity === "allowlist" &&
              (!analysisOk || !allowlistSatisfied) &&
              !durableApprovalSatisfied
            ? "allowlist-miss"
            : "approval-required";
      const pendingDecision = resolveExecAutoReviewDecision(reviewer, {
        command: prepared.rawCommand,
        argv: autoReviewArgv,
        cwd: prepared.cwd,
        envKeys: Object.keys(params.requestedEnv ?? {}).toSorted(),
        host: "node",
        reason: autoReviewReason,
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
      // An injected reviewer cannot keep a cancelled node invocation or approval alive.
      const decision = params.signal
        ? await abortable(params.signal, pendingDecision)
        : await pendingDecision;
      params.signal?.throwIfAborted();
      switch (decision.decision) {
        case "deny":
          return buildExecAutoReviewDeniedToolResult({
            command: prepared.rawCommand,
            cwd: prepared.cwd,
            decision,
            toolCallId: params.toolCallId,
          });
        case "ask":
          break;
        case "allow-once": {
          if (decision.risk !== "low" && decision.risk !== "medium") {
            break;
          }
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
          break;
        }
        default:
          throw new Error("Unsupported exec auto-review decision", {
            cause: decision satisfies never,
          });
      }
      if (!inlineApprovedByAsk) {
        autoReviewRequiresHumanApproval = true;
        params.warnings.push(
          `Exec auto-review deferred to human approval (risk=${decision.risk}): ${decision.rationale}`,
        );
      }
    }

    if (!inlineApprovedByAsk) {
      // Keep routed approvals in the owning turn unless its caller explicitly
      // delegates completion to a detached follow-up.
      const approvalRoute = await execHostShared.createExecApprovalRequestRoute({
        warnings: params.warnings,
        approvalRunningNoticeMs: params.approvalRunningNoticeMs,
        createApprovalSlug,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceAccountId: params.turnSourceAccountId,
        register: registerNodeApproval,
        askFallback,
        resolveTimedOut: async () => {
          const fallback = await resolveCurrentTimeoutFallback();
          return {
            approvedByAsk: fallback.approvedByAsk,
            deniedReason: fallback.deniedReason,
            context: fallback,
          };
        },
        requiresExplicitApproval: (fallback) =>
          fallback?.requiresExplicitApproval ?? inlineEvalHit !== null,
        requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
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
      } = approvalRoute;
      if (approvalRoute.kind === "inline") {
        const inlineDecision = approvalRoute.state;
        const currentFallback = inlineDecision.timeoutContext;
        if (inlineDecision.deniedReason || !inlineDecision.approvedByAsk) {
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
        inlineApprovedByAsk = inlineDecision.approvedByAsk;
        inlineApprovalSource = "ask-fallback";
        inlineDispatchAuthority = "ask-fallback";
        inlineFallbackPolicy = currentFallback;
        inlineApprovalDecision = null;
        inlineApprovalId = approvalId;
      } else if (unavailableReason === null && params.approvalFollowupMode === undefined) {
        // Keep the admitted turn alive while its approval is pending. Returning
        // approval-pending here closes the authority before the operator can act.
        const outcome = await execHostShared.resolveExecApprovalWaitOutcome({
          approvalId,
          preResolvedDecision,
          signal: params.signal,
          askFallback,
          resolveTimedOut: async () => {
            const fallback = await resolveCurrentTimeoutFallback();
            return { ...fallback, context: fallback };
          },
          requiresExplicitApproval: (fallback) =>
            fallback?.requiresExplicitApproval ?? inlineEvalHit !== null,
          requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
        });
        params.signal?.throwIfAborted();
        if (outcome.kind !== "resolved") {
          throw new Error(`exec denied: ${outcome.kind}`);
        }
        if (outcome.state.deniedReason || !outcome.state.approvedByAsk) {
          throw new Error(`exec denied: ${outcome.state.deniedReason ?? "approval-required"}`);
        }
        inlineApprovedByAsk = true;
        inlineApprovalId = approvalId;
        inlineApprovalDecision =
          outcome.decision === "allow-always" &&
          inlineEvalHit === null &&
          allowAlwaysPersistence.kind !== "one-shot"
            ? "allow-always"
            : outcome.decision === "allow-once" || outcome.decision === "allow-always"
              ? "allow-once"
              : null;
        inlineApprovalSource = outcome.decision === null ? "ask-fallback" : undefined;
        inlineDispatchAuthority = inlineApprovalSource ?? "human-approval";
        inlineFallbackPolicy = outcome.state.timeoutContext;
      } else {
        const followupTarget = execHostShared.buildExecApprovalFollowupTarget({
          approvalId,
          agentId: params.agentId,
          sessionKey: params.notifySessionKey ?? params.sessionKey,
          expectedSessionId: params.sessionId,
          sessionStore: params.sessionStore,
          bashElevated: params.bashElevated,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
          direct: params.approvalFollowupMode === "direct",
        });
        const sendApprovalRequestFailedFollowup = async (): Promise<void> => {
          if (!params.signal?.aborted) {
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
            );
          }
        };
        let nodeInvocationStarted = false;
        let nodeInvocationCompleted = false;

        void (async () => {
          const approvalOutcome = await execHostShared.resolveExecApprovalWaitOutcome({
            approvalId,
            preResolvedDecision,
            signal: params.signal,
            askFallback,
            resolveTimedOut: async () => {
              const fallback = await resolveCurrentTimeoutFallback();
              return {
                approvedByAsk: fallback.approvedByAsk,
                deniedReason: fallback.deniedReason,
                context: fallback,
              };
            },
            requiresExplicitApproval: (fallback) =>
              fallback?.requiresExplicitApproval ?? inlineEvalHit !== null,
            requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
          });
          if (approvalOutcome.kind !== "resolved") {
            if (approvalOutcome.kind === "request-failed") {
              await sendApprovalRequestFailedFollowup();
            }
            return;
          }

          const { decision, state: resolvedDecision } = approvalOutcome;
          const { approvedByAsk, deniedReason } = resolvedDecision;
          const currentFallback = resolvedDecision.timeoutContext;
          const approvalSource = decision === null ? "ask-fallback" : undefined;
          const approvalDecision: "allow-once" | "allow-always" | null = deniedReason
            ? null
            : currentFallback
              ? approvedByAsk
                ? "allow-once"
                : null
              : decision === "allow-once" || decision === "allow-always"
                ? decision
                : null;

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
            });
            if (params.signal?.aborted) {
              return;
            }
            // Approved follow-up invocations need approval scopes because they mutate remote node state.
            nodeInvocationStarted = true;
            const invocation = await invokeNodeSystemRun({
              invokeWaitMs: target.invokeWaitMs,
              invoke: buildNodeSystemRunInvoke({
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
                      (inlineEvalHit !== null || allowAlwaysPersistence.kind === "one-shot")
                    ? "allow-once"
                    : approvalDecision,
                approvalSource,
                runId: approvalId,
                suppressNotifyOnExit: true,
                notifyOnExit: params.notifyOnExit,
                systemRunPlan: prepared.plan,
              }),
              scopes: APPROVED_NODE_INVOKE_SCOPES,
              signal: params.signal,
            });
            nodeInvocationCompleted = true;
            if (!invocation.ok) {
              await execHostShared.sendExecApprovalFollowupResult(
                followupTarget,
                formatNodeInvokeFailureFollowup({
                  failure: invocation.failure,
                  nodeId: target.nodeId,
                  approvalId,
                  command: params.command,
                }),
              );
              return;
            }
            const raw = invocation.raw as { payload?: unknown };
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
            const output = formatExecApprovalContinuationSourceOutput([
              { label: "stdout", value: payload.stdout },
              { label: "stderr", value: payload.stderr },
              { label: "error", value: payload.error },
            ]);
            const exitLabel = payload.timedOut ? "timeout" : `code ${payload.exitCode ?? "?"}`;
            const summary = output
              ? `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})\n${output}`
              : `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})`;
            await execHostShared.sendExecApprovalFollowupResult(followupTarget, summary);
          } catch {
            if (params.signal?.aborted || nodeInvocationCompleted) {
              return;
            }
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
            );
          }
        })()
          .catch(async (error: unknown): Promise<void> => {
            // Once dispatch starts, a delivery failure cannot mean execution was denied.
            if (
              nodeInvocationStarted ||
              params.signal?.aborted ||
              isExecApprovalRunAbortedError(error)
            ) {
              return;
            }
            await sendApprovalRequestFailedFollowup();
          })
          .catch(() => undefined);

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
          processContinuationAvailable: params.processContinuationAvailable,
        });
      }
    }
  }

  params.signal?.throwIfAborted();
  const invoke = buildNodeSystemRunInvoke({
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
    currentPolicyAllows: (current) =>
      !requiresExecApproval({
        ask: current.hostAsk,
        security: current.hostSecurity,
        analysisOk,
        allowlistSatisfied,
        durableApprovalSatisfied,
      }) &&
      (current.hostSecurity !== "allowlist" ||
        durableApprovalSatisfied ||
        (analysisOk && allowlistSatisfied)) &&
      inlineEvalHit === null &&
      !requiresSecurityAuditSuppressionApproval,
  });
  params.signal?.throwIfAborted();
  return dispatchNodeSystemRun({
    request: params,
    target,
    invoke,
    ...((inlineApprovedByAsk || inlineApprovalSource) && inlineApprovalId
      ? { scopes: APPROVED_NODE_INVOKE_SCOPES }
      : {}),
  });
}
