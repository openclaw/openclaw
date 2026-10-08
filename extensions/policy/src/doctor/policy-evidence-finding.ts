import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { POLICY_CHECK_IDS } from "./check-ids.js";

export function policyEvidenceFinding(
  entry: { readonly source: string },
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

export type PolicyEvidenceRule<Entry extends { readonly source: string; readonly kind: string }> = {
  readonly path: readonly string[];
  readonly kind?: Entry["kind"];
  readonly violates: (entry: Entry) => boolean;
  readonly checkId: (typeof POLICY_CHECK_IDS)[number];
  readonly message: (entry: Entry) => string;
  readonly fixHint: string;
};

export function policyEvidenceRuleFindings<
  Entry extends { readonly source: string; readonly kind: string },
>(
  entries: readonly Entry[],
  rules: readonly PolicyEvidenceRule<Entry>[],
  policyDocName: string,
  requirementBase: string,
): HealthFinding[] {
  return rules.flatMap((rule) =>
    entries
      .filter(
        (entry) => (rule.kind === undefined || entry.kind === rule.kind) && rule.violates(entry),
      )
      .map((entry) =>
        policyEvidenceFinding(entry, {
          checkId: rule.checkId,
          message: rule.message(entry),
          requirement: `oc://${policyDocName}/${requirementBase}/${rule.path.join("/")}`,
          fixHint: rule.fixHint,
        }),
      ),
  );
}
