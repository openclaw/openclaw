/** before_tool_call hook that evaluates tool calls against Verdict policies. */

import type { VerdictClient } from "./client.js";
import type { VerdictPluginConfig } from "./config.js";
import type { ActionRequest, PolicyDecision, RepairAction } from "./types.js";

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

type BeforeToolCallContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

type Logger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/**
 * Apply auto-repairable operations to tool params.
 * Returns modified params if repairs were applied, or null if repairs
 * require human intervention (e.g., escalation, approval).
 */
function applyAutoRepairs(
  params: Record<string, unknown>,
  repairs: RepairAction[],
): { repaired: Record<string, unknown>; pending: RepairAction[] } {
  const repaired = { ...params };
  const pending: RepairAction[] = [];

  for (const repair of repairs) {
    switch (repair.op) {
      case "cap_value": {
        // Cap a numeric arg to max_value
        if (repair.max_value != null) {
          const argKey = repair.fields?.[0]?.replace(/^args\./, "") ?? "amount";
          const current = repaired[argKey];
          if (typeof current === "number" && current > repair.max_value) {
            repaired[argKey] = repair.max_value;
          }
        }
        break;
      }
      case "redact": {
        // Redact specified fields
        if (repair.fields) {
          for (const field of repair.fields) {
            const key = field.replace(/^args\./, "");
            if (key in repaired) {
              repaired[key] = "[REDACTED]";
            }
          }
        }
        break;
      }
      case "switch_tool": {
        // Tool switching requires agent-level handling; mark as pending
        pending.push(repair);
        break;
      }
      case "add_approval":
      case "escalate":
      case "require_consent":
      case "require_identity_verification":
      case "add_disclosure": {
        // These require human/agent intervention
        pending.push(repair);
        break;
      }
      default: {
        // Unknown repair ops go to pending for manual review
        pending.push(repair);
        break;
      }
    }
  }

  return { repaired, pending };
}

/** Format violations into a human-readable block reason. */
function formatBlockReason(decision: PolicyDecision): string {
  const parts: string[] = [`Policy decision: ${decision.decision}`];

  if (decision.violations?.length) {
    for (const v of decision.violations) {
      let line = `[${v.severity}] ${v.message}`;
      if (v.policy_id) {
        line = `${v.policy_id}: ${line}`;
      }
      if (v.sop_ref) {
        line += ` (ref: ${v.sop_ref})`;
      }
      parts.push(line);
    }
  }

  if (decision.suggested_repairs?.length) {
    parts.push("");
    parts.push("Suggested repairs:");
    for (const r of decision.suggested_repairs) {
      let line = `- ${r.op}`;
      if (r.reason) {
        line += `: ${r.reason}`;
      }
      if (r.role) {
        line += ` (requires ${r.role})`;
      }
      parts.push(line);
    }
  }

  return parts.join("\n");
}

export function createBeforeToolCallHook(
  client: VerdictClient,
  config: VerdictPluginConfig,
  logger: Logger,
) {
  return async (
    event: BeforeToolCallEvent,
    ctx: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | void> => {
    // Skip evaluation for tools in the skip list
    if (config.skipTools?.includes(event.toolName)) {
      return;
    }

    const actionRequest: ActionRequest = {
      action_id: ctx.toolCallId ?? crypto.randomUUID(),
      agent_id: ctx.agentId ?? "openclaw",
      tool: event.toolName,
      args: event.params,
      context: {
        principal: config.principal ?? "operator",
        agent_role: config.agentRole ?? "default",
        session_id: ctx.sessionId ?? "",
        identity_verified: config.identityVerified ?? false,
        extra: config.extra,
      },
      timestamp: new Date().toISOString(),
    };

    let decision: PolicyDecision;
    try {
      decision = await client.evaluate(actionRequest, config.shadowMode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`verdict: evaluation failed for ${event.toolName}: ${msg}`);
      // On evaluation failure, respect failOpen config
      if (config.failOpen !== false) {
        logger.info("verdict: fail-open enabled, allowing tool call");
        return;
      }
      return { block: true, blockReason: `Verdict policy evaluation failed: ${msg}` };
    }

    logger.info(
      `verdict: ${event.toolName} → ${decision.decision} (${decision.eval_duration_ms.toFixed(1)}ms)`,
    );

    if (decision.decision === "ALLOW") {
      return;
    }

    if (decision.decision === "DENY") {
      return {
        block: true,
        blockReason: formatBlockReason(decision),
      };
    }

    // REQUIRE_CHANGES: try to auto-repair params
    if (decision.decision === "REQUIRE_CHANGES" && decision.suggested_repairs?.length) {
      const { repaired, pending } = applyAutoRepairs(event.params, decision.suggested_repairs);

      if (pending.length === 0) {
        // All repairs applied automatically
        logger.info(`verdict: auto-repaired ${event.toolName} params`);
        return { params: repaired };
      }

      // Some repairs need human intervention — block with details
      logger.info(
        `verdict: ${event.toolName} requires manual intervention (${pending.length} pending repairs)`,
      );
      return {
        block: true,
        blockReason: formatBlockReason(decision),
      };
    }

    // REQUIRE_CHANGES with no repairs — treat as deny
    return {
      block: true,
      blockReason: formatBlockReason(decision),
    };
  };
}
