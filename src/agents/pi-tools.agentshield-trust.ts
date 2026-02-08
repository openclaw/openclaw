import type { AnyAgentTool } from "./tools/common.js";
import { getTrustEnforcementConfig } from "../infra/agentshield-trust-config.js";
import {
  enforceTrust,
  isTrustEnforcementEnabled,
  type TrustCheckInput,
} from "../infra/agentshield-trust-enforcement.js";
import { jsonResult } from "./tools/common.js";

type TrustContext = {
  agentId?: string;
  sessionKey?: string;
  publisherId?: string;
  version?: string;
  permissionFingerprint?: string;
};

/**
 * Wrap a tool with AgentShield trust enforcement.
 *
 * Before allowing a tool call, checks:
 * - Publisher/artifact revocation (if REQUIRE_NOT_REVOKED=1)
 * - Keyring verification (if REQUIRE_KEYRING=1)
 *
 * When trust root is set but requirements are off, issues are logged as
 * warnings but do not block execution.
 */
export function wrapToolWithAgentShieldTrust(tool: AnyAgentTool, ctx?: TrustContext): AnyAgentTool {
  if (!isTrustEnforcementEnabled()) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const input: TrustCheckInput = {};

      if (ctx?.publisherId) {
        input.publisherId = ctx.publisherId;
      }

      const result = enforceTrust(input);

      if (result.action === "block") {
        const config = getTrustEnforcementConfig();
        const hint = formatTrustHint(config.trustRoot, config.revocationsFile);

        return jsonResult({
          status: "blocked",
          tool: toolName,
          reason: result.reason,
          agentId: ctx?.agentId ?? null,
          enforcement: {
            action: result.action,
            details: result.details,
          },
          hint,
        });
      }

      return await execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Format operator-facing hint for trust enforcement blocks.
 */
function formatTrustHint(trustRoot: string | null, revocationsFile: string | null): string {
  const parts: string[] = [];
  if (trustRoot) {
    parts.push(`trust root: ${trustRoot}`);
  }
  if (revocationsFile) {
    parts.push(`revocations: ${revocationsFile}`);
  }
  if (parts.length === 0) {
    return "Check AgentShield trust enforcement configuration.";
  }
  return `Check ${parts.join(" and ")}.`;
}

/**
 * Verify a signed decision receipt against publisher keyring.
 *
 * If REQUIRE_KEYRING=1 and verification fails, returns a BLOCK result.
 * Otherwise returns null (pass-through).
 */
export function verifyDecisionReceipt(receipt: {
  payload: unknown;
  signature: string;
  public_key: string;
  publisher_id?: string;
}): { blocked: boolean; reason: string } {
  if (!isTrustEnforcementEnabled()) {
    return { blocked: false, reason: "trust enforcement not enabled" };
  }

  const config = getTrustEnforcementConfig();

  if (!config.requireKeyring) {
    return { blocked: false, reason: "keyring verification not required" };
  }

  if (!receipt.publisher_id) {
    return {
      blocked: true,
      reason: "Blocked: receipt missing publisher_id for keyring verification",
    };
  }

  const input: TrustCheckInput = {
    publisherId: receipt.publisher_id,
    signedObject: {
      payload: receipt.payload,
      signature: receipt.signature,
      public_key: receipt.public_key,
    },
    expectedType: "agentshield.decision_receipt",
  };

  const result = enforceTrust(input);

  if (result.action === "block") {
    return {
      blocked: true,
      reason: `Blocked: receipt signature verification failed — ${result.reason}`,
    };
  }

  return { blocked: false, reason: "ok" };
}

export const __testing = {
  formatTrustHint,
  verifyDecisionReceipt,
};
