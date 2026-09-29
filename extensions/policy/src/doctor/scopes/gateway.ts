// Policy doctor checks and findings for gateway exposure policy.
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import type { PolicyEvidence, PolicyGatewayExposureEvidence } from "../../policy-state-types.js";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import { policyEvidenceFinding } from "../policy-evidence-finding.js";
import { previewPolicyReviewRequiredRepair } from "../review-required-repairs.js";
import type { PolicyDoctorCheckDeps } from "../types.js";
import { readPolicyBoolean, readStringList } from "../utils.js";

export function createPolicyGatewayChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyGatewayNonLoopbackBind,
      "Gateway bind posture matches policy exposure requirements.",
      (ctx, findings) =>
        previewPolicyReviewRequiredRepair(ctx, findings, CHECK_IDS.policyGatewayNonLoopbackBind),
    ],
    [
      CHECK_IDS.policyGatewayAuthDisabled,
      "Gateway authentication remains enabled when required by policy.",
    ],
    [
      CHECK_IDS.policyGatewayRateLimitMissing,
      "Gateway authentication rate-limit posture is explicit when required by policy.",
    ],
    [
      CHECK_IDS.policyGatewayControlUiInsecure,
      "Gateway Control UI insecure exposure toggles remain disabled by policy.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyGatewayControlUiInsecure),
    ],
    [CHECK_IDS.policyGatewayTailscaleFunnel, "Gateway Tailscale Funnel exposure matches policy."],
    [
      CHECK_IDS.policyGatewayRemoteEnabled,
      "Remote gateway mode matches policy.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyGatewayRemoteEnabled),
    ],
    [
      CHECK_IDS.policyGatewayHttpEndpointEnabled,
      "Gateway HTTP API endpoints match policy.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyGatewayHttpEndpointEnabled),
    ],
    [
      CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
      "Gateway HTTP URL-fetch inputs have allowlists when required by policy.",
    ],
    [
      CHECK_IDS.policyGatewayNodeCommandDenied,
      "Gateway node command allowlists match policy.",
      (ctx, findings) =>
        previewPolicyReviewRequiredRepair(ctx, findings, CHECK_IDS.policyGatewayNodeCommandDenied),
    ],
  ]);
}

export function gatewayExposureFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const rules = [
    {
      path: ["exposure", "allowNonLoopbackBind"],
      enabled: false,
      violates: (entry) => entry.kind === "bind" && entry.nonLoopback === true,
      checkId: CHECK_IDS.policyGatewayNonLoopbackBind,
      message: (entry) =>
        entry.explicit === false
          ? "Gateway bind is omitted while the runtime default can permit non-loopback exposure."
          : `Gateway bind setting '${entry.id}' permits non-loopback exposure.`,
      fixHint: "Use gateway.bind=loopback or update policy after review.",
    },
    {
      path: ["auth", "requireAuth"],
      enabled: true,
      violates: (entry) => entry.kind === "auth" && entry.value === "none",
      checkId: CHECK_IDS.policyGatewayAuthDisabled,
      message: () => "Gateway authentication is disabled.",
      fixHint: "Set gateway.auth.mode to token, password, or trusted-proxy.",
    },
    {
      path: ["auth", "requireExplicitRateLimit"],
      enabled: true,
      violates: (entry) => entry.kind === "authRateLimit" && entry.explicit !== true,
      checkId: CHECK_IDS.policyGatewayRateLimitMissing,
      message: () => "Gateway authentication rate-limit posture is not explicit.",
      fixHint: "Configure gateway.auth.rateLimit or update policy after review.",
    },
    {
      path: ["controlUi", "allowInsecure"],
      enabled: false,
      violates: (entry) =>
        entry.kind === "controlUi" &&
        entry.value === true &&
        (entry.id === "gateway-control-ui-insecure-auth" ||
          entry.id === "gateway-control-ui-device-auth-disabled" ||
          entry.id === "gateway-control-ui-host-origin-fallback"),
      checkId: CHECK_IDS.policyGatewayControlUiInsecure,
      message: (entry) => `Gateway Control UI insecure toggle '${entry.id}' is enabled.`,
      fixHint: "Disable the insecure Control UI toggle or update policy after review.",
    },
    {
      path: ["exposure", "allowTailscaleFunnel"],
      enabled: false,
      violates: (entry) => entry.kind === "tailscale" && entry.value === "funnel",
      checkId: CHECK_IDS.policyGatewayTailscaleFunnel,
      message: () => "Gateway Tailscale Funnel exposure is enabled.",
      fixHint: "Use tailscale serve/off or update policy after review.",
    },
    {
      path: ["remote", "allow"],
      enabled: false,
      violates: (entry) => entry.kind === "remote",
      checkId: CHECK_IDS.policyGatewayRemoteEnabled,
      message: (entry) => `Gateway remote posture '${entry.id}' is enabled.`,
      fixHint: "Disable remote gateway mode/config or update policy after review.",
    },
  ] satisfies readonly {
    path: readonly string[];
    enabled: boolean;
    violates: (entry: PolicyGatewayExposureEvidence) => boolean;
    checkId: Parameters<typeof policyEvidenceFinding>[1]["checkId"];
    message: (entry: PolicyGatewayExposureEvidence) => string;
    fixHint: string;
  }[];
  // Preserve the diagnostic order used by policy attestations.
  return [
    ...rules.flatMap((rule) => {
      if (readPolicyBoolean(policy, ["gateway", ...rule.path]) !== rule.enabled) {
        return [];
      }
      return (evidence.gatewayExposure ?? []).filter(rule.violates).map((entry) =>
        policyEvidenceFinding(entry, {
          checkId: rule.checkId,
          message: rule.message(entry),
          requirement: `oc://${policyDocName}/gateway/${rule.path.join("/")}`,
          fixHint: rule.fixHint,
        }),
      );
    }),
    ...gatewayHttpEndpointFindings(policy, policyDocName, evidence),
    ...gatewayHttpUrlFetchFindings(policy, policyDocName, evidence),
    ...gatewayNodeCommandFindings(policy, policyDocName, evidence),
  ];
}

function gatewayHttpEndpointFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(
    readStringList(policy, ["gateway", "http", "denyEndpoints"]).map((endpoint) =>
      endpoint.toLowerCase(),
    ),
  );
  if (denied.size === 0) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter(
      (entry) =>
        entry.kind === "httpEndpoint" &&
        entry.endpoint !== undefined &&
        denied.has(entry.endpoint.toLowerCase()),
    )
    .map((entry): HealthFinding => {
      return policyEvidenceFinding(entry, {
        checkId: CHECK_IDS.policyGatewayHttpEndpointEnabled,
        message: `Gateway HTTP endpoint '${entry.endpoint ?? entry.id}' is denied by policy.`,
        requirement: `oc://${policyDocName}/gateway/http/denyEndpoints`,
        fixHint: "Disable the HTTP endpoint or update policy after review.",
      });
    });
}

function gatewayHttpUrlFetchFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "http", "requireUrlAllowlists"]) !== true) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "httpUrlFetch" && entry.hasAllowlist !== true)
    .map((entry): HealthFinding => {
      return policyEvidenceFinding(entry, {
        checkId: CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
        message: `Gateway HTTP URL-fetch input '${entry.id}' has no URL allowlist.`,
        requirement: `oc://${policyDocName}/gateway/http/requireUrlAllowlists`,
        fixHint: "Add a urlAllowlist for this URL-fetch input or update policy after review.",
      });
    });
}

function gatewayNodeCommandFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!hasValidOptionalStringList(policy, ["gateway", "nodes", "denyCommands"])) {
    return [];
  }
  const policyDenied = readStringList(policy, ["gateway", "nodes", "denyCommands"], {
    lowercase: false,
  });
  if (policyDenied.length === 0) {
    return [];
  }
  const configDenied = new Set(
    (evidence.gatewayExposure ?? [])
      .filter((entry) => entry.kind === "nodeDenyCommand" && entry.command !== undefined)
      .map((entry) => entry.command),
  );
  return policyDenied
    .filter((command) => !configDenied.has(command))
    .map((command): HealthFinding => {
      return policyEvidenceFinding(
        { source: "oc://openclaw.config/gateway/nodes/commands/deny" },
        {
          checkId: CHECK_IDS.policyGatewayNodeCommandDenied,
          message: `Gateway node command '${command}' is denied by policy but not denied by OpenClaw config.`,
          requirement: `oc://${policyDocName}/gateway/nodes/denyCommands`,
          fixHint: `Add '${command}' to gateway.nodes.commands.deny or update policy after review.`,
        },
      );
    });
}

function hasValidOptionalStringList(policy: unknown, path: readonly string[]): boolean {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return true;
    }
    current = current[part];
  }
  return (
    current === undefined ||
    (Array.isArray(current) &&
      current.every((entry) => typeof entry === "string" && entry.trim() !== ""))
  );
}
