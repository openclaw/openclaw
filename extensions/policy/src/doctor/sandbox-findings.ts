import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyEvidence, PolicySandboxPostureEvidence } from "../policy-state.js";
import { CHECK_IDS } from "./check-ids.js";
import { SANDBOX_CONTAINER_POLICY_RULES } from "./metadata.js";
import { policyEvidenceFinding as sandboxPostureFinding } from "./policy-evidence-finding.js";
import { agentScopedPolicyTargets, scopedAgentIdMatches } from "./policy-scope.js";
import { posturePolicyShapeFinding } from "./posture-shapes.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function sandboxPostureFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const sandboxPolicy = policy.sandbox;
  if (
    isRecord(sandboxPolicy) &&
    posturePolicyShapeFinding("sandbox", sandboxPolicy, { policyDocName, policyPath }) === undefined
  ) {
    findings.push(
      ...sandboxPostureFindingsForRule(
        sandboxPolicy,
        policyDocName,
        "sandbox",
        evidence,
        () => true,
      ),
    );
  }
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  for (const target of agentScopedPolicyTargets(policy)) {
    const scopedSandboxPolicy = target.overlay.sandbox;
    if (
      posturePolicyShapeFinding("sandbox", scopedSandboxPolicy, {
        policyDocName,
        policyPath,
        targetPrefix: `scopes/${ocPathSegment(target.scopeName)}/sandbox`,
        propertyPrefix: `scopes.${target.scopeName}.sandbox`,
      }) !== undefined ||
      !isRecord(scopedSandboxPolicy)
    ) {
      continue;
    }
    findings.push(
      ...sandboxPostureFindingsForRule(
        scopedSandboxPolicy,
        policyDocName,
        `scopes/${ocPathSegment(target.scopeName)}/sandbox`,
        evidence,
        (entry) => scopedSandboxAgentMatches(entry, target.agentId, evidence.sandboxPosture ?? []),
      ),
    );
  }
  return findings;
}

function sandboxPostureFindingsForRule(
  sandboxPolicy: Record<string, unknown> | undefined,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (!isRecord(sandboxPolicy)) {
    return [];
  }
  return [
    ...sandboxAllowlistFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerPostureUnobservableFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxBooleanPostureFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function scopedSandboxAgentMatches(
  entry: PolicySandboxPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicySandboxPostureEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return (
    entry.scope === "defaults" &&
    !scopedSandboxDefaultDisabledForAgent(entry, policyAgentId, entries) &&
    !entries.some(
      (candidate) =>
        candidate.scope === "agent" &&
        sandboxPostureEntriesDescribeSameField(candidate, entry) &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    )
  );
}

function scopedSandboxDefaultDisabledForAgent(
  entry: PolicySandboxPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicySandboxPostureEvidence[],
): boolean {
  if (sandboxEntryRequiresContainerBackend(entry)) {
    const backend = entries.find(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === "backend" &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    );
    if (typeof backend?.value === "string" && !isObservableContainerSandboxBackend(backend.value)) {
      return true;
    }
  }

  if (sandboxEntryRequiresBrowser(entry)) {
    const browser = entries.find(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === "browserCdpSourceRange" &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    );
    if (browser?.value === false) {
      return true;
    }
  }

  return false;
}

function sandboxEntryRequiresContainerBackend(entry: PolicySandboxPostureEvidence): boolean {
  return (
    (entry.kind === "containerNetwork" && entry.networkSurface === "docker") ||
    entry.kind === "containerSecurityProfile" ||
    (entry.kind === "containerMount" && entry.bindSurface === "docker")
  );
}

function sandboxEntryRequiresBrowser(entry: PolicySandboxPostureEvidence): boolean {
  return (
    entry.kind === "browserCdpSourceRange" ||
    (entry.kind === "containerNetwork" && entry.networkSurface === "browser") ||
    (entry.kind === "containerMount" && entry.bindSurface === "browser")
  );
}

function sandboxPostureEntriesDescribeSameField(
  candidate: PolicySandboxPostureEvidence,
  baseline: PolicySandboxPostureEvidence,
): boolean {
  return (
    candidate.kind === baseline.kind &&
    candidate.bindSurface === baseline.bindSurface &&
    candidate.networkSurface === baseline.networkSurface &&
    candidate.profile === baseline.profile
  );
}

function sandboxAllowlistFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  // Keep mode before backend: finding order is part of the policy attestation.
  return (
    [
      {
        kind: "mode",
        key: "requireMode",
        checkId: CHECK_IDS.policySandboxModeUnapproved,
        fixHint:
          "Set agents.defaults.sandbox.mode or agents.entries.<id>.sandbox.mode to an approved value.",
      },
      {
        kind: "backend",
        key: "allowBackends",
        checkId: CHECK_IDS.policySandboxBackendUnapproved,
        fixHint: "Use an approved sandbox backend or update policy after review.",
      },
    ] as const
  ).flatMap((rule) => {
    const allowed = new Set(readStringList(sandboxPolicy, [rule.key]));
    if (allowed.size === 0) {
      return [];
    }
    return sandboxPostureEntries(evidence, rule.kind)
      .filter(evidenceFilter)
      .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
      .map((entry) =>
        sandboxPostureFinding(entry, {
          checkId: rule.checkId,
          message: `${sandboxPostureLabel(entry)} uses unapproved sandbox ${rule.kind} '${entry.value ?? ""}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/${rule.key}`,
          fixHint: rule.fixHint,
        }),
      );
  });
}

function isObservableContainerSandboxBackend(value: string): boolean {
  return value.toLowerCase() === "docker" || value.toLowerCase() === "podman";
}

function sandboxContainerPostureUnobservableFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const enabledRules = SANDBOX_CONTAINER_POLICY_RULES.filter(
    (rule) => readPolicyBoolean(sandboxPolicy, ["containers", rule.key]) === true,
  );
  if (enabledRules.length === 0) {
    return [];
  }
  return sandboxPostureEntries(evidence, "backend")
    .filter(evidenceFilter)
    .filter(
      (entry) =>
        typeof entry.value === "string" && !isObservableContainerSandboxBackend(entry.value),
    )
    .flatMap((entry) =>
      enabledRules.map((rule) =>
        sandboxPostureFinding(entry, {
          checkId: CHECK_IDS.policySandboxContainerPostureUnobservable,
          message: `${sandboxPostureLabel(entry)} uses sandbox backend '${entry.value ?? ""}', which cannot observe ${rule.label}.`,
          requirement: `oc://${policyDocName}/${requirementBase}/containers/${rule.key}`,
          fixHint:
            "Use an observable container backend for this sandbox or remove the container posture rule.",
        }),
      ),
    );
}

function sandboxBooleanPostureFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  // Rule order is part of the policy attestation.
  const rules = [
    {
      path: ["containers", "denyHostNetwork"],
      kind: "containerNetwork",
      violates: (entry) => typeof entry.value === "string" && entry.value.toLowerCase() === "host",
      checkId: CHECK_IDS.policySandboxContainerHostNetworkDenied,
      message: (entry) => `${sandboxPostureLabel(entry)} uses host container network mode.`,
      fixHint: "Change the container network mode or update policy after review.",
    },
    {
      path: ["containers", "denyContainerNamespaceJoin"],
      kind: "containerNetwork",
      violates: (entry) =>
        typeof entry.value === "string" && entry.value.toLowerCase().startsWith("container:"),
      checkId: CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
      message: (entry) =>
        `${sandboxPostureLabel(entry)} joins another container network namespace '${entry.value ?? ""}'.`,
      fixHint: "Change the container network mode or update policy after review.",
    },
    {
      path: ["containers", "requireReadOnlyMounts"],
      kind: "containerMount",
      violates: (entry) => entry.bindMode !== "ro",
      checkId: CHECK_IDS.policySandboxContainerMountModeRequired,
      message: (entry) =>
        `${sandboxPostureLabel(entry)} has container mount '${entry.bind ?? ""}' with mode '${entry.bindMode ?? "unknown"}'.`,
      fixHint: "Set the mount mode to read-only or update policy after review.",
    },
    {
      path: ["containers", "denyContainerRuntimeSocketMounts"],
      kind: "containerMount",
      violates: (entry) => bindHostLooksLikeContainerRuntimeSocket(entry.bindHost),
      checkId: CHECK_IDS.policySandboxContainerRuntimeSocketMount,
      message: (entry) =>
        `${sandboxPostureLabel(entry)} binds host container runtime socket '${entry.bindHost ?? ""}'.`,
      fixHint: "Remove the container runtime socket bind or update policy after review.",
    },
    {
      path: ["containers", "denyUnconfinedProfiles"],
      kind: "containerSecurityProfile",
      violates: (entry) =>
        typeof entry.value === "string" && entry.value.toLowerCase() === "unconfined",
      checkId: CHECK_IDS.policySandboxContainerUnconfinedProfile,
      message: (entry) =>
        `${sandboxPostureLabel(entry)} sets container ${entry.profile ?? "security"} profile to unconfined.`,
      fixHint: "Remove the unconfined container profile or update policy after review.",
    },
    {
      path: ["browser", "requireCdpSourceRange"],
      kind: "browserCdpSourceRange",
      violates: (entry) => entry.value === undefined,
      checkId: CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
      message: (entry) =>
        `${sandboxPostureLabel(entry)} enables sandbox browser without cdpSourceRange.`,
      fixHint: "Set agents.*.sandbox.browser.cdpSourceRange or update policy after review.",
    },
  ] satisfies readonly {
    path: readonly string[];
    kind: PolicySandboxPostureEvidence["kind"];
    violates: (entry: PolicySandboxPostureEvidence) => boolean;
    checkId: Parameters<typeof sandboxPostureFinding>[1]["checkId"];
    message: (entry: PolicySandboxPostureEvidence) => string;
    fixHint: string;
  }[];
  return rules.flatMap((rule) => {
    if (readPolicyBoolean(sandboxPolicy, rule.path) !== true) {
      return [];
    }
    return sandboxPostureEntries(evidence, rule.kind)
      .filter(evidenceFilter)
      .filter(rule.violates)
      .map((entry) =>
        sandboxPostureFinding(entry, {
          checkId: rule.checkId,
          message: rule.message(entry),
          requirement: `oc://${policyDocName}/${requirementBase}/${rule.path.join("/")}`,
          fixHint: rule.fixHint,
        }),
      );
  });
}

function sandboxPostureEntries(
  evidence: PolicyEvidence,
  kind: PolicySandboxPostureEvidence["kind"],
): readonly PolicySandboxPostureEvidence[] {
  return (evidence.sandboxPosture ?? []).filter((entry) => entry.kind === kind);
}

function sandboxPostureLabel(entry: PolicySandboxPostureEvidence): string {
  return entry.agentId === undefined ? "default sandbox config" : `agent '${entry.agentId}'`;
}

const CONTAINER_RUNTIME_SOCKET_BASENAMES = new Set([
  "containerd.sock",
  "docker.sock",
  "podman.sock",
]);

const CONTAINER_RUNTIME_SOCKET_PATHS = new Set([
  "/run/containerd/containerd.sock",
  "/run/docker.sock",
  "/run/podman/podman.sock",
  "/var/run/docker.sock",
  "/var/run/podman/podman.sock",
]);

function bindHostLooksLikeContainerRuntimeSocket(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const basenameLocal = normalized.split("/").at(-1) ?? "";
  return (
    CONTAINER_RUNTIME_SOCKET_PATHS.has(normalized) ||
    CONTAINER_RUNTIME_SOCKET_BASENAMES.has(basenameLocal)
  );
}
