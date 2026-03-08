import {
  createDefaultToolClassificationRegistry,
  ToolClassificationRegistry,
} from "./tool-classifications.js";
import type { CaMeLConfig, CaMeLValue, PolicyResult, SecurityPolicy } from "./types.js";
import { matchPattern, normalizePatternValue } from "./utils.js";
import { isPublic, isTainted } from "./value.js";

function policyAllowed(): PolicyResult {
  return { allowed: true };
}

export class SecurityPolicyEngine {
  private policies: Array<[string, SecurityPolicy]>;
  private classifier: ToolClassificationRegistry;

  constructor(
    policies: Array<[string, SecurityPolicy]>,
    params?: {
      classifier?: ToolClassificationRegistry;
    },
  ) {
    this.policies = policies;
    this.classifier = params?.classifier ?? createDefaultToolClassificationRegistry();
  }

  checkPolicy(
    toolName: string,
    args: Record<string, CaMeLValue>,
    dependencies: CaMeLValue[],
  ): PolicyResult {
    if (this.classifier.isNoSideEffectTool(toolName)) {
      return policyAllowed();
    }

    const allValues = [...Object.values(args), ...dependencies];
    const hasTaintedValue = allValues.some((value) => isTainted(value) || !isPublic(value));

    if (!hasTaintedValue) {
      return policyAllowed();
    }

    for (const [pattern, policy] of this.policies) {
      if (!matchPattern(pattern, toolName)) {
        continue;
      }
      return policy(toolName, args, dependencies);
    }

    return {
      denied: true,
      reason: `No policy matched for tainted side-effect tool ${toolName}. Default deny.`,
    };
  }
}

export function createDefaultPolicies(config: CaMeLConfig): SecurityPolicyEngine {
  const trustedRecipients = new Set(
    (config.policies.trustedRecipients ?? []).map(normalizePatternValue),
  );
  const requireApproval = config.policies.requireApproval ?? ["exec", "message*", "gateway*"];
  const classifier = createDefaultToolClassificationRegistry({
    noSideEffectTools: config.policies.noSideEffectTools,
  });

  const defaultPolicy: SecurityPolicy = (toolName, args) => {
    const taintedEntries = Object.entries(args).filter(
      ([, value]) => isTainted(value) || !isPublic(value),
    );
    if (taintedEntries.length === 0) {
      return policyAllowed();
    }

    for (const [argName, argValue] of taintedEntries) {
      if (
        typeof argValue.raw === "string" &&
        trustedRecipients.has(normalizePatternValue(argValue.raw))
      ) {
        continue;
      }

      if (requireApproval.some((pattern) => matchPattern(pattern, toolName))) {
        return {
          denied: true,
          reason: `${toolName} requires explicit approval for tainted argument "${argName}".`,
        };
      }

      if (config.mode === "permissive") {
        continue;
      }

      return {
        denied: true,
        reason: `${toolName} denied: tainted argument "${argName}" is not trusted.`,
      };
    }

    return policyAllowed();
  };

  return new SecurityPolicyEngine([["*", defaultPolicy]], { classifier });
}
