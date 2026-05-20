import { randomUUID } from "node:crypto";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "../gateway/operator-scopes.js";
import type { InterpreterInlineEvalHit } from "../infra/command-analysis/inline-eval.js";
import {
  type ExecSecurity,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
} from "../infra/exec-approvals.js";
import type { ExecDenylistEntry } from "../infra/exec-approvals.types.js";
import { defaultExecAutoReviewer, type ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import { evaluateExecDenylist, resolveExecDenylistForSecurity } from "../infra/exec-denylist.js";
import { logWarn } from "../logger.js";
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
import { textResult } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

export type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";

const APPROVED_NODE_INVOKE_SCOPES = [WRITE_SCOPE, APPROVALS_SCOPE];

function requiresNodePolicySupport(policy: { security: string; ask: string }): boolean {
  return policy.security === "denylist";
}

function buildNodeDenylistDeniedResult(params: {
  cwd?: string;
  nodeId?: string;
}): AgentToolResult<ExecToolDetails> {
  return textResult("exec command is denied due to command in deny list", {
    status: "denied",
    reason: "denylist",
    host: "node",
    cwd: params.cwd,
    nodeId: params.nodeId,
  });
}

function evaluateNodeDenylist(params: {
  command: string;
  preparedCommand?: string;
  denylist: readonly ExecDenylistEntry[];
  cwd?: string;
  env?: Record<string, string>;
}) {
  return evaluateExecDenylist({
    command:
      params.preparedCommand && params.preparedCommand !== params.command
        ? `${params.command}\n${params.preparedCommand}`
        : params.command,
    denylist: params.denylist,
    cwd: params.cwd,
    env: params.env,
  });
}

function logNodeExecDenylistDecision(params: {
  decision: ReturnType<typeof evaluateExecDenylist>;
  agentId?: string;
  trigger?: string;
}): void {
  if (!params.decision.denied) {
    return;
  }
  const parts = [
    "exec denylist: denied command",
    `hash=${params.decision.commandHash}`,
    `length=${params.decision.commandLength}`,
    "host=node",
    params.agentId ? `agent=${params.agentId}` : undefined,
    params.trigger ? `trigger=${params.trigger}` : undefined,
    params.decision.invalid ? `invalid=${params.decision.reason}` : undefined,
    typeof params.decision.ruleIndex === "number"
      ? `ruleIndex=${params.decision.ruleIndex}`
      : undefined,
  ].filter(Boolean);
  logWarn(parts.join(" "));
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
    case "denylist":
      return 1;
    case "allowlist":
      return 2;
    case "deny":
      return 3;
  }
  throw new Error("Unsupported exec security floor");
}

function nodePolicyBlocksAutoReview(params: {
  hostSecurity: ExecSecurity;
  nodeApprovalPolicyKnown: boolean;
  nodeSecurity?: ExecSecurity;
  nodeAsk?: "off" | "on-miss" | "always";
}): boolean {
  return (
    !params.nodeApprovalPolicyKnown ||
    params.nodeAsk === "always" ||
    (params.nodeSecurity !== undefined &&
      execSecurityFloorRank(params.nodeSecurity) > execSecurityFloorRank(params.hostSecurity))
  );
}

export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const { approvals, hostSecurity, hostAsk, askFallback } =
    execHostShared.resolveExecHostApprovalContext({
      agentId: params.agentId,
      security: params.security,
      ask: params.ask,
      host: "node",
    });
  const requestedPolicy = { security: hostSecurity, ask: hostAsk };
  const target = await resolveNodeExecutionTarget(params);
  const nodeCanEnforceRequestPolicy = target.supportsSystemRunRequestPolicy;
  const requestedSecurityForNode = nodeCanEnforceRequestPolicy ? hostSecurity : undefined;
  const requestedAskForNode = nodeCanEnforceRequestPolicy ? hostAsk : undefined;
  const denylistRules = params.denylistFallbackDenylist ?? approvals.denylist ?? [];
  const gatewayEnforcedDenylistRules = resolveExecDenylistForSecurity(hostSecurity, denylistRules);
  if (!nodeCanEnforceRequestPolicy && gatewayEnforcedDenylistRules.length > 0) {
    const denyDecision = evaluateNodeDenylist({
      command: params.command,
      denylist: gatewayEnforcedDenylistRules,
      cwd: params.workdir,
      env: target.env,
    });
    if (denyDecision.denied) {
      if (params.logDenylistDenials !== false) {
        logNodeExecDenylistDecision({
          decision: denyDecision,
          agentId: params.agentId,
          trigger: params.trigger,
        });
      }
      return buildNodeDenylistDeniedResult({
        cwd: params.workdir,
        nodeId: target.nodeId,
      });
    }
  }
  if (requiresNodePolicySupport(requestedPolicy) && !nodeCanEnforceRequestPolicy) {
    throw new Error(
      [
        "exec host=node requires a node that supports requested exec policy enforcement.",
        "Update or reconnect the node host so it advertises system.run.request-policy.v1, or use host=gateway/sandbox for this command.",
      ].join(" "),
    );
  }
  if (
    shouldSkipNodeApprovalPrepare({
      hostSecurity,
      hostAsk,
      strictInlineEval: params.strictInlineEval,
    })
  ) {
    return await invokeNodeSystemRunDirect({
      request: params,
      target,
      requestedSecurity: requestedSecurityForNode,
      requestedAsk: requestedAskForNode,
    });
  }

  const prepared = await prepareNodeSystemRun({ request: params, target });
  const approvalAnalysis = await analyzeNodeApprovalRequirement({
    request: params,
    target,
    prepared,
    hostSecurity,
    hostAsk,
  });
  const {
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied,
    nodeApprovalPolicyKnown,
    nodeSecurity,
    nodeAsk,
    inlineEvalHit,
    requiresSecurityAuditSuppressionApproval,
    autoReviewArgv,
  } = approvalAnalysis;
  const requiresAsk =
    requiresExecApproval({
      ask: hostAsk,
      security: hostSecurity,
      analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied,
    }) ||
    inlineEvalHit !== null ||
    requiresSecurityAuditSuppressionApproval;
  if (requiresSecurityAuditSuppressionApproval) {
    params.warnings.push(
      "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.",
    );
  }

  let denylistFallbackPrechecked = params.denylistFallbackPrechecked === true;
  if (requiresAsk && askFallback === "denylist" && !nodeCanEnforceRequestPolicy) {
    throw new Error(
      [
        "exec host=node requires a node that supports requested exec policy enforcement.",
        "Update or reconnect the node host so it advertises system.run.request-policy.v1, or use host=gateway/sandbox for this command.",
      ].join(" "),
    );
  }
  if (requiresAsk && askFallback === "denylist" && !denylistFallbackPrechecked) {
    const denyDecision = evaluateNodeDenylist({
      command: params.command,
      preparedCommand: prepared.rawCommand,
      denylist: denylistRules,
      cwd: prepared.cwd ?? params.workdir,
      env: target.env,
    });
    denylistFallbackPrechecked = true;
    if (denyDecision.denied) {
      if (params.logDenylistDenials !== false) {
        logNodeExecDenylistDecision({
          decision: denyDecision,
          agentId: params.agentId,
          trigger: params.trigger,
        });
      }
      return buildNodeDenylistDeniedResult({
        cwd: prepared.cwd ?? params.workdir,
        nodeId: target.nodeId,
      });
    }
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
      commandHighlighting: params.commandHighlighting,
      ...buildExecApprovalRequesterContext({
        agentId: prepared.agentId,
        sessionKey: prepared.sessionKey,
      }),
      ...(options.requireDeliveryRoute !== undefined
        ? { requireDeliveryRoute: options.requireDeliveryRoute }
        : {}),
      ...(options.suppressDelivery !== undefined
        ? { suppressDelivery: options.suppressDelivery }
        : {}),
      ...buildExecApprovalTurnSourceContext(params),
    });

  let inlineApprovedByAsk = false;
  let inlineApprovalDecision: "allow-once" | "allow-always" | null = null;
  let inlineApprovalId: string | undefined;
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
      requiresSecurityAuditSuppressionApproval;
    if (
      params.autoReview === true &&
      hostAsk !== "always" &&
      autoReviewHasBoundCommand &&
      !autoReviewBlockedByNodePolicy &&
      !requiresSecurityAuditSuppressionApproval
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
      if (decision.decision === "allow-once") {
        const approvalId = randomUUID();
        await registerNodeApproval(approvalId, {
          requireDeliveryRoute: false,
          suppressDelivery: true,
        });
        await callGatewayTool(
          "exec.approval.resolve",
          { timeoutMs: 15_000 },
          { id: approvalId, decision: "allow-once" },
          { scopes: [APPROVALS_SCOPE] },
        );
        inlineApprovedByAsk = true;
        inlineApprovalDecision = "allow-once";
        inlineApprovalId = approvalId;
      }
      if (decision.decision !== "allow-once") {
        autoReviewRequiresHumanApproval = true;
        params.warnings.push(
          `Exec auto-review deferred to human approval (risk=${decision.risk}): ${decision.rationale}`,
        );
      }
    }

    if (!inlineApprovedByAsk) {
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
        const { baseDecision, approvedByAsk, deniedReason } =
          execHostShared.createExecApprovalDecisionState({
            decision: preResolvedDecision,
            askFallback,
            denylistFallbackPrechecked,
          });
        const strictInlineEvalDecision = execHostShared.enforceStrictInlineEvalApprovalBoundary({
          baseDecision,
          approvedByAsk,
          deniedReason,
          requiresInlineEvalApproval: inlineEvalHit !== null,
          requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
        });
        if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
          throw new Error(
            execHostShared.buildHeadlessExecApprovalDeniedMessage({
              trigger: params.trigger,
              host: "node",
              security: hostSecurity,
              ask: hostAsk,
              askFallback,
            }),
          );
        }
        inlineApprovedByAsk = strictInlineEvalDecision.approvedByAsk;
        inlineApprovalDecision = strictInlineEvalDecision.approvedByAsk ? "allow-once" : null;
        inlineApprovalId = approvalId;
      } else {
        const followupTarget = execHostShared.buildExecApprovalFollowupTarget({
          approvalId,
          sessionKey: params.notifySessionKey ?? params.sessionKey,
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
            deniedReason: initialDeniedReason,
          } = execHostShared.createExecApprovalDecisionState({
            decision,
            askFallback,
            denylistFallbackPrechecked,
          });
          let approvedByAsk = initialApprovedByAsk;
          let approvalDecision: "allow-once" | "allow-always" | null = null;
          let deniedReason = initialDeniedReason;
          let requestedSecurity = requestedSecurityForNode;
          let requestedAsk = requestedAskForNode;

          if (
            baseDecision.timedOut &&
            (askFallback === "full" || askFallback === "denylist") &&
            approvedByAsk
          ) {
            approvalDecision = "allow-once";
            if (askFallback === "denylist") {
              requestedSecurity = "denylist";
              requestedAsk = "off";
            }
          } else if (decision === "allow-once") {
            approvedByAsk = true;
            approvalDecision = "allow-once";
          } else if (decision === "allow-always") {
            approvedByAsk = true;
            approvalDecision = "allow-always";
          }

          ({ approvedByAsk, deniedReason } = execHostShared.enforceStrictInlineEvalApprovalBoundary(
            {
              baseDecision,
              approvedByAsk,
              deniedReason,
              requiresInlineEvalApproval: inlineEvalHit !== null,
              requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
            },
          ));
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
            const raw = await callGatewayTool(
              "node.invoke",
              { timeoutMs: target.invokeTimeoutMs },
              buildNodeSystemRunInvoke({
                target,
                command: prepared.argv,
                rawCommand: prepared.rawCommand,
                cwd: prepared.cwd,
                agentId: prepared.agentId,
                sessionKey: prepared.sessionKey,
                turnSourceChannel: params.turnSourceChannel,
                turnSourceTo: params.turnSourceTo,
                turnSourceAccountId: params.turnSourceAccountId,
                turnSourceThreadId: params.turnSourceThreadId,
                approved: approvedByAsk,
                approvalDecision:
                  approvalDecision === "allow-always" && inlineEvalHit !== null
                    ? "allow-once"
                    : approvalDecision,
                runId: approvalId,
                suppressNotifyOnExit: true,
                notifyOnExit: params.notifyOnExit,
                systemRunPlan: prepared.plan,
                requestedSecurity,
                requestedAsk,
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
            const output = normalizeNotifyOutput(combined.slice(-DEFAULT_NOTIFY_TAIL_CHARS));
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
          allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: hostAsk }),
          nodeId: target.nodeId,
        });
      }
    }
  }

  const startedAt = Date.now();
  const invoke = buildNodeSystemRunInvoke({
    target,
    command: prepared.argv,
    rawCommand: prepared.rawCommand,
    cwd: prepared.cwd,
    agentId: prepared.agentId,
    sessionKey: prepared.sessionKey,
    approved: inlineApprovedByAsk,
    approvalDecision: inlineApprovalDecision,
    runId: inlineApprovalId,
    notifyOnExit: params.notifyOnExit,
    systemRunPlan: prepared.plan,
    requestedSecurity: nodeCanEnforceRequestPolicy ? hostSecurity : undefined,
    requestedAsk: nodeCanEnforceRequestPolicy ? hostAsk : undefined,
  });
  const raw =
    inlineApprovedByAsk && inlineApprovalId
      ? await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke, {
          scopes: APPROVED_NODE_INVOKE_SCOPES,
        })
      : await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke);
  return formatNodeRunToolResult({ raw, startedAt, cwd: params.workdir });
}
