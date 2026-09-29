import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyEvidence, PolicyIngressEvidence } from "../policy-state.js";
import { ingressPolicyShapeFinding } from "./access-shapes.js";
import { CHECK_IDS } from "./check-ids.js";
import { policyEvidenceFinding as ingressFinding } from "./policy-evidence-finding.js";
import { normalizePolicyChannelId } from "./policy-runtime.js";
import { channelScopedPolicyTargets } from "./policy-scope.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readPolicyPathString, readStringList } from "./utils.js";

export function ingressFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const ingressPolicy = policy.ingress;
  if (
    ingressPolicyShapeFinding(ingressPolicy, { policyDocName, policyPath }) === undefined &&
    isRecord(ingressPolicy)
  ) {
    findings.push(
      ...ingressFindingsForRule(ingressPolicy, policyDocName, "ingress", evidence, () => true),
    );
  }
  if (hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    for (const target of channelScopedPolicyTargets(policy)) {
      if (
        ingressPolicyShapeFinding(target.overlay.ingress, {
          policyDocName,
          policyPath,
          targetPrefix: `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          propertyPrefix: `scopes.${target.scopeName}.ingress`,
          allowSession: false,
        }) !== undefined ||
        !isRecord(target.overlay.ingress)
      ) {
        continue;
      }
      findings.push(
        ...ingressFindingsForRule(
          target.overlay.ingress,
          policyDocName,
          `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          evidence,
          (entry) => scopedIngressChannelMatches(entry, target.channelId),
        ),
      );
    }
  }
  return findings;
}

function ingressFindingsForRule(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  const requiredDmScope = readPolicyPathString(ingressPolicy, ["session", "requireDmScope"]);
  const allowedDmPolicies = new Set(readStringList(ingressPolicy, ["channels", "allowDmPolicies"]));
  const entries = (evidence.ingress ?? []).filter(evidenceFilter);
  const groupPolicies = entries.filter((entry) => entry.kind === "channelGroupPolicy");
  const rules = [
    {
      kind: "sessionDmScope",
      enabled: requiredDmScope !== undefined,
      violates: (entry) => entry.value !== requiredDmScope,
      checkId: CHECK_IDS.policyIngressDmScopeUnapproved,
      message: (entry) => `session.dmScope '${entry.value ?? ""}' does not match policy.`,
      path: "session/requireDmScope",
      fixHint: "Set session.dmScope to the required isolation scope or update policy after review.",
    },
    {
      kind: "channelDmPolicy",
      enabled: allowedDmPolicies.size > 0,
      violates: (entry) =>
        typeof entry.value === "string" && !allowedDmPolicies.has(entry.value.toLowerCase()),
      checkId: CHECK_IDS.policyIngressDmPolicyUnapproved,
      message: (entry) =>
        `${ingressLabel(entry)} uses unapproved DM policy '${entry.value ?? ""}'.`,
      path: "channels/allowDmPolicies",
      fixHint: "Set the channel DM policy to an allowed value or update policy after review.",
    },
    {
      kind: "channelGroupPolicy",
      enabled: readPolicyBoolean(ingressPolicy, ["channels", "denyOpenGroups"]) === true,
      violates: (entry) => entry.value !== "allowlist" && entry.value !== "disabled",
      checkId: CHECK_IDS.policyIngressOpenGroupsDenied,
      message: (entry) => `${ingressLabel(entry)} allows open group ingress.`,
      path: "channels/denyOpenGroups",
      fixHint: "Set groupPolicy to allowlist or disabled, or update policy after review.",
    },
    {
      kind: "channelRequireMention",
      enabled: readPolicyBoolean(ingressPolicy, ["channels", "requireMentionInGroups"]) === true,
      violates: (entry) => !isGroupIngressDisabled(entry, groupPolicies) && entry.value !== true,
      checkId: CHECK_IDS.policyIngressGroupMentionRequired,
      message: (entry) => `${ingressLabel(entry)} does not require group mentions.`,
      path: "channels/requireMentionInGroups",
      fixHint: "Set requireMention=true for the channel/group entry or update policy after review.",
    },
  ] satisfies readonly {
    kind: PolicyIngressEvidence["kind"];
    enabled: boolean;
    violates: (entry: PolicyIngressEvidence) => boolean;
    checkId: Parameters<typeof ingressFinding>[1]["checkId"];
    message: (entry: PolicyIngressEvidence) => string;
    path: string;
    fixHint: string;
  }[];
  return rules.flatMap((rule) =>
    rule.enabled
      ? entries
          .filter((entry) => entry.kind === rule.kind && rule.violates(entry))
          .map((entry) =>
            ingressFinding(entry, {
              checkId: rule.checkId,
              message: rule.message(entry),
              requirement: `oc://${policyDocName}/${requirementBase}/${rule.path}`,
              fixHint: rule.fixHint,
            }),
          )
      : [],
  );
}

function isGroupIngressDisabled(
  entry: PolicyIngressEvidence,
  groupPolicies: readonly PolicyIngressEvidence[],
): boolean {
  const entryParent = ocPathParent(entry.source);
  const channelDefaultsParent = "oc://openclaw.config/channels/defaults";
  const matches = groupPolicies
    .filter((candidate) => {
      const candidateParent = ocPathParent(candidate.source);
      return (
        candidate.channel === entry.channel &&
        (candidate.accountId ?? "") === (entry.accountId ?? "") &&
        (candidateParent === channelDefaultsParent ||
          entryParent === candidateParent ||
          entryParent.startsWith(`${candidateParent}/`))
      );
    })
    .toSorted(
      (left, right) => ocPathParent(right.source).length - ocPathParent(left.source).length,
    );
  return matches[0]?.value === "disabled";
}

function ocPathParent(source: string): string {
  return source.slice(0, Math.max(0, source.lastIndexOf("/")));
}

function scopedIngressChannelMatches(
  entry: PolicyIngressEvidence,
  policyChannelId: string,
): boolean {
  return normalizePolicyChannelId(entry.channel ?? "") === policyChannelId;
}

function ingressLabel(entry: PolicyIngressEvidence): string {
  const account = entry.accountId === undefined ? "" : ` account '${entry.accountId}'`;
  const group = entry.groupId === undefined ? "" : ` group '${entry.groupId}'`;
  return `channel '${entry.channel ?? "unknown"}'${account}${group}`;
}
