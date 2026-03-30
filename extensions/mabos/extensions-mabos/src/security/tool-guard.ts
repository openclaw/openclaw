import { generatePrefixedId } from "../tools/common.js";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  redactedArgs: Record<string, unknown>;
  actorRole: string;
  reason: string;
  createdAt: number;
}

interface ToolGuardConfig {
  dangerousTools?: string[];
  autoApproveForRoles?: string[];
}

const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "key",
  "private_key",
]);

export class ToolGuard {
  private dangerousPatterns: Array<string | RegExp>;
  private autoApproveRoles: Set<string>;

  constructor(config: ToolGuardConfig) {
    this.dangerousPatterns = (config.dangerousTools ?? []).map((pattern) => {
      if (pattern.includes("*")) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^${escaped.split("\\*").join(".*")}$`, "i");
      }
      return pattern;
    });
    this.autoApproveRoles = new Set(config.autoApproveForRoles ?? []);
  }

  checkApproval(
    toolName: string,
    args: Record<string, unknown>,
    actorRole: string,
  ): ApprovalRequest | null {
    if (this.autoApproveRoles.has(actorRole)) return null;
    if (!this.isDangerous(toolName)) return null;

    return {
      id: generatePrefixedId("approval"),
      toolName,
      redactedArgs: this.redactSensitive(args),
      actorRole,
      reason: `Tool "${toolName}" requires operator approval.`,
      createdAt: Date.now(),
    };
  }

  private isDangerous(toolName: string): boolean {
    for (const pattern of this.dangerousPatterns) {
      if (typeof pattern === "string") {
        if (pattern === toolName) return true;
      } else {
        if (pattern.test(toolName)) return true;
      }
    }
    return false;
  }

  private redactSensitive(args: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }
}
