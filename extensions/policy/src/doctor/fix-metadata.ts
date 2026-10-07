import { EXEC_APPROVALS_POLICY_DOCUMENT_NAME } from "../exec-approvals-uri.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { POLICY_RULE_METADATA } from "./metadata.js";

type PolicyFixClass = "automatic" | "reviewRequired" | "manual" | "unsupported";

type PolicyFixMetadata = {
  readonly checkId: (typeof POLICY_CHECK_IDS)[number];
  readonly fixClass: PolicyFixClass;
  readonly policyPath?: readonly string[];
  readonly configTargets?: readonly string[];
  readonly summary: string;
};

const m = (
  checkId: (typeof POLICY_CHECK_IDS)[number],
  fixClass: PolicyFixClass,
  summary: string,
  configTargets?: readonly string[],
  policyPath = POLICY_RULE_METADATA.find((rule) => rule.checkIds.includes(checkId))?.policyPath,
): PolicyFixMetadata => {
  return {
    checkId,
    fixClass,
    summary,
    ...(policyPath === undefined ? {} : { policyPath }),
    ...(configTargets === undefined ? {} : { configTargets }),
  };
};

const POLICY_FIX_METADATA = [
  m(CHECK_IDS.policyMissingFile, "manual", "Restore or author the approved policy artifact."),
  m(CHECK_IDS.policyInvalidFile, "manual", "Repair the policy JSONC syntax or schema."),
  m(
    CHECK_IDS.policyUnmigratedToolsFile,
    "manual",
    "Run openclaw doctor --fix to migrate governed tool declarations into AGENTS.md.",
  ),
  m(
    CHECK_IDS.policyHashMismatch,
    "manual",
    "Restore the approved artifact or update the expected hash after review.",
    ["plugins.entries.policy.config.expectedHash"],
  ),
  m(
    CHECK_IDS.policyAttestationMismatch,
    "manual",
    "Review the current attestation and update accepted hashes after approval.",
    ["plugins.entries.policy.config.expectedAttestationHash"],
  ),
  m(
    CHECK_IDS.policyDeniedChannelProvider,
    "automatic",
    "Disable product-managed channels matching the denied provider.",
    ["channels"],
  ),
  m(CHECK_IDS.policyDeniedMcpServer, "reviewRequired", "Remove or disable the denied MCP server.", [
    "mcp.servers",
  ]),
  m(
    CHECK_IDS.policyUnapprovedMcpServer,
    "reviewRequired",
    "Remove the unapproved MCP server or select an approved replacement.",
    ["mcp.servers"],
  ),
  m(
    CHECK_IDS.policyDeniedModelProvider,
    "reviewRequired",
    "Remove the model provider or switch references to an approved provider.",
    ["models"],
  ),
  m(
    CHECK_IDS.policyUnapprovedModelProvider,
    "reviewRequired",
    "Select an approved model provider.",
    ["models"],
  ),
  m(
    CHECK_IDS.policyPrivateNetworkAccess,
    "reviewRequired",
    "Disable the concrete private-network access opt-in.",
    ["network"],
  ),
  m(
    CHECK_IDS.policyRoutingBindingsRequired,
    "reviewRequired",
    "Add an intentional channel route binding or revise the policy after review.",
    ["bindings"],
  ),
  m(
    CHECK_IDS.policyRoutingBindingChannelUnconfigured,
    "reviewRequired",
    "Correct the binding channel or configure the intended channel after review.",
    ["bindings", "channels"],
  ),
  m(
    CHECK_IDS.policyRoutingAgentMismatch,
    "reviewRequired",
    "Review binding precedence and the expected agent before changing message delivery.",
    ["bindings"],
  ),
  m(
    CHECK_IDS.policyRoutingMatchKindMismatch,
    "reviewRequired",
    "Restore the intended binding specificity or approve the new match kind.",
    ["bindings"],
  ),
  m(
    CHECK_IDS.policyIngressDmPolicyUnapproved,
    "reviewRequired",
    "Set channel DM policy to an allowed value.",
    ["channels"],
  ),
  m(
    CHECK_IDS.policyIngressDmScopeUnapproved,
    "reviewRequired",
    "Move session DM scope to the required or stricter ordered value.",
    ["ingress"],
  ),
  m(
    CHECK_IDS.policyIngressOpenGroupsDenied,
    "automatic",
    "Disable product-managed open group ingress.",
    ["channels"],
  ),
  m(
    CHECK_IDS.policyIngressGroupMentionRequired,
    "automatic",
    "Require mention in product-managed group channels.",
    ["channels"],
  ),
  m(
    CHECK_IDS.policyGatewayNonLoopbackBind,
    "reviewRequired",
    "Set gateway bind address to loopback when remote exposure is not intended.",
    ["gateway.bind"],
  ),
  m(
    CHECK_IDS.policyGatewayAuthDisabled,
    "manual",
    "Configure token, password, or trusted-proxy auth.",
    ["gateway.auth"],
  ),
  m(
    CHECK_IDS.policyGatewayRateLimitMissing,
    "reviewRequired",
    "Add explicit gateway auth rate limits from product defaults.",
    ["gateway.auth.rateLimit"],
  ),
  m(
    CHECK_IDS.policyGatewayControlUiInsecure,
    "automatic",
    "Disable the insecure Control UI toggle.",
    ["gateway.controlUi"],
  ),
  m(
    CHECK_IDS.policyGatewayTailscaleFunnel,
    "reviewRequired",
    "Disable Tailscale funnel or serve exposure.",
    ["tailscale"],
  ),
  m(
    CHECK_IDS.policyGatewayRemoteEnabled,
    "automatic",
    "Disable product-managed remote gateway mode.",
    ["gateway.remote"],
  ),
  m(
    CHECK_IDS.policyGatewayHttpEndpointEnabled,
    "automatic",
    "Disable denied Gateway HTTP endpoints.",
    ["gateway.http"],
  ),
  m(
    CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
    "manual",
    "Add URL allowlists for each URL-fetch input.",
    ["gateway.http"],
  ),
  m(
    CHECK_IDS.policyGatewayNodeCommandDenied,
    "reviewRequired",
    "Add the command to gateway node denyCommands or update policy after review.",
    ["gateway.nodes.commands.deny"],
  ),
  m(
    CHECK_IDS.policyAgentsWorkspaceAccessDenied,
    "reviewRequired",
    "Set agent workspace access to an allowed mode.",
    ["agents"],
  ),
  m(
    CHECK_IDS.policyAgentsToolNotDenied,
    "automatic",
    "Merge required built-in workspace tool denies.",
    ["agents"],
  ),
  m(
    CHECK_IDS.policyToolsProfileUnapproved,
    "reviewRequired",
    "Set the tool profile to an allowed profile.",
    ["tools.profile"],
  ),
  m(
    CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
    "reviewRequired",
    "Set workspace-only filesystem posture when required assets remain readable.",
    ["tools.fs.workspaceOnly"],
  ),
  m(
    CHECK_IDS.policyToolsExecSecurityUnapproved,
    "reviewRequired",
    "Set exec security to an allowed value.",
    ["tools.exec.security"],
  ),
  m(
    CHECK_IDS.policyToolsExecAskUnapproved,
    "reviewRequired",
    "Set exec ask mode to an allowed value.",
    ["tools.exec.ask"],
  ),
  m(
    CHECK_IDS.policyToolsExecHostUnapproved,
    "reviewRequired",
    "Move exec host to an allowed host mode.",
    ["tools.exec.host"],
  ),
  m(CHECK_IDS.policyToolsElevatedEnabled, "automatic", "Set tools elevated mode to disabled.", [
    "tools.elevated.enabled",
  ]),
  m(
    CHECK_IDS.policyToolsAlsoAllowMissing,
    "reviewRequired",
    "Add expected alsoAllow entries only when policy intentionally grants them.",
    ["tools.alsoAllow"],
  ),
  m(
    CHECK_IDS.policyToolsAlsoAllowUnexpected,
    "reviewRequired",
    "Remove unexpected alsoAllow entries.",
    ["tools.alsoAllow"],
  ),
  m(
    CHECK_IDS.policyToolsRequiredDenyMissing,
    "automatic",
    "Merge required built-in deny tool classes.",
    ["tools.deny", "agents.entries.<id>.tools.deny"],
  ),
  m(
    CHECK_IDS.policySandboxModeUnapproved,
    "reviewRequired",
    "Set sandbox mode to an allowed value.",
    ["sandbox.mode"],
  ),
  m(
    CHECK_IDS.policySandboxBackendUnapproved,
    "reviewRequired",
    "Choose an approved sandbox backend that is installed.",
    ["sandbox.backend"],
  ),
  m(
    CHECK_IDS.policySandboxContainerPostureUnobservable,
    "unsupported",
    "Add observable container posture evidence before patching.",
  ),
  m(
    CHECK_IDS.policySandboxContainerHostNetworkDenied,
    "reviewRequired",
    "Disable container host networking.",
    ["sandbox.containers"],
  ),
  m(
    CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
    "reviewRequired",
    "Disable joining container namespaces.",
    ["sandbox.containers"],
  ),
  m(
    CHECK_IDS.policySandboxContainerMountModeRequired,
    "reviewRequired",
    "Change required mounts to read-only.",
    ["sandbox.containers"],
  ),
  m(
    CHECK_IDS.policySandboxContainerRuntimeSocketMount,
    "reviewRequired",
    "Remove container runtime socket binds.",
    ["sandbox.containers"],
  ),
  m(
    CHECK_IDS.policySandboxContainerUnconfinedProfile,
    "reviewRequired",
    "Remove unconfined container profiles.",
    ["sandbox.containers"],
  ),
  m(
    CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
    "manual",
    "Add an explicit browser CDP source range.",
    ["agents.sandbox.browser"],
  ),
  m(
    CHECK_IDS.policyDataHandlingTelemetryContentCapture,
    "automatic",
    "Disable telemetry content capture.",
    ["diagnostics.otel.captureContent"],
  ),
  m(
    CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
    "reviewRequired",
    "Set session maintenance to enforced mode.",
    ["session.maintenance.mode"],
  ),
  m(
    CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
    "reviewRequired",
    "Disable transcript indexing for the affected agent scope.",
    ["memory"],
  ),
  m(
    CHECK_IDS.policySecretsUnmanagedProvider,
    "manual",
    "Migrate the secret to a managed provider.",
    ["secrets"],
  ),
  m(
    CHECK_IDS.policySecretsDeniedProviderSource,
    "reviewRequired",
    "Move the secret out of the denied source.",
    ["secrets"],
  ),
  m(
    CHECK_IDS.policySecretsInsecureProvider,
    "reviewRequired",
    "Remove insecure provider overrides.",
    ["secrets"],
  ),
  m(
    CHECK_IDS.policyAuthProfileInvalidMetadata,
    "manual",
    "Add required provider and mode metadata to auth profiles.",
    ["auth.profiles"],
  ),
  m(
    CHECK_IDS.policyAuthProfileUnapprovedMode,
    "manual",
    "Change auth mode and credentials through the auth owner flow.",
    ["auth.profiles"],
  ),
  m(
    CHECK_IDS.policyExecApprovalsMissing,
    "manual",
    "Restore an attributable exec-approvals evidence file.",
    [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
  ),
  m(CHECK_IDS.policyExecApprovalsInvalid, "manual", "Repair the exec approvals evidence artifact."),
  m(
    CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
    "manual",
    "Update reviewed default approval evidence or policy.",
    [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
  ),
  m(
    CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
    "manual",
    "Update reviewed agent approval evidence or policy.",
    [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
  ),
  m(
    CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
    "reviewRequired",
    "Disable auto-allow skills in the approval owner surface.",
    [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
  ),
  m(
    CHECK_IDS.policyExecApprovalsAllowlistMissing,
    "manual",
    "Add expected approval patterns through approval review.",
    [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
  ),
  m(
    CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
    "manual",
    "Remove unexpected approval patterns through approval review.",
    [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
  ),
  m(
    CHECK_IDS.policyMissingToolRisk,
    "manual",
    "Add tool risk metadata in the owning tool declaration.",
    ["tools"],
  ),
  m(
    CHECK_IDS.policyUnknownToolRisk,
    "manual",
    "Use a supported tool risk level.",
    ["tools"],
    ["tools", "requireMetadata"],
  ),
  m(
    CHECK_IDS.policyMissingToolSensitivity,
    "manual",
    "Add tool sensitivity metadata in the owning tool declaration.",
    ["tools"],
  ),
  m(
    CHECK_IDS.policyMissingToolOwner,
    "manual",
    "Add owner metadata in the owning tool declaration.",
    ["tools"],
  ),
  m(
    CHECK_IDS.policyUnknownToolSensitivity,
    "manual",
    "Use a supported tool sensitivity token.",
    ["tools"],
    ["tools", "requireMetadata"],
  ),
] as const satisfies readonly PolicyFixMetadata[];

export const POLICY_FIX_METADATA_BY_CHECK_ID = new Map(
  POLICY_FIX_METADATA.map((rule) => [rule.checkId, rule] as const),
);
