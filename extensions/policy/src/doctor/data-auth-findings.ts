import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyDataHandlingEvidence, PolicyEvidence } from "../policy-state.js";
import { CHECK_IDS } from "./check-ids.js";
import {
  authProfileAllowModesShapeFindings,
  dataHandlingLabel,
  dataHandlingPolicyShapeFindings,
  secretPolicyShapeFindings,
} from "./data-auth-shapes.js";
import {
  policyEvidenceFinding,
  policyEvidenceRuleFindings,
  type PolicyEvidenceRule,
} from "./policy-evidence-finding.js";
import { authProfileHasMetadata, requiredAuthProfileMetadata } from "./policy-runtime.js";
import {
  agentScopedPolicyTargets,
  policyHasRules,
  scopedAgentEvidenceMatches,
} from "./policy-scope.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function secretAuthProvenanceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const secretShapeFindings = secretPolicyShapeFindings(policy, policyPath, policyDocName);
  const authShapeFindings = authProfileAllowModesShapeFindings(policy, policyPath, policyDocName);
  return [
    ...(secretShapeFindings.length > 0
      ? secretShapeFindings
      : [
          ...secretManagedProviderFindings(policy, policyDocName, evidence),
          ...secretDeniedSourceFindings(policy, policyDocName, evidence),
        ]),
    ...(authShapeFindings.length > 0
      ? authShapeFindings
      : [
          ...authProfileMetadataFindings(policy, policyDocName, evidence),
          ...authProfileModeFindings(policy, policyDocName, evidence),
        ]),
  ];
}

export function dataHandlingFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const shapeFindings = dataHandlingPolicyShapeFindings(policy, policyPath, policyDocName);
  if (shapeFindings.length > 0) {
    return shapeFindings;
  }
  const findings: HealthFinding[] = [];
  findings.push(
    ...dataHandlingFindingsForRule(policy, policyDocName, "dataHandling", evidence, () => true),
  );
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!policyHasRules(target.overlay, "dataHandling")) {
      continue;
    }
    findings.push(
      ...dataHandlingFindingsForRule(
        target.overlay,
        policyDocName,
        `scopes/${ocPathSegment(target.scopeName)}/dataHandling`,
        evidence,
        (entry) =>
          entry.kind !== "memorySessionTranscriptIndexing" ||
          scopedAgentEvidenceMatches(
            entry,
            target.agentId,
            evidence.dataHandling ?? [],
            entry.id === "agents-defaults-memory-session-transcripts",
          ),
      ),
    );
  }
  return findings;
}

function dataHandlingFindingsForRule(
  policy: unknown,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyDataHandlingEvidence) => boolean,
): readonly HealthFinding[] {
  const dataHandling = isRecord(policy) ? policy.dataHandling : undefined;
  if (!isRecord(dataHandling)) {
    return [];
  }
  // Redaction is an unconditional runtime invariant, recorded as satisfied evidence.
  const rules = [
    {
      path: ["telemetry", "denyContentCapture"],
      kind: "telemetryContentCapture",
      violates: (entry) => entry.value === true,
      checkId: CHECK_IDS.policyDataHandlingTelemetryContentCapture,
      message: () => "Telemetry content capture is enabled.",
      fixHint: "Disable diagnostics.otel.captureContent or update policy after review.",
    },
    {
      path: ["retention", "requireSessionMaintenance"],
      kind: "sessionRetentionMode",
      violates: (entry) => entry.value !== "enforce",
      checkId: CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
      message: (entry) => `Session retention maintenance mode is '${entry.value ?? "unknown"}'.`,
      fixHint: "Set session.maintenance.mode to enforce or update policy after review.",
    },
    {
      path: ["memory", "denySessionTranscriptIndexing"],
      kind: "memorySessionTranscriptIndexing",
      violates: (entry) => entry.value === true,
      checkId: CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
      message: (entry) => `${dataHandlingLabel(entry)} enables session transcript memory indexing.`,
      fixHint:
        "Disable session transcript memory indexing for the matching config surface or update policy after review.",
    },
  ] satisfies readonly PolicyEvidenceRule<PolicyDataHandlingEvidence>[];
  return policyEvidenceRuleFindings(
    (evidence.dataHandling ?? []).filter(evidenceFilter),
    rules.filter((rule) => readPolicyBoolean(dataHandling, rule.path) === true),
    policyDocName,
    requirementBase,
  );
}

function secretManagedProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["secrets", "requireManagedProviders"]) !== true) {
    return [];
  }
  const secrets = evidence.secrets ?? [];
  const providerKeys = new Set(
    secrets
      .filter((secret) => secret.kind === "provider" && secret.providerSource !== undefined)
      .map((secret) => `${secret.providerSource}:${secret.id}`),
  );
  return secrets
    .filter(
      (secret) =>
        secret.kind === "input" &&
        secret.provenance === "secretRef" &&
        (secret.refProvider === undefined ||
          secret.refSource === undefined ||
          !providerKeys.has(`${secret.refSource}:${secret.refProvider}`)),
    )
    .map((secret): HealthFinding => {
      return policyEvidenceFinding(secret, {
        checkId: CHECK_IDS.policySecretsUnmanagedProvider,
        message: `SecretRef uses unmanaged provider '${secret.refProvider ?? "default"}'.`,
        requirement: `oc://${policyDocName}/secrets/requireManagedProviders`,
        fixHint:
          "Declare the referenced provider under secrets.providers or update policy after review.",
      });
    });
}

function secretDeniedSourceFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const deniedSources = new Set(readStringList(policy, ["secrets", "denySources"]));
  if (deniedSources.size === 0) {
    return [];
  }
  return (evidence.secrets ?? [])
    .filter((secret) => {
      const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
      return source !== undefined && deniedSources.has(source);
    })
    .map((secret): HealthFinding => {
      const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
      return policyEvidenceFinding(secret, {
        checkId: CHECK_IDS.policySecretsDeniedProviderSource,
        message: `Secret ${secret.kind} '${secret.id}' uses denied source '${source}'.`,
        requirement: `oc://${policyDocName}/secrets/denySources`,
        fixHint: "Move this secret to an approved source or update policy after review.",
      });
    });
}

function authProfileMetadataFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const requiredMetadata = requiredAuthProfileMetadata(policy);
  if (requiredMetadata.size === 0) {
    return [];
  }
  return (evidence.authProfiles ?? []).flatMap((profile): HealthFinding[] => {
    const missing = [...requiredMetadata].filter(
      (metadata) => !authProfileHasMetadata(profile, metadata),
    );
    if (missing.length === 0) {
      return [];
    }
    return [
      policyEvidenceFinding(profile, {
        checkId: CHECK_IDS.policyAuthProfileInvalidMetadata,
        message: `Auth profile '${profile.id}' is missing required metadata: ${missing.join(", ")}.`,
        requirement: `oc://${policyDocName}/auth/profiles/requireMetadata`,
        fixHint: "Set auth.profiles.<id>.provider and a supported auth profile mode.",
      }),
    ];
  });
}

function authProfileModeFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const allowedModes = new Set(readStringList(policy, ["auth", "profiles", "allowModes"]));
  if (allowedModes.size === 0) {
    return [];
  }
  return (evidence.authProfiles ?? [])
    .filter((profile) => profile.mode !== undefined && !allowedModes.has(profile.mode))
    .map((profile): HealthFinding => {
      return policyEvidenceFinding(profile, {
        checkId: CHECK_IDS.policyAuthProfileUnapprovedMode,
        message: `Auth profile '${profile.id}' uses mode '${profile.mode}' outside the policy allowlist.`,
        requirement: `oc://${policyDocName}/auth/profiles/allowModes`,
        fixHint: "Change the auth profile mode or update policy after review.",
      });
    });
}
