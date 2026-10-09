import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  POLICY_RULE_METADATA,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./doctor/metadata.js";
import { policyRuleValueIsValid } from "./doctor/ordered-shape.js";
import { normalizePolicySelectorValues, scopedPolicyOverlays } from "./doctor/policy-scope.js";
import { policyContainerShapeFindings } from "./doctor/policy-shape.js";
import { isPolicyValueAtLeastAsStrict } from "./doctor/strictness.js";
import { ocPathSegment } from "./doctor/utils.js";
import { getPolicyPath } from "./policy-value.js";

const POLICY_CONFORMANCE_CHECK_IDS = {
  missing: "policy/policy-conformance-missing",
  weaker: "policy/policy-conformance-weaker",
  invalid: "policy/policy-conformance-invalid",
} as const;

type PolicyConformanceFinding = {
  readonly checkId: (typeof POLICY_CONFORMANCE_CHECK_IDS)[keyof typeof POLICY_CONFORMANCE_CHECK_IDS];
  readonly severity: "error";
  readonly message: string;
  readonly source: "policy";
  readonly path: string;
  readonly target: string;
  readonly requirement: string;
  readonly fixHint: string;
};

export type PolicyConformanceReport = {
  readonly ok: boolean;
  readonly baselinePath: string;
  readonly policyPath: string;
  readonly rulesChecked: number;
  readonly findings: readonly PolicyConformanceFinding[];
};

type PolicyDocument = {
  readonly displayName: string;
  readonly value: unknown;
};

type PolicyDocumentReadResult =
  | ({ readonly ok: true } & PolicyDocument)
  | {
      readonly ok: false;
      readonly displayName: string;
      readonly message: string;
      readonly target: string;
    };

type PolicyRuleClaim = {
  readonly key: string;
  readonly metadata: PolicyRuleMetadata;
  readonly value: unknown;
  readonly target: string;
  readonly propertyPath: string;
  readonly selector?: {
    readonly kind: PolicyScopeSelectorKind;
    readonly value: string;
  };
};

export async function buildPolicyConformanceReport(params: {
  readonly baselinePath: string;
  readonly policyPath: string;
}): Promise<PolicyConformanceReport> {
  const baselinePath = resolvePolicyPath(params.baselinePath);
  const policyPath = resolvePolicyPath(params.policyPath);
  const baselineResult = await readPolicyDocument(baselinePath);
  const policyResult = await readPolicyDocument(policyPath);
  const report = (
    findings: readonly PolicyConformanceFinding[],
    rulesChecked = 0,
  ): PolicyConformanceReport => ({
    ok: findings.length === 0,
    baselinePath: baselineResult.displayName,
    policyPath: policyResult.displayName,
    rulesChecked,
    findings,
  });
  if (!baselineResult.ok || !policyResult.ok) {
    const invalidFindings = [baselineResult, policyResult]
      .filter((result): result is Extract<PolicyDocumentReadResult, { readonly ok: false }> => {
        return !result.ok;
      })
      .map((result) =>
        invalidConformanceFinding(
          result.displayName,
          result.message,
          result.target,
          `Fix ${result.displayName} so it contains valid policy JSONC.`,
        ),
      );
    return report(invalidFindings);
  }
  const baseline = baselineResult;
  const policy = policyResult;
  const baselineClaims = collectPolicyRuleClaims(baseline);
  const candidateClaims = collectPolicyRuleClaims(policy);
  const documents = [baseline, policy];
  const invalidFindings = uniqueConformanceFindings([
    ...documents.flatMap((document) =>
      policyContainerShapeFindings(document.value, document.displayName, document.displayName).map(
        (finding) =>
          invalidConformanceFinding(
            document.displayName,
            finding.message,
            finding.target ?? `oc://${document.displayName}`,
            finding.fixHint ??
              `Fix ${document.displayName} so it uses the documented policy syntax.`,
          ),
      ),
    ),
    ...documents.flatMap(collectInvalidScopedPolicyFindings),
    ...(
      [
        [baseline, baselineClaims],
        [policy, candidateClaims],
      ] as const
    ).flatMap(([document, claims]) =>
      claims
        .filter((claim) => !policyRuleValueIsValid(claim.metadata, claim.value))
        .map((claim) =>
          invalidConformanceFinding(
            document.displayName,
            `${document.displayName} ${claim.propertyPath} is not valid policy conformance syntax.`,
            claim.target,
            `Fix ${claim.propertyPath} so it uses the documented policy syntax.`,
          ),
        ),
    ),
  ]);
  if (invalidFindings.length > 0) {
    return report(invalidFindings);
  }
  const findings = baselineClaims
    .map((claim) => conformanceFinding(claim, candidateClaims, policy.displayName))
    .filter((finding): finding is PolicyConformanceFinding => finding !== undefined);
  return report(findings, baselineClaims.length);
}

function uniqueConformanceFindings(
  findings: readonly PolicyConformanceFinding[],
): readonly PolicyConformanceFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.checkId}\n${finding.target}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectInvalidScopedPolicyFindings(
  document: PolicyDocument,
): readonly PolicyConformanceFinding[] {
  if (!isRecord(document.value) || document.value.scopes === undefined) {
    return [];
  }
  if (!isRecord(document.value.scopes)) {
    return [
      invalidConformanceFinding(
        document.displayName,
        `${document.displayName} scopes must be an object.`,
        `oc://${document.displayName}/scopes`,
        "Fix scopes so it uses the documented policy syntax.",
      ),
    ];
  }
  const findings: PolicyConformanceFinding[] = [];
  for (const [scopeName, overlay] of Object.entries(document.value.scopes)) {
    const scopePath = `scopes.${scopeName}`;
    const scopeTarget = `oc://${document.displayName}/scopes/${ocPathSegment(scopeName)}`;
    if (!isRecord(overlay)) {
      findings.push(
        invalidConformanceFinding(
          document.displayName,
          `${document.displayName} ${scopePath} must be an object.`,
          scopeTarget,
          `Fix ${scopePath} so it uses the documented policy syntax.`,
        ),
      );
      continue;
    }
    for (const metadata of POLICY_RULE_METADATA) {
      const value = getPolicyPath(overlay, metadata.policyPath);
      if (value === undefined) {
        continue;
      }
      const selectorMatches = (metadata.scopeSelectors ?? []).some(
        (selector) => normalizePolicySelectorValues(overlay[selector], selector).length > 0,
      );
      if (selectorMatches) {
        continue;
      }
      const propertyPath = `${scopePath}.${metadata.policyPath.join(".")}`;
      findings.push(
        invalidConformanceFinding(
          document.displayName,
          `${document.displayName} ${propertyPath} needs a valid selector for policy conformance.`,
          `${scopeTarget}/${metadata.policyPath.map(ocPathSegment).join("/")}`,
          `Fix ${propertyPath} so it uses the documented policy syntax.`,
        ),
      );
    }
  }
  return findings;
}

function invalidConformanceFinding(
  displayName: string,
  message: string,
  target: string,
  fixHint: string,
): PolicyConformanceFinding {
  return {
    checkId: POLICY_CONFORMANCE_CHECK_IDS.invalid,
    severity: "error",
    message,
    source: "policy",
    path: displayName,
    target,
    requirement: target,
    fixHint,
  };
}

function conformanceFinding(
  baseline: PolicyRuleClaim,
  candidateClaims: readonly PolicyRuleClaim[],
  policyDisplayName: string,
): PolicyConformanceFinding | undefined {
  if (baselineRuleIsNoOp(baseline.metadata, baseline.value)) {
    return undefined;
  }
  const exactCandidates = candidateClaims.filter((candidate) => candidate.key === baseline.key);
  const candidates =
    baseline.selector === undefined || exactCandidates.length > 0
      ? exactCandidates
      : candidateClaims.filter(
          (candidate) =>
            candidate.selector === undefined && candidate.metadata === baseline.metadata,
        );
  if (candidates.length === 0) {
    return unsatisfiedConformanceFinding(baseline, policyDisplayName);
  }
  const satisfies = (candidate: PolicyRuleClaim) =>
    isPolicyValueAtLeastAsStrict(baseline.metadata, candidate.value, baseline.value);
  if (
    baseline.selector !== undefined &&
    exactCandidates.length === 0 &&
    candidates.some(satisfies)
  ) {
    return undefined;
  }
  const weaker = candidates.find((candidate) => !satisfies(candidate));
  if (weaker !== undefined) {
    return unsatisfiedConformanceFinding(baseline, policyDisplayName, weaker);
  }
  if (baseline.selector === undefined) {
    const weakerScopedOverride = candidateClaims.find(
      (candidate) =>
        candidate.selector !== undefined &&
        candidate.metadata === baseline.metadata &&
        !satisfies(candidate),
    );
    if (weakerScopedOverride !== undefined) {
      return unsatisfiedConformanceFinding(baseline, policyDisplayName, weakerScopedOverride);
    }
  }
  return undefined;
}

function baselineRuleIsNoOp(metadata: PolicyRuleMetadata, baseline: unknown): boolean {
  switch (metadata.strictness) {
    case "allowlist-subset":
      return metadata.emptyList === "disabled" && policyRuleListIsEmpty(baseline);
    case "denylist-superset":
    case "routing-probes":
      return policyRuleListIsEmpty(baseline);
    case "requires-true":
      return baseline !== true;
    case "requires-false":
      return baseline !== false;
    case "exact-list":
    case "ordered-string":
      return false;
  }
  return false;
}

function policyRuleListIsEmpty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function unsatisfiedConformanceFinding(
  baseline: PolicyRuleClaim,
  policyDisplayName: string,
  candidate?: PolicyRuleClaim,
): PolicyConformanceFinding {
  return {
    checkId:
      candidate === undefined
        ? POLICY_CONFORMANCE_CHECK_IDS.missing
        : POLICY_CONFORMANCE_CHECK_IDS.weaker,
    severity: "error",
    message:
      candidate === undefined
        ? `${policyDisplayName} is missing ${baseline.propertyPath}.`
        : `${policyDisplayName} ${baseline.propertyPath} is weaker than the baseline policy.`,
    source: "policy",
    path: policyDisplayName,
    target:
      candidate?.target ??
      `oc://${policyDisplayName}/${baseline.propertyPath.replaceAll(".", "/")}`,
    requirement: baseline.target,
    fixHint:
      candidate === undefined
        ? `Add an equally or more restrictive ${baseline.propertyPath} rule, or update the baseline policy after review.`
        : `Use an equally or more restrictive ${baseline.propertyPath} value, or update the baseline policy after review.`,
  };
}

function collectPolicyRuleClaims(document: PolicyDocument): readonly PolicyRuleClaim[] {
  return [...collectTopLevelPolicyRuleClaims(document), ...collectScopedPolicyRuleClaims(document)];
}

function collectTopLevelPolicyRuleClaims(document: PolicyDocument): readonly PolicyRuleClaim[] {
  const claims: PolicyRuleClaim[] = [];
  for (const metadata of POLICY_RULE_METADATA) {
    const value = getPolicyPath(document.value, metadata.policyPath);
    if (value === undefined) {
      continue;
    }
    const propertyPath = metadata.policyPath.join(".");
    claims.push({
      key: `global:${propertyPath}`,
      metadata,
      value,
      target: `oc://${document.displayName}/${metadata.policyPath.map(ocPathSegment).join("/")}`,
      propertyPath,
    });
  }
  return claims;
}

function collectScopedPolicyRuleClaims(document: PolicyDocument): readonly PolicyRuleClaim[] {
  const claims: PolicyRuleClaim[] = [];
  for (const [scopeName, overlay] of scopedPolicyOverlays(document.value)) {
    for (const selector of ["agentIds", "channelIds"] as const) {
      const selectorValues = normalizePolicySelectorValues(overlay[selector], selector);
      if (selectorValues.length === 0) {
        continue;
      }
      const rules = POLICY_RULE_METADATA.filter(
        (metadata) => metadata.scopeSelectors?.includes(selector) === true,
      );
      for (const metadata of rules) {
        const value = getPolicyPath(overlay, metadata.policyPath);
        if (value === undefined) {
          continue;
        }
        const propertyPath = metadata.policyPath.join(".");
        const targetPath = [
          "scopes",
          ocPathSegment(scopeName),
          ...metadata.policyPath.map(ocPathSegment),
        ].join("/");
        for (const selectorValue of selectorValues) {
          claims.push({
            key: `${selector}:${selectorValue}:${propertyPath}`,
            metadata,
            value,
            target: `oc://${document.displayName}/${targetPath}`,
            propertyPath: `scopes.${scopeName}.${propertyPath}`,
            selector: { kind: selector, value: selectorValue },
          });
        }
      }
    }
  }
  return coalesceScopedPolicyRuleClaims(claims);
}

function coalesceScopedPolicyRuleClaims(
  claims: readonly PolicyRuleClaim[],
): readonly PolicyRuleClaim[] {
  const byKey = new Map<string, PolicyRuleClaim>();
  for (const claim of claims) {
    const previous = byKey.get(claim.key);
    if (
      previous === undefined ||
      isPolicyValueAtLeastAsStrict(previous.metadata, claim.value, previous.value)
    ) {
      byKey.set(claim.key, claim);
    }
  }
  return [...byKey.values()];
}

async function readPolicyDocument(path: string): Promise<PolicyDocumentReadResult> {
  const displayName = basename(path);
  let operation = "read";
  try {
    const raw = await fs.readFile(path, "utf-8");
    operation = "parsed";
    return { ok: true, displayName, value: JSON5.parse(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      displayName,
      message: `${displayName} could not be ${operation}: ${message}`,
      target: `oc://${displayName}`,
    };
  }
}

function resolvePolicyPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}
