import { resolveExecApprovalsDisplayPath } from "openclaw/plugin-sdk/exec-approvals-runtime";
import type { HealthCheckContext, HealthFinding } from "openclaw/plugin-sdk/health";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty as normalizePolicyChannelId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { policyRoutingRules } from "../policy-routing.js";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
  type PolicyEvidence,
  type PolicyAgentWorkspaceEvidence,
  type PolicyIngressEvidence,
} from "../policy-state.js";
import { CHECK_IDS } from "./check-ids.js";
import { dataHandlingFindings, secretAuthProvenanceFindings } from "./data-auth-findings.js";
import { execApprovalsFindings } from "./exec-approval-findings.js";
import { createOrderedPolicyShape } from "./ordered-shape.js";
import { SUPPORTED_AUTH_PROFILE_METADATA, SUPPORTED_TOOL_METADATA } from "./policy-constants.js";
import {
  policyEvidenceFinding,
  policyEvidenceRuleFindings,
  type PolicyEvidenceRule,
} from "./policy-evidence-finding.js";
import {
  parsePolicyFile,
  policyChecksEnabled,
  policyDisplayName,
  policySettings,
  readChannelDenyRules,
  readExecApprovalsFile,
  readPolicyFile,
  readWorkspaceFile,
  requiredToolMetadata,
} from "./policy-runtime.js";
import { policyHasRules, scopedAgentEvidenceMatches } from "./policy-scope.js";
import { policySectionTargets } from "./policy-section-targets.js";
import { policyContainerShapeFindings } from "./policy-shape.js";
import { routingFindings } from "./routing-findings.js";
import { routingPolicyShapeFinding } from "./routing-shapes.js";
import { sandboxPostureFindings } from "./sandbox-findings.js";
import { gatewayExposureFindings } from "./scopes/gateway.js";
import {
  mcpServerFindings,
  modelProviderFindings,
  networkFindings,
} from "./scopes/model-network.js";
import { isChannelDenyRule } from "./shape-helpers.js";
import { toolMetadataFindings, toolPostureFindings } from "./tool-findings.js";
import type { PolicyEvaluation } from "./types.js";
import { readPolicyBoolean, readPolicyPathString, readStringList } from "./utils.js";

const policyEvaluationCache = new WeakMap<HealthCheckContext, Promise<PolicyEvaluation>>();

export function evaluatePolicy(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const cached = policyEvaluationCache.get(ctx);
  if (cached !== undefined) {
    return cached;
  }
  const next = evaluatePolicyUncached(ctx);
  policyEvaluationCache.set(ctx, next);
  return next;
}

async function evaluatePolicyUncached(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const settings = policySettings(ctx);
  const policyPath = policyDisplayName(ctx);
  let evidence: PolicyEvidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
    includeIngress: false,
    includeGatewayExposure: false,
    includeAgentWorkspace: false,
    includeToolPosture: false,
    includeSandboxPosture: false,
    includeSecrets: false,
    includeAuthProfiles: false,
    includeExecApprovals: false,
  });
  const findings: HealthFinding[] = [];
  const initialEvaluation: PolicyEvaluation = {
    policyPath,
    evidence,
    expectedAttestationHash: settings.expectedAttestationHash,
    findings,
    attestedFindings: findings,
  };

  if (!policyChecksEnabled(ctx, settings)) {
    return initialEvaluation;
  }

  const policyFile = await readPolicyFile(ctx);
  if (policyFile === null) {
    findings.push({
      checkId: CHECK_IDS.policyMissingFile,
      severity: "warning",
      message: `${policyPath} is missing for the enabled Policy plugin.`,
      source: "policy",
      path: policyPath,
      fixHint: `Restore ${policyPath} or add the policy artifact for this workspace.`,
    });
    return initialEvaluation;
  }

  const parsedPolicy = parsePolicyFile(policyFile.raw);
  if (!parsedPolicy.ok) {
    findings.push(policyParseFinding(policyFile.displayName, policyFile.ocDocName, parsedPolicy));
    return initialEvaluation;
  }

  const policy = parsedPolicy.value;
  const policyHash = policyDocumentHash(policy);
  const expectedHash = settings.expectedHash;
  if (
    typeof expectedHash === "string" &&
    expectedHash.trim() !== "" &&
    policyHash !== expectedHash.trim()
  ) {
    findings.push({
      checkId: CHECK_IDS.policyHashMismatch,
      severity: "error",
      message: `${policyFile.displayName} does not match the configured policy hash.`,
      source: "policy",
      path: policyFile.displayName,
      target: `oc://${policyFile.ocDocName}`,
      requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedHash",
      fixHint: `Restore the approved policy artifact or update plugins.entries.policy.config.expectedHash after review.`,
    });
    return {
      ...initialEvaluation,
      policy: { value: policy, hash: policyHash },
    };
  }

  const metadataRequirementShapeFindings = (
    path: "tools.requireMetadata" | "auth.profiles.requireMetadata",
  ): readonly HealthFinding[] => {
    const shape = createOrderedPolicyShape(policy, {
      policyPath: policyFile.displayName,
      policyDocName: policyFile.ocDocName,
    });
    const finding = shape.list(path, {
      allowed:
        path === "tools.requireMetadata"
          ? SUPPORTED_TOOL_METADATA
          : SUPPORTED_AUTH_PROFILE_METADATA,
      normalize: "lower",
      array: {
        message: "{policy} {property} must be an array of metadata keys.",
        hint: "Use supported metadata keys: {allowed}.",
      },
      entry: {
        message: "{policy} {property}[{index}] must be a supported metadata key.",
        hint: "Use supported metadata keys: {allowed}.",
      },
    });
    return finding === undefined ? [] : [finding];
  };

  const metadataRequirementFindings = metadataRequirementShapeFindings("tools.requireMetadata");
  const authMetadataRequirementFindings = metadataRequirementShapeFindings(
    "auth.profiles.requireMetadata",
  );
  const requiredMetadata =
    metadataRequirementFindings.length === 0 ? requiredToolMetadata(policy) : new Set<string>();
  const includeExecApprovals = policyHasRules(policy, "execApprovals");
  const routing =
    isRecord(policy) &&
    isRecord(policy.routing) &&
    routingPolicyShapeFinding(policy.routing, {
      policyDocName: policyFile.ocDocName,
      policyPath: policyFile.displayName,
    }) === undefined
      ? policyRoutingRules(policy)
      : undefined;
  const execApprovalsFile = includeExecApprovals ? await readExecApprovalsFile() : undefined;
  const evidenceOptions = {
    includeIngress: policyHasRules(policy, "ingress"),
    includeGatewayExposure: policyHasRules(policy, "gateway"),
    includeAgentWorkspace: policyHasRules(policy, "agents"),
    includeDataHandling: policyHasRules(policy, "dataHandling"),
    includeToolPosture: policyHasRules(policy, "tools"),
    includeSandboxPosture: policyHasRules(policy, "sandbox"),
    includeSecrets: policyHasRules(policy, "secrets"),
    includeAuthProfiles: policyHasRules(policy, "auth"),
    includeExecApprovals,
    execApprovalsRaw: includeExecApprovals ? (execApprovalsFile?.raw ?? null) : undefined,
    routing,
  };
  let unmigratedToolsFinding: HealthFinding | undefined;
  if (requiredMetadata.size > 0) {
    const [toolsFile, legacyToolsFile] = await Promise.all([
      readWorkspaceFile(ctx, "AGENTS.md"),
      readWorkspaceFile(ctx, "TOOLS.md"),
    ]);
    if (legacyToolsFile !== null) {
      unmigratedToolsFinding = {
        checkId: CHECK_IDS.policyUnmigratedToolsFile,
        severity: "error",
        message:
          "TOOLS.md contains unmigrated governed tool declarations; run `openclaw doctor --fix` to migrate them into the AGENTS.md `## Tools` section before policy evaluation can pass.",
        source: "policy",
        path: "TOOLS.md",
        target: "oc://TOOLS.md/tools",
        requirement: `oc://${policyFile.ocDocName}/tools/requireMetadata`,
        fixHint:
          "Run `openclaw doctor --fix` to migrate TOOLS.md into the AGENTS.md `## Tools` section.",
      };
    }
    evidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
      toolsRaw: toolsFile?.raw ?? "",
      ...evidenceOptions,
    });
  } else {
    evidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>, evidenceOptions);
  }
  const policyFindings: HealthFinding[] = [
    ...policyContainerShapeFindings(policy, policyFile.displayName, policyFile.ocDocName),
    ...channelFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...mcpServerFindings(policy, policyFile.ocDocName, evidence),
    ...modelProviderFindings(policy, policyFile.ocDocName, evidence),
    ...networkFindings(policy, policyFile.ocDocName, evidence),
    ...routingFindings(routing, policyFile.displayName, policyFile.ocDocName, evidence),
  ];
  {
    for (const target of policySectionTargets(
      policy,
      policyFile.displayName,
      policyFile.ocDocName,
      "ingress",
    )) {
      const ingressPolicy = target.policy;
      const requiredDmScope = readPolicyPathString(ingressPolicy, ["session", "requireDmScope"]);
      const allowedDmPolicies = new Set(
        readStringList(ingressPolicy, ["channels", "allowDmPolicies"]),
      );
      const entries = (evidence.ingress ?? []).filter(
        (entry) =>
          target.selectorId === undefined ||
          normalizePolicyChannelId(entry.channel ?? "") === target.selectorId,
      );
      const groupPolicies = entries.filter((entry) => entry.kind === "channelGroupPolicy");
      const rules = [
        {
          kind: "sessionDmScope",
          enabled: requiredDmScope !== undefined,
          violates: (entry) => entry.value !== requiredDmScope,
          checkId: CHECK_IDS.policyIngressDmScopeUnapproved,
          message: (entry) => `session.dmScope '${entry.value ?? ""}' does not match policy.`,
          path: ["session", "requireDmScope"],
          fixHint:
            "Set session.dmScope to the required isolation scope or update policy after review.",
        },
        {
          kind: "channelDmPolicy",
          enabled: allowedDmPolicies.size > 0,
          violates: (entry) =>
            typeof entry.value === "string" && !allowedDmPolicies.has(entry.value.toLowerCase()),
          checkId: CHECK_IDS.policyIngressDmPolicyUnapproved,
          message: (entry) =>
            `${ingressLabel(entry)} uses unapproved DM policy '${entry.value ?? ""}'.`,
          path: ["channels", "allowDmPolicies"],
          fixHint: "Set the channel DM policy to an allowed value or update policy after review.",
        },
        {
          kind: "channelGroupPolicy",
          enabled: readPolicyBoolean(ingressPolicy, ["channels", "denyOpenGroups"]) === true,
          violates: (entry) => entry.value !== "allowlist" && entry.value !== "disabled",
          checkId: CHECK_IDS.policyIngressOpenGroupsDenied,
          message: (entry) => `${ingressLabel(entry)} allows open group ingress.`,
          path: ["channels", "denyOpenGroups"],
          fixHint: "Set groupPolicy to allowlist or disabled, or update policy after review.",
        },
        {
          kind: "channelRequireMention",
          enabled:
            readPolicyBoolean(ingressPolicy, ["channels", "requireMentionInGroups"]) === true,
          violates: (entry) =>
            !isGroupIngressDisabled(entry, groupPolicies) && entry.value !== true,
          checkId: CHECK_IDS.policyIngressGroupMentionRequired,
          message: (entry) => `${ingressLabel(entry)} does not require group mentions.`,
          path: ["channels", "requireMentionInGroups"],
          fixHint:
            "Set requireMention=true for the channel/group entry or update policy after review.",
        },
      ] satisfies readonly (PolicyEvidenceRule<PolicyIngressEvidence> & { enabled: boolean })[];
      policyFindings.push(
        ...policyEvidenceRuleFindings(
          entries,
          rules.filter((rule) => rule.enabled),
          policyFile.ocDocName,
          target.requirementBase,
        ),
      );
    }
  }
  policyFindings.push(...gatewayExposureFindings(policy, policyFile.ocDocName, evidence));
  {
    const entries = evidence.agentWorkspace ?? [];
    for (const target of policySectionTargets(
      policy,
      policyFile.displayName,
      policyFile.ocDocName,
      "agents/workspace",
    )) {
      const agentId = target.selectorId;
      const targetEntries =
        agentId === undefined
          ? entries
          : entries.filter((entry) =>
              scopedAgentEvidenceMatches(entry, agentId, entries, entry.scope === "defaults"),
            );
      const allowed = new Set(readStringList(target.policy, ["allowedAccess"]));
      const requiredDeniedTools = new Set(readStringList(target.policy, ["denyTools"]));
      policyFindings.push(
        ...targetEntries
          .filter(
            (entry) =>
              allowed.size > 0 &&
              entry.kind === "workspaceAccess" &&
              entry.value !== undefined &&
              (entry.sandboxEnabled !== true || !allowed.has(entry.value)),
          )
          .map((entry) => {
            const sandboxDisabled = entry.sandboxEnabled !== true;
            const observed = sandboxDisabled
              ? `sandbox mode '${entry.sandboxMode ?? "off"}'`
              : `sandbox workspaceAccess '${entry.value ?? ""}'`;
            const source = sandboxDisabled
              ? (entry.sandboxModeSource ?? entry.source)
              : entry.source;
            return policyEvidenceFinding(
              { source },
              {
                checkId: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
                message: `${workspaceLabel(entry)} ${observed} is not allowed by policy.`,
                requirement: `oc://${policyFile.ocDocName}/${target.requirementBase}/allowedAccess`,
                fixHint:
                  "Enable sandbox mode with workspaceAccess none/ro or update policy after review.",
              },
            );
          }),
        ...targetEntries
          .filter(
            (entry) =>
              entry.kind === "toolDeny" &&
              entry.tool !== undefined &&
              requiredDeniedTools.has(entry.tool) &&
              entry.denied !== true,
          )
          .map((entry) =>
            policyEvidenceFinding(entry, {
              checkId: CHECK_IDS.policyAgentsToolNotDenied,
              message: `${workspaceLabel(entry)} does not deny required tool '${entry.tool ?? ""}'.`,
              requirement: `oc://${policyFile.ocDocName}/${target.requirementBase}/denyTools`,
              fixHint:
                "Add the tool to tools.deny or agents.entries.<id>.tools.deny, or update policy after review.",
            }),
          ),
      );
    }
  }
  policyFindings.push(
    ...toolPostureFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...sandboxPostureFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...dataHandlingFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...secretAuthProvenanceFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...execApprovalsFindings(
      policy,
      policyFile.displayName,
      policyFile.ocDocName,
      evidence,
      execApprovalsFile,
      resolveExecApprovalsDisplayPath(),
    ),
    ...authMetadataRequirementFindings,
    ...metadataRequirementFindings,
    ...(unmigratedToolsFinding === undefined ? [] : [unmigratedToolsFinding]),
  );
  policyFindings.push(...toolMetadataFindings(policyFile.ocDocName, evidence, requiredMetadata));
  const attestationFindings: HealthFinding[] = [];
  const expected = settings.expectedAttestationHash?.trim();
  if (expected) {
    const current = createPolicyAttestation({
      ok: policyFindings.length === 0,
      checkedAt: new Date(0).toISOString(),
      policyPath: policyFile.displayName,
      policyHash,
      evidence,
      findings: policyFindings.map(toAttestedFinding),
    });
    if (current.attestationHash !== expected) {
      attestationFindings.push({
        checkId: CHECK_IDS.policyAttestationMismatch,
        severity: "error",
        message: "The current policy check no longer matches the accepted policy attestation.",
        source: "policy",
        path: "policy attestation",
        target: "oc://policy/attestation/current",
        requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedAttestationHash",
        fixHint: `Run policy check, review attestation ${current.attestationHash}, then update plugins.entries.policy.config.expectedAttestationHash and the supervisor/gateway accepted attestation.`,
      });
    }
  }
  if (hasPolicyValidationFinding(policyFindings)) {
    findings.push(...policyFindings);
  } else if (attestationFindings.length > 0) {
    findings.push(...attestationFindings);
  } else {
    findings.push(...policyFindings);
  }

  return {
    policyPath,
    policy: { value: policy, hash: policyHash },
    evidence,
    expectedAttestationHash: settings.expectedAttestationHash,
    findings,
    attestedFindings: policyFindings,
  };
}

function policyParseFinding(
  policyPath: string,
  policyDocName: string,
  parseError: { readonly message: string },
): HealthFinding {
  return {
    checkId: CHECK_IDS.policyInvalidFile,
    severity: "error",
    message: `${policyPath} could not be parsed: ${parseError.message}`,
    source: "policy",
    path: policyPath,
    target: `oc://${policyDocName}`,
    fixHint: `Fix ${policyPath} so policy conformance checks can run.`,
  };
}

function hasPolicyValidationFinding(findings: readonly HealthFinding[]): boolean {
  return findings.some(
    (finding) =>
      finding.checkId === CHECK_IDS.policyInvalidFile ||
      finding.checkId === CHECK_IDS.policyUnmigratedToolsFile,
  );
}

function channelFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  function invalidChannelDenyRuleFindings(): readonly HealthFinding[] {
    const shape = createOrderedPolicyShape(policy, { policyPath, policyDocName });
    const rules = shape.value("channels.denyRules");
    if (rules === undefined) {
      return [];
    }
    if (!Array.isArray(rules)) {
      return [
        shape.finding("channels.denyRules", {
          message: "{policy} {property} must be an array.",
          hint: "Fix {policy} so channel deny rules are an array.",
        }),
      ];
    }
    for (const [index, rule] of rules.entries()) {
      if (!isRecord(rule)) {
        continue;
      }
      const entry = createOrderedPolicyShape(rule, {
        policyPath,
        policyDocName,
        propertyPrefix: "channels.denyRules[" + index + "]",
        targetPrefix: "channels/denyRules/#" + index,
      });
      const finding =
        entry.keys(
          "",
          ["id", "reason", "when"],
          "",
          "Remove {unsupported} or use id, when.provider, and reason.",
          "{policy} {unsupported} is not supported in channel deny rules.",
        ) ??
        entry.keys(
          "when",
          ["provider"],
          "",
          "Remove {unsupported} or use when.provider.",
          "{policy} {unsupported} is not supported in channel deny rules.",
        );
      if (finding !== undefined) {
        return [finding];
      }
    }
    const index = rules.findIndex((rule) => !isChannelDenyRule(rule));
    return index < 0
      ? []
      : [
          shape.finding(
            "channels.denyRules",
            {
              message: "{policy} {property}[{index}] must define when.provider as a string.",
              hint: "Fix {policy} so each channel deny rule has a provider match.",
            },
            { index },
          ),
        ];
  }
  const invalidRules = invalidChannelDenyRuleFindings();
  if (invalidRules.length > 0) {
    return invalidRules;
  }
  const denyRules = readChannelDenyRules(policy, policyDocName);
  if (denyRules.length === 0) {
    return [];
  }
  return evidence.channels.flatMap((channel): HealthFinding[] => {
    if (channel.enabled === false) {
      return [];
    }
    const rule = denyRules.find((candidate) => candidate.when.provider === channel.provider);
    if (rule === undefined) {
      return [];
    }
    return [
      policyEvidenceFinding(channel, {
        checkId: CHECK_IDS.policyDeniedChannelProvider,
        message: `Channel '${channel.id}' uses denied provider '${channel.provider}'.`,
        requirement: rule.requirement,
        fixHint:
          rule.reason ??
          "Disable this channel, remove it from config, or update the policy deny rule.",
      }),
    ];
  });
}

export function toAttestedFinding(finding: HealthFinding) {
  return {
    checkId: finding.checkId,
    severity: finding.severity,
    message: finding.message,
    ...(finding.source !== undefined ? { source: finding.source } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.column !== undefined ? { column: finding.column } : {}),
    ...(finding.ocPath !== undefined ? { ocPath: finding.ocPath } : {}),
    ...(finding.target !== undefined ? { target: finding.target } : {}),
    ...(finding.requirement !== undefined ? { requirement: finding.requirement } : {}),
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
  };
}

function workspaceLabel(entry: PolicyAgentWorkspaceEvidence): string {
  return entry.agentId === undefined ? "agents.defaults" : `agent '${entry.agentId}'`;
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

function ingressLabel(entry: PolicyIngressEvidence): string {
  const account = entry.accountId === undefined ? "" : ` account '${entry.accountId}'`;
  const group = entry.groupId === undefined ? "" : ` group '${entry.groupId}'`;
  return `channel '${entry.channel ?? "unknown"}'${account}${group}`;
}
