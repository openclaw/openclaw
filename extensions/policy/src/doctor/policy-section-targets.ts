import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getPolicyPath } from "../policy-value.js";
import { ingressPolicyShapeFinding } from "./access-shapes.js";
import { normalizePolicySelectorValues, scopedPolicyOverlays } from "./policy-scope.js";
import { posturePolicyShapeFinding } from "./posture-shapes.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment } from "./utils.js";

export function* policySectionTargets(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  section: "tools" | "sandbox" | "ingress" | "agents/workspace",
): Generator<{
  policy: Record<string, unknown>;
  requirementBase: string;
  selectorId?: string;
}> {
  if (!isRecord(policy)) {
    return;
  }
  const path = section.split("/");
  const value = getPolicyPath(policy, path);
  const context = { policyPath, policyDocName };
  const shapeFinding =
    section === "ingress"
      ? ingressPolicyShapeFinding(value, context)
      : posturePolicyShapeFinding(
          section === "agents/workspace" ? "agents" : section,
          section === "agents/workspace" ? policy.agents : value,
          context,
        );
  if (section === "agents/workspace" && shapeFinding !== undefined) {
    return;
  }
  if (isRecord(value) && shapeFinding === undefined) {
    yield { policy: value, requirementBase: section };
  }
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return;
  }
  const selector = section === "ingress" ? "channelIds" : "agentIds";
  for (const [scopeName, overlay] of scopedPolicyOverlays(policy)) {
    const scopedValue = getPolicyPath(overlay, path);
    if (!isRecord(scopedValue)) {
      continue;
    }
    for (const selectorId of normalizePolicySelectorValues(overlay[selector], selector)) {
      yield {
        policy: scopedValue,
        requirementBase: `scopes/${ocPathSegment(scopeName)}/${section}`,
        selectorId,
      };
    }
  }
}
