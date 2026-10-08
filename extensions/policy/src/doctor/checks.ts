import type { HealthCheck, HealthFinding, HealthRepairContext } from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "./automatic-repairs.js";
import { CHECK_IDS, type POLICY_CHECK_IDS } from "./check-ids.js";
import { evaluatePolicy } from "./evaluation.js";
import {
  channelIdsFromFindings,
  disableChannels,
  workspaceRepairsEnabled,
} from "./policy-runtime.js";
import { previewPolicyReviewRequiredRepair } from "./review-required-repairs.js";

type PolicyDoctorCheckDefinition = readonly [
  id: (typeof POLICY_CHECK_IDS)[number],
  description: string,
  repair?: (
    ctx: HealthRepairContext,
    findings: readonly HealthFinding[],
    checkId: (typeof POLICY_CHECK_IDS)[number],
  ) => ReturnType<NonNullable<HealthCheck["repair"]>>,
];

export function createPolicyDoctorChecks(): readonly HealthCheck[] {
  const definitions: readonly PolicyDoctorCheckDefinition[] = [
    [CHECK_IDS.policyMissingFile, "The enabled Policy plugin has a policy file to verify."],
    [CHECK_IDS.policyInvalidFile, "The enabled policy file parses before policy checks run."],
    [CHECK_IDS.policyHashMismatch, "The policy file matches the configured expected hash."],
    [
      CHECK_IDS.policyAttestationMismatch,
      "The current policy check matches the accepted attestation.",
    ],
    [
      CHECK_IDS.policyDeniedChannelProvider,
      "Configured channels satisfy policy deny rules.",
      async (ctx, findings) => {
        if (!workspaceRepairsEnabled(ctx)) {
          return {
            status: "skipped",
            reason: "workspace repairs are disabled",
            changes: [],
            warnings: [
              "Skipped channel config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.",
            ],
          };
        }
        const channelIds = channelIdsFromFindings(findings);
        if (channelIds.length === 0) {
          return {
            status: "skipped",
            reason: "no channel findings matched a configurable channel",
            changes: [],
          };
        }
        const next = disableChannels(ctx.cfg, channelIds);
        if (next.changed.length === 0) {
          return {
            status: "skipped",
            reason: "matching channels were already disabled or missing",
            changes: [],
          };
        }
        return {
          config: next.config,
          changes: next.changed.map(
            (id) => `Disabled channels.${id}.enabled for policy conformance.`,
          ),
        };
      },
    ],
    [CHECK_IDS.policyDeniedMcpServer, "Configured MCP servers do not match policy deny rules."],
    [
      CHECK_IDS.policyUnapprovedMcpServer,
      "Configured MCP servers do not match policy allow rules.",
    ],
    [
      CHECK_IDS.policyDeniedModelProvider,
      "Configured model providers do not match policy deny rules.",
    ],
    [
      CHECK_IDS.policyUnapprovedModelProvider,
      "Configured model providers do not match policy allow rules.",
    ],
    [
      CHECK_IDS.policyPrivateNetworkAccess,
      "Network SSRF policy settings match private-network requirements.",
    ],
    [
      CHECK_IDS.policyIngressDmPolicyUnapproved,
      "Channel direct-message access policy matches ingress requirements.",
    ],
    [
      CHECK_IDS.policyIngressDmScopeUnapproved,
      "Direct-message sessions use the policy-required isolation scope.",
    ],
    [
      CHECK_IDS.policyIngressOpenGroupsDenied,
      "Channel group access does not use open group policy when denied.",
      repairPolicyAutomaticNarrower,
    ],
    [
      CHECK_IDS.policyIngressGroupMentionRequired,
      "Channel group access keeps mention gates enabled when required.",
      repairPolicyAutomaticNarrower,
    ],
    [
      CHECK_IDS.policyRoutingBindingsRequired,
      "Routing policy has at least one channel route binding when required.",
    ],
    [
      CHECK_IDS.policyRoutingBindingChannelUnconfigured,
      "Route bindings name channels present in configuration.",
    ],
    [
      CHECK_IDS.policyRoutingAgentMismatch,
      "Authored routing checks resolve to their expected agents.",
    ],
    [
      CHECK_IDS.policyRoutingMatchKindMismatch,
      "Authored routing checks match at their expected specificity.",
    ],
    [
      CHECK_IDS.policyGatewayNonLoopbackBind,
      "Gateway bind posture matches policy exposure requirements.",
      previewPolicyReviewRequiredRepair,
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
      repairPolicyAutomaticNarrower,
    ],
    [CHECK_IDS.policyGatewayTailscaleFunnel, "Gateway Tailscale Funnel exposure matches policy."],
    [
      CHECK_IDS.policyGatewayRemoteEnabled,
      "Remote gateway mode matches policy.",
      repairPolicyAutomaticNarrower,
    ],
    [
      CHECK_IDS.policyGatewayHttpEndpointEnabled,
      "Gateway HTTP API endpoints match policy.",
      repairPolicyAutomaticNarrower,
    ],
    [
      CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
      "Gateway HTTP URL-fetch inputs have allowlists when required by policy.",
    ],
    [
      CHECK_IDS.policyGatewayNodeCommandDenied,
      "Gateway node command allowlists match policy.",
      previewPolicyReviewRequiredRepair,
    ],
    [CHECK_IDS.policyAgentsWorkspaceAccessDenied, "Agent sandbox workspace access matches policy."],
    [
      CHECK_IDS.policyAgentsToolNotDenied,
      "Agent workspace mutation/runtime tools are denied when policy requires it.",
      repairPolicyAutomaticNarrower,
    ],
    [CHECK_IDS.policyToolsProfileUnapproved, "Configured tool profiles match policy allow rules."],
    [
      CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
      "Filesystem tools use workspace-only posture when policy requires it.",
    ],
    [
      CHECK_IDS.policyToolsExecSecurityUnapproved,
      "Exec tool security mode matches policy allow rules.",
    ],
    [CHECK_IDS.policyToolsExecAskUnapproved, "Exec tool ask mode matches policy allow rules."],
    [CHECK_IDS.policyToolsExecHostUnapproved, "Exec tool host routing matches policy allow rules."],
    [
      CHECK_IDS.policyToolsElevatedEnabled,
      "Elevated tool mode remains disabled when policy requires it.",
      repairPolicyAutomaticNarrower,
    ],
    [
      CHECK_IDS.policyToolsAlsoAllowMissing,
      "Configured tools.alsoAllow entries include policy expected lists.",
    ],
    [
      CHECK_IDS.policyToolsAlsoAllowUnexpected,
      "Configured tools.alsoAllow entries match policy expected lists.",
    ],
    [
      CHECK_IDS.policyToolsRequiredDenyMissing,
      "Configured tool deny lists include tools required by policy.",
      repairPolicyAutomaticNarrower,
    ],
    [CHECK_IDS.policySandboxModeUnapproved, "Sandbox mode config satisfies policy requirements."],
    [
      CHECK_IDS.policySandboxBackendUnapproved,
      "Sandbox backend config satisfies policy requirements.",
    ],
    [
      CHECK_IDS.policySandboxContainerPostureUnobservable,
      "Sandbox container posture policy only targets observable container backends.",
    ],
    [
      CHECK_IDS.policySandboxContainerHostNetworkDenied,
      "Sandbox container config avoids host network mode.",
    ],
    [
      CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
      "Sandbox container config avoids joining another container network namespace.",
    ],
    [
      CHECK_IDS.policySandboxContainerMountModeRequired,
      "Sandbox container mounts are read-only when policy requires it.",
    ],
    [
      CHECK_IDS.policySandboxContainerRuntimeSocketMount,
      "Sandbox container mounts avoid host container runtime sockets.",
    ],
    [
      CHECK_IDS.policySandboxContainerUnconfinedProfile,
      "Sandbox container profile config avoids unconfined profiles.",
    ],
    [
      CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
      "Sandbox browser CDP config includes a source range when policy requires it.",
    ],
    [
      CHECK_IDS.policyDataHandlingTelemetryContentCapture,
      "Telemetry content capture remains disabled when policy denies it.",
      repairPolicyAutomaticNarrower,
    ],
    [
      CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
      "Session retention maintenance is enforced when policy requires it.",
    ],
    [
      CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
      "Session transcript memory indexing remains disabled when policy denies it.",
    ],
    [
      CHECK_IDS.policySecretsUnmanagedProvider,
      "OpenClaw config SecretRefs use configured secret providers when policy requires managed providers.",
    ],
    [
      CHECK_IDS.policySecretsDeniedProviderSource,
      "OpenClaw config secret providers and SecretRefs do not use sources denied by policy.",
    ],
    [
      CHECK_IDS.policySecretsInsecureProvider,
      "Configured secret providers do not opt into insecure posture unless policy allows it.",
    ],
    [
      CHECK_IDS.policyAuthProfileInvalidMetadata,
      "OpenClaw config auth profiles declare required provider and mode metadata.",
    ],
    [
      CHECK_IDS.policyAuthProfileUnapprovedMode,
      "OpenClaw config auth profile modes stay within the policy allowlist.",
    ],
    [
      CHECK_IDS.policyExecApprovalsMissing,
      "Required exec approvals artifact is present for policy conformance.",
    ],
    [
      CHECK_IDS.policyExecApprovalsInvalid,
      "Exec approvals artifact parses before policy checks run.",
    ],
    [
      CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
      "Exec approval defaults use a policy-approved security mode.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
      "Per-agent exec approval settings use policy-approved security modes.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
      "Exec approval agents do not implicitly auto-allow skill CLIs unless policy allows it.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAllowlistMissing,
      "Exec approval allowlists include every pattern required by policy.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
      "Exec approval allowlists do not contain patterns outside policy.",
    ],
    [
      CHECK_IDS.policyUnmigratedToolsFile,
      "Governed tool declarations have been migrated from TOOLS.md into AGENTS.md.",
    ],
    [
      CHECK_IDS.policyMissingToolRisk,
      "AGENTS.md tool policy entries declare explicit risk levels.",
    ],
    [CHECK_IDS.policyUnknownToolRisk, "AGENTS.md tool policy entries use known risk levels."],
    [
      CHECK_IDS.policyMissingToolSensitivity,
      "AGENTS.md tool policy entries declare default artifact sensitivity.",
    ],
    [
      CHECK_IDS.policyMissingToolOwner,
      "AGENTS.md tool policy entries declare an accountable owner.",
    ],
    [
      CHECK_IDS.policyUnknownToolSensitivity,
      "AGENTS.md tool policy entries use known sensitivity levels.",
    ],
  ];
  return definitions.map(([id, description, repair]) => {
    const check: HealthCheck = {
      id,
      kind: "plugin",
      description,
      source: "policy",
      async detect(ctx) {
        const evaluation = await evaluatePolicy(ctx);
        return evaluation.findings.filter((finding) => finding.checkId === id);
      },
    };
    if (repair) {
      check.repair = (ctx, findings) => repair(ctx, findings, id);
    }
    return check;
  });
}
