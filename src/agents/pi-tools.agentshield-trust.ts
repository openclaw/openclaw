import fs from "node:fs";
import path from "node:path";
import { getTrustEnforcementConfig } from "../infra/agentshield-trust-config.js";
import {
  enforceTrust,
  isTrustEnforcementEnabled,
  type TrustCheckInput,
} from "../infra/agentshield-trust-enforcement.js";
import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult } from "./tools/common.js";

export type TrustContext = {
  agentId?: string;
  sessionKey?: string;
  publisherId?: string;
  version?: string;
  permissionFingerprint?: string;
  signedObject?: { payload: unknown; signature: string; public_key: string };
  expectedType?: string;
  trustCardId?: string;
  contentSha256?: string;
  signerPubkey?: string;
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
      if (ctx?.signedObject) {
        input.signedObject = ctx.signedObject;
      }
      if (ctx?.expectedType) {
        input.expectedType = ctx.expectedType;
      } else if (ctx?.signedObject) {
        input.expectedType = "agentshield.trust_card";
      }
      if (ctx?.trustCardId) {
        input.trustCardId = ctx.trustCardId;
      }
      if (ctx?.contentSha256) {
        input.contentSha256 = ctx.contentSha256;
      }
      if (ctx?.signerPubkey && !ctx?.signedObject) {
        input.signerPubkey = ctx.signerPubkey;
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

// ── Trust context resolution ──

/** Filenames probed (in order) when looking for a trust card in agentDir. */
const TRUST_CARD_PROBES = [
  "trust_card.json",
  "trust-card.json",
  "agentshield.trust_card.json",
  ".agentshield/trust_card.json",
  "trust/trust_card.json",
] as const;

type SignedEnvelope = { payload: Record<string, unknown>; signature: string; public_key: string };

function isSignedEnvelope(obj: unknown): obj is SignedEnvelope {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const o = obj as Record<string, unknown>;
  return (
    typeof o.signature === "string" &&
    typeof o.public_key === "string" &&
    typeof o.payload === "object" &&
    o.payload !== null
  );
}

export type ResolvedTrustContext = {
  publisherId?: string;
  signedTrustCard?: { payload: unknown; signature: string; public_key: string } | null;
  trustCardId?: string | null;
  contentSha256?: string | null;
};

/**
 * Best-effort resolution of trust context from agent directory and/or env vars.
 *
 * Resolution strategy:
 * 1. If AGENTSHIELD_TRUSTCARD_PATH is set, use it directly.
 * 2. Otherwise probe common filenames in agentDir.
 * 3. Parse JSON — supports signed envelope or unsigned payload.
 * 4. AGENTSHIELD_PUBLISHER_ID env var is used as a fallback for publisherId.
 */
export function resolveAgentShieldTrustContext(options?: {
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionKey?: string;
  config?: unknown;
}): ResolvedTrustContext {
  const result: ResolvedTrustContext = {};

  // Resolve trust card file path
  let trustCardPath: string | null = null;

  const envPath = process.env.AGENTSHIELD_TRUSTCARD_PATH;
  if (envPath) {
    trustCardPath = envPath;
  } else if (options?.agentDir) {
    for (const probe of TRUST_CARD_PROBES) {
      const candidate = path.join(options.agentDir, probe);
      try {
        if (fs.existsSync(candidate)) {
          trustCardPath = candidate;
          break;
        }
      } catch {
        // Permission error, skip
      }
    }
  }

  // Parse trust card if found
  if (trustCardPath) {
    try {
      const raw = fs.readFileSync(trustCardPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (isSignedEnvelope(parsed)) {
        result.signedTrustCard = {
          payload: parsed.payload,
          signature: parsed.signature,
          public_key: parsed.public_key,
        };
        const payload = parsed.payload;
        result.publisherId =
          typeof payload.publisher_id === "string"
            ? payload.publisher_id
            : typeof payload.publisherId === "string"
              ? payload.publisherId
              : undefined;
        result.trustCardId =
          typeof payload.trust_card_id === "string"
            ? payload.trust_card_id
            : typeof payload.id === "string"
              ? payload.id
              : null;
        result.contentSha256 =
          typeof payload.content_sha256 === "string"
            ? payload.content_sha256
            : typeof payload.sha256 === "string"
              ? payload.sha256
              : null;
      } else if (typeof parsed === "object" && parsed !== null) {
        // Unsigned payload directly
        const obj = parsed as Record<string, unknown>;
        result.publisherId =
          typeof obj.publisher_id === "string"
            ? obj.publisher_id
            : typeof obj.publisherId === "string"
              ? obj.publisherId
              : undefined;
        result.trustCardId =
          typeof obj.trust_card_id === "string"
            ? obj.trust_card_id
            : typeof obj.id === "string"
              ? obj.id
              : null;
        result.contentSha256 =
          typeof obj.content_sha256 === "string"
            ? obj.content_sha256
            : typeof obj.sha256 === "string"
              ? obj.sha256
              : null;
      }
    } catch {
      // Best-effort: unreadable / invalid JSON — continue with partial result
    }
  }

  // Env var fallback for publisherId
  const envPublisherId = process.env.AGENTSHIELD_PUBLISHER_ID;
  if (!result.publisherId && envPublisherId) {
    result.publisherId = envPublisherId;
  }

  return result;
}

export const __testing = {
  formatTrustHint,
  verifyDecisionReceipt,
  resolveAgentShieldTrustContext,
  TRUST_CARD_PROBES,
};
