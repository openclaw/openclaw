/**
 * Sondera Cedar Policy Evaluator
 *
 * Pure TypeScript implementation using @cedar-policy/cedar-wasm
 * No Python dependencies required.
 */

import * as cedar from "@cedar-policy/cedar-wasm/nodejs";

export type PolicyDecision = "ALLOW" | "DENY";

export interface EvaluationResult {
  decision: PolicyDecision;
  reason?: string;
  policyIds?: string[];
}

export interface EvaluationContext {
  params?: Record<string, unknown>;
  response?: unknown;
}

interface ParsedPolicies {
  /** Policies as Record for Cedar */
  policies: Record<string, string>;
  /** Mapping from Cedar's internal IDs (policy0, policy1...) to our @id names */
  internalIdToName: Map<string, string>;
  /** Any parsing errors encountered */
  errors: string[];
}

/**
 * Extract the @id annotation from a policy using Cedar's policyToJson.
 * Returns the @id value or null if not found.
 */
function extractPolicyId(policyText: string): string | null {
  try {
    const result = cedar.policyToJson(policyText);
    if (result.type === "success" && result.json.annotations?.id) {
      return result.json.annotations.id;
    }
  } catch {
    // Fall through to return null
  }
  return null;
}

/**
 * Parse Cedar policy text into individual policies with their @id annotations.
 * Uses Cedar's native policySetTextToParts() for robust parsing that handles
 * nested braces, complex expressions, and multiline conditions correctly.
 */
function parsePolicies(policyText: string): ParsedPolicies {
  const policies: Record<string, string> = {};
  const internalIdToName = new Map<string, string>();
  const errors: string[] = [];

  // Use Cedar's native parser to split policies - handles nested braces correctly
  const parseResult = cedar.policySetTextToParts(policyText);

  if (parseResult.type === "failure") {
    const errorMsgs = parseResult.errors?.map((e) => e.message).join("; ") || "Unknown parse error";
    errors.push(`Failed to parse policy set: ${errorMsgs}`);
    return { policies, internalIdToName, errors };
  }

  // Process each policy extracted by Cedar
  parseResult.policies.forEach((policyStr, index) => {
    // Extract the @id annotation using Cedar's JSON conversion
    const policyId = extractPolicyId(policyStr) || `policy${index}`;

    // Store the policy (Cedar accepts policies with @id annotations)
    policies[policyId] = policyStr;

    // Map Cedar's internal ID to our @id name for diagnostics translation
    internalIdToName.set(`policy${index}`, policyId);
  });

  return { policies, internalIdToName, errors };
}

/**
 * Count the number of policies in a Cedar policy file.
 * Uses Cedar's native parser for accurate counting.
 */
export function countPolicyRules(policyText: string): number {
  const parseResult = cedar.policySetTextToParts(policyText);
  if (parseResult.type === "success") {
    return parseResult.policies.length;
  }
  // Fallback to regex count if parsing fails (for partial/invalid files)
  const idRegex = /@id\s*\(\s*"[^"]+"\s*\)/g;
  const matches = policyText.match(idRegex);
  return matches?.length ?? 0;
}

export class CedarEvaluator {
  private policies: Record<string, string>;
  private internalIdToName: Map<string, string>;
  private parseErrors: string[];

  constructor(policyText: string) {
    const parsed = parsePolicies(policyText);
    this.policies = parsed.policies;
    this.internalIdToName = parsed.internalIdToName;
    this.parseErrors = parsed.errors;

    // Throw if parsing failed entirely (no policies loaded)
    if (parsed.errors.length > 0 && Object.keys(parsed.policies).length === 0) {
      throw new Error(`Cedar policy parsing failed: ${parsed.errors.join("; ")}`);
    }
  }

  /**
   * Get any non-fatal parsing errors encountered during initialization.
   */
  get errors(): string[] {
    return this.parseErrors;
  }

  /**
   * Get the number of policies loaded in this evaluator.
   */
  get ruleCount(): number {
    return Object.keys(this.policies).length;
  }

  /**
   * Translate Cedar's internal policy IDs to our @id names.
   */
  private translatePolicyIds(internalIds: string[] | undefined): string[] {
    if (!internalIds) {
      return [];
    }
    return internalIds.map((id) => this.internalIdToName.get(id) || id);
  }

  /**
   * Evaluate a tool call against the Cedar policy.
   *
   * @param toolName - Name of the tool being called
   * @param context - Context containing params (PRE_TOOL) or response (POST_TOOL)
   * @returns Evaluation result with decision and reason
   */
  evaluate(toolName: string, context: EvaluationContext): EvaluationResult {
    try {
      // Build the authorization request
      const request = {
        principal: { type: "User", id: "openclaw-agent" },
        action: { type: "Sondera::Action", id: toolName },
        resource: { type: "Resource", id: "cli" },
        context: context,
      };

      // Call Cedar WASM to evaluate
      const result = cedar.isAuthorized({
        principal: request.principal,
        action: request.action,
        resource: request.resource,
        context: request.context,
        policies: {
          staticPolicies: this.policies,
        },
        entities: [],
      });

      // Handle API response format: { type: "success"|"failure", response?: { decision, diagnostics } }
      if (result.type === "failure") {
        // Policy parsing or evaluation error - fail closed (DENY for security)
        const errorMsgs =
          result.errors?.map((e: { message: string }) => e.message).join("; ") || "Unknown error";
        console.error(`[Sondera] Cedar evaluation failed for "${toolName}": ${errorMsgs}`);
        return {
          decision: "DENY",
          reason: `Policy error (blocked for safety): ${errorMsgs}`,
        };
      }

      // Success - extract decision from response
      const decision = result.response?.decision;
      const diagnostics = result.response?.diagnostics;

      // Translate internal IDs to @id names
      const policyNames = this.translatePolicyIds(diagnostics?.reason);

      // Fail-closed: only explicit "allow" permits, everything else denies
      if (decision === "allow") {
        return {
          decision: "ALLOW",
          reason: policyNames.join(", "),
        };
      } else {
        // "deny", undefined, or any other state -> DENY (fail-closed)
        return {
          decision: "DENY",
          reason: policyNames.join(", ") || "Denied by policy (no permit rule matched)",
          policyIds: policyNames,
        };
      }
    } catch (err) {
      // On evaluation error, fail closed (DENY for security)
      console.error(
        `[Sondera] Cedar evaluation error for "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        decision: "DENY",
        reason: `Policy error (blocked for safety): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Evaluate a PRE_TOOL stage (before tool execution).
   */
  evaluatePreTool(toolName: string, params: Record<string, unknown>): EvaluationResult {
    return this.evaluate(toolName, { params });
  }

  /**
   * Check if a policy ID is a redaction policy by naming convention.
   * Redaction policies use prefixes: sondera-redact-, owasp-redact-
   */
  private isRedactionPolicy(policyId: string): boolean {
    return policyId.startsWith("sondera-redact-") || policyId.startsWith("owasp-redact-");
  }

  /**
   * Evaluate a POST_TOOL stage (after tool execution, for result redaction).
   * Only redacts if a SPECIFIC redaction policy matched (identified by naming convention).
   */
  evaluatePostTool(toolName: string, response: unknown): EvaluationResult {
    const result = this.evaluate(`${toolName}_result`, { response });

    // Only redact if a specific redaction policy matched
    // Identify redaction policies by naming convention (more robust than special-casing)
    if (result.decision === "DENY") {
      const redactionPolicies = (result.policyIds || []).filter((id) => this.isRedactionPolicy(id));

      if (redactionPolicies.length === 0) {
        // No redaction policy matched - DENY was from a non-redaction rule
        // Allow result through (don't redact based on non-redaction policies)
        return {
          decision: "ALLOW",
          reason: "No redaction policy matched",
        };
      }

      // A specific redaction policy matched, redact the result
      return {
        ...result,
        policyIds: redactionPolicies,
        reason: redactionPolicies.join(", "),
      };
    }

    return result;
  }
}
