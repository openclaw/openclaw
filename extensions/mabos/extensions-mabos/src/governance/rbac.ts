/**
 * Simple wildcard-matching RBAC permission engine.
 * Deny rules override allow rules.
 */

import { PermissionDeniedError } from "./types.js";

export interface RbacPolicy {
  roles: Record<
    string,
    {
      permissions: string[];
      deny?: string[];
    }
  >;
}

/**
 * Match a pattern with `*` wildcards against a value.
 * `*` alone matches everything. `budget:*` matches `budget:read`, `budget:write`, etc.
 */
function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;

  // Convert wildcard pattern to regex
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
  return regex.test(value);
}

export class RbacEngine {
  private policy: RbacPolicy;

  constructor(policy: RbacPolicy) {
    this.policy = policy;
  }

  /**
   * Check if a role is allowed to perform an action.
   * Deny rules are checked first and override any allow.
   */
  isAllowed(role: string, action: string): boolean {
    const roleDef = this.policy.roles[role];
    if (!roleDef) return false;

    // Check deny rules first — deny overrides allow
    if (roleDef.deny) {
      for (const denyPattern of roleDef.deny) {
        if (wildcardMatch(denyPattern, action)) {
          return false;
        }
      }
    }

    // Check allow rules
    for (const allowPattern of roleDef.permissions) {
      if (wildcardMatch(allowPattern, action)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Assert permission — throws PermissionDeniedError if not allowed.
   */
  assertAllowed(role: string, action: string): void {
    if (!this.isAllowed(role, action)) {
      throw new PermissionDeniedError(role, action);
    }
  }
}
