/**
 * Crypto-Bound Policy Service
 * 
 * Embeds policy rules into CSRG tokens with cryptographic proofs.
 * Similar to enterprise GCP IAM flow but for customer policy management.
 * 
 * Flow:
 * 1. Policy update -> build policy metadata -> call CSRG /intent
 * 2. CSRG hashes policy into Merkle tree -> signs with Ed25519
 * 3. Tool execution -> verify policy digest matches token
 */

import { createHash } from "node:crypto";
import type { PolicyRule, PolicyDefinition, PolicyState } from "./policy.js";

type LoggerLike = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  log?: (message: string) => void;
};

export type PolicyMetadata = {
  rules: PolicyRule[];
  version: number;
  updated_at: string;
  updated_by?: string;
  policy_digest: string;
};

export type CsrgPolicyToken = {
  intent_reference: string;
  plan_hash: string;
  merkle_root: string;
  token: {
    plan_hash: string;
    issued_at: number;
    expires_at: number;
    policy: {
      global: {
        metadata: PolicyMetadata;
        digest: string;
      };
    };
    identity: string;
    public_key: string;
    signature: string;
    version: string;
  };
  policy_digest: string;
  step_proofs?: Array<{
    path: string;
    hash: string;
    kind: string;
    proof: Array<{ position: string; sibling_hash: string }>;
  }>;
};

export type CsrgIntentRequest = {
  plan: {
    steps: Array<{
      action: string;
      mcp: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }>;
    metadata?: Record<string, unknown>;
  };
  policy: {
    global: {
      metadata: PolicyMetadata;
    };
  };
  identity: {
    user_id: string;
    agent_id: string;
    context_id: string;
  };
  validity_seconds: number;
};

type JsonResponse<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  text: string;
};

const DEFAULT_CSRG_URL = "http://localhost:8000";

function createLogger(logger?: LoggerLike): Required<LoggerLike> {
  const fallback = logger ?? {};
  const log = fallback.log ?? (() => {});
  return {
    debug: fallback.debug ?? fallback.info ?? log,
    info: fallback.info ?? log,
    warn: fallback.warn ?? log,
    error: fallback.error ?? log,
    log,
  };
}

async function postJson<T>(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
    }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timeout);
  }
}

function computePolicyDigest(rules: PolicyRule[]): string {
  const canonical = JSON.stringify(
    rules.map((r) => ({
      id: r.id,
      action: r.action,
      tool: r.tool,
      dataClass: r.dataClass,
      params: r.params,
      scope: r.scope,
    })),
    null,
    0,
  );
  return createHash("sha256").update(`policy|${canonical}`).digest("hex");
}

export class CryptoPolicyService {
  private readonly logger: Required<LoggerLike>;
  private readonly csrgBaseUrl: string;
  private readonly timeoutMs: number;
  private cachedToken: CsrgPolicyToken | null = null;
  private cachedPolicyDigest: string | null = null;

  constructor(options: {
    csrgBaseUrl?: string;
    timeoutMs?: number;
    logger?: LoggerLike;
  } = {}) {
    this.logger = createLogger(options.logger);
    this.csrgBaseUrl = options.csrgBaseUrl || process.env.CSRG_URL || DEFAULT_CSRG_URL;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.logger.info(`[CryptoPolicy] Initialized - CSRG URL: ${this.csrgBaseUrl}`);
  }

  /**
   * Issue a new CSRG token with policy embedded in Merkle tree
   */
  async issuePolicyToken(
    policyState: PolicyState,
    identity: { userId: string; agentId: string; contextId: string },
    validitySeconds: number = 3600,
  ): Promise<CsrgPolicyToken> {
    const policyDigest = computePolicyDigest(policyState.policy.rules);

    const policyMetadata: PolicyMetadata = {
      rules: policyState.policy.rules,
      version: policyState.version,
      updated_at: policyState.updatedAt,
      updated_by: policyState.updatedBy,
      policy_digest: policyDigest,
    };

    const plan = this.buildPolicyPlan(policyState.policy);

    const request: CsrgIntentRequest = {
      plan,
      policy: {
        global: {
          metadata: policyMetadata,
        },
      },
      identity: {
        user_id: identity.userId,
        agent_id: identity.agentId,
        context_id: identity.contextId,
      },
      validity_seconds: validitySeconds,
    };

    this.logger.info(
      `[CryptoPolicy] Issuing token: version=${policyState.version}, rules=${policyState.policy.rules.length}, digest=${policyDigest.slice(0, 16)}...`,
    );

    const response = await postJson<CsrgPolicyToken>(
      `${this.csrgBaseUrl}/intent`,
      request as unknown as Record<string, unknown>,
      this.timeoutMs,
    );

    if (!response.ok || !response.data) {
      const msg = response.text || `CSRG /intent failed with status ${response.status}`;
      this.logger.error(`[CryptoPolicy] Token issuance failed: ${msg}`);
      throw new Error(`Policy token issuance failed: ${msg}`);
    }

    const token: CsrgPolicyToken = {
      ...response.data,
      policy_digest: policyDigest,
    };

    this.cachedToken = token;
    this.cachedPolicyDigest = policyDigest;

    this.logger.info(
      `[CryptoPolicy] Token issued: intent_ref=${token.intent_reference}, merkle_root=${token.merkle_root?.slice(0, 16)}...`,
    );

    return token;
  }

  /**
   * Verify policy digest at tool execution time
   */
  verifyPolicyDigest(
    currentPolicyDigest: string,
    tokenPolicyDigest?: string,
  ): { valid: boolean; reason: string } {
    if (!tokenPolicyDigest) {
      return {
        valid: false,
        reason: "No policy token - policy not cryptographically bound",
      };
    }

    if (currentPolicyDigest !== tokenPolicyDigest) {
      return {
        valid: false,
        reason: `Policy mismatch: current=${currentPolicyDigest.slice(0, 16)}... token=${tokenPolicyDigest.slice(0, 16)}...`,
      };
    }

    return { valid: true, reason: "Policy digest verified" };
  }

  /**
   * Verify policy rule is in token using CSRG /verify/action
   */
  async verifyPolicyRule(
    ruleId: string,
    toolName: string,
  ): Promise<{ allowed: boolean; reason: string }> {
    if (!this.cachedToken) {
      return { allowed: false, reason: "No policy token cached" };
    }

    const ruleProof = this.cachedToken.step_proofs?.find(
      (p) => p.path.includes(ruleId) || p.path.includes(toolName),
    );

    if (!ruleProof) {
      this.logger.warn(`[CryptoPolicy] No proof found for rule ${ruleId} / tool ${toolName}`);
      return { allowed: true, reason: "No specific proof required" };
    }

    const verifyRequest = {
      path: ruleProof.path,
      value: { tool: toolName, rule_id: ruleId },
      proof: ruleProof.proof,
      token: this.cachedToken.token,
    };

    const response = await postJson<{ allowed: boolean; reason: string }>(
      `${this.csrgBaseUrl}/verify/action`,
      verifyRequest,
      this.timeoutMs,
    );

    if (!response.ok || !response.data) {
      return {
        allowed: false,
        reason: response.text || "CSRG verification failed",
      };
    }

    return response.data;
  }

  /**
   * Build a plan structure from policy rules for CSRG hashing
   */
  private buildPolicyPlan(policy: PolicyDefinition): CsrgIntentRequest["plan"] {
    const steps = policy.rules.map((rule) => ({
      action: `policy_rule:${rule.id}`,
      mcp: "armoriq-policy",
      description: `Rule: ${rule.action} ${rule.tool}${rule.dataClass ? ` for ${rule.dataClass}` : ""}`,
      metadata: {
        rule_id: rule.id,
        rule_action: rule.action,
        rule_tool: rule.tool,
        rule_data_class: rule.dataClass,
        rule_params: rule.params,
        rule_scope: rule.scope,
      } as Record<string, unknown>,
    }));

    if (steps.length === 0) {
      steps.push({
        action: "policy_rule:allow-all",
        mcp: "armoriq-policy",
        description: "Default: allow all",
        metadata: {
          rule_id: "allow-all",
          rule_action: "allow",
          rule_tool: "*",
          rule_data_class: undefined,
          rule_params: undefined,
          rule_scope: undefined,
        } as Record<string, unknown>,
      });
    }

    return {
      steps,
      metadata: {
        goal: "ArmorIQ policy enforcement",
        policy_type: "crypto-bound",
      },
    };
  }

  getCachedToken(): CsrgPolicyToken | null {
    return this.cachedToken;
  }

  getCachedPolicyDigest(): string | null {
    return this.cachedPolicyDigest;
  }

  clearCache(): void {
    this.cachedToken = null;
    this.cachedPolicyDigest = null;
  }
}

export { computePolicyDigest };
