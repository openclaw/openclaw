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
  options: Omit<PolicyFixMetadata, "checkId" | "fixClass" | "summary"> = {},
): PolicyFixMetadata => {
  const policyPath = POLICY_RULE_METADATA.find((rule) =>
    rule.checkIds.includes(checkId),
  )?.policyPath;
  return {
    checkId,
    fixClass,
    summary,
    ...(policyPath === undefined ? {} : { policyPath }),
    ...options,
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
    { configTargets: ["plugins.entries.policy.config.expectedHash"] },
  ),
  m(
    CHECK_IDS.policyAttestationMismatch,
    "manual",
    "Review the current attestation and update accepted hashes after approval.",
    { configTargets: ["plugins.entries.policy.config.expectedAttestationHash"] },
  ),
  m(
    CHECK_IDS.policyDeniedChannelProvider,
    "automatic",
    "Disable product-managed channels matching the denied provider.",
    { configTargets: ["channels"] },
  ),
  m(CHECK_IDS.policyDeniedMcpServer, "reviewRequired", "Remove or disable the denied MCP server.", {
    configTargets: ["mcp.servers"],
  }),
  m(
    CHECK_IDS.policyUnapprovedMcpServer,
    "reviewRequired",
    "Remove the unapproved MCP server or select an approved replacement.",
    { configTargets: ["mcp.servers"] },
  ),
  m(
    CHECK_IDS.policyDeniedModelProvider,
    "reviewRequired",
    "Remove the model provider or switch references to an approved provider.",
    { configTargets: ["models"] },
  ),
  m(
    CHECK_IDS.policyUnapprovedModelProvider,
    "reviewRequired",
    "Select an approved model provider.",
    { configTargets: ["models"] },
  ),
  m(
    CHECK_IDS.policyPrivateNetworkAccess,
    "reviewRequired",
    "Disable the concrete private-network access opt-in.",
    { configTargets: ["network"] },
  ),
  m(
    CHECK_IDS.policyRoutingBindingsRequired,
    "reviewRequired",
    "Add an intentional channel route binding or revise the policy after review.",
    { configTargets: ["bindings"] },
  ),
  m(
    CHECK_IDS.policyRoutingBindingChannelUnconfigured,
    "reviewRequired",
    "Correct the binding channel or configure the intended channel after review.",
    {
      configTargets: ["bindings", "channels"],
    },
  ),
  m(
    CHECK_IDS.policyRoutingAgentMismatch,
    "reviewRequired",
    "Review binding precedence and the expected agent before changing message delivery.",
    { configTargets: ["bindings"] },
  ),
  m(
    CHECK_IDS.policyRoutingMatchKindMismatch,
    "reviewRequired",
    "Restore the intended binding specificity or approve the new match kind.",
    { configTargets: ["bindings"] },
  ),
  m(
    CHECK_IDS.policyIngressDmPolicyUnapproved,
    "reviewRequired",
    "Set channel DM policy to an allowed value.",
    { configTargets: ["channels"] },
  ),
  m(
    CHECK_IDS.policyIngressDmScopeUnapproved,
    "reviewRequired",
    "Move session DM scope to the required or stricter ordered value.",
    { configTargets: ["ingress"] },
  ),
  m(
    CHECK_IDS.policyIngressOpenGroupsDenied,
    "automatic",
    "Disable product-managed open group ingress.",
    { configTargets: ["channels"] },
  ),
  m(
    CHECK_IDS.policyIngressGroupMentionRequired,
    "automatic",
    "Require mention in product-managed group channels.",
    { configTargets: ["channels"] },
  ),
  m(
    CHECK_IDS.policyGatewayNonLoopbackBind,
    "reviewRequired",
    "Set gateway bind address to loopback when remote exposure is not intended.",
    {
      configTargets: ["gateway.bind"],
    },
  ),
  m(
    CHECK_IDS.policyGatewayAuthDisabled,
    "manual",
    "Configure token, password, or trusted-proxy auth.",
    { configTargets: ["gateway.auth"] },
  ),
  m(
    CHECK_IDS.policyGatewayRateLimitMissing,
    "reviewRequired",
    "Add explicit gateway auth rate limits from product defaults.",
    {
      configTargets: ["gateway.auth.rateLimit"],
    },
  ),
  m(
    CHECK_IDS.policyGatewayControlUiInsecure,
    "automatic",
    "Disable the insecure Control UI toggle.",
    { configTargets: ["gateway.controlUi"] },
  ),
  m(
    CHECK_IDS.policyGatewayTailscaleFunnel,
    "reviewRequired",
    "Disable Tailscale funnel or serve exposure.",
    { configTargets: ["tailscale"] },
  ),
  m(
    CHECK_IDS.policyGatewayRemoteEnabled,
    "automatic",
    "Disable product-managed remote gateway mode.",
    { configTargets: ["gateway.remote"] },
  ),
  m(
    CHECK_IDS.policyGatewayHttpEndpointEnabled,
    "automatic",
    "Disable denied Gateway HTTP endpoints.",
    { configTargets: ["gateway.http"] },
  ),
  m(
    CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
    "manual",
    "Add URL allowlists for each URL-fetch input.",
    { configTargets: ["gateway.http"] },
  ),
  m(
    CHECK_IDS.policyGatewayNodeCommandDenied,
    "reviewRequired",
    "Add the command to gateway node denyCommands or update policy after review.",
    {
      configTargets: ["gateway.nodes.commands.deny"],
    },
  ),
  m(
    CHECK_IDS.policyAgentsWorkspaceAccessDenied,
    "reviewRequired",
    "Set agent workspace access to an allowed mode.",
    { configTargets: ["agents"] },
  ),
  m(
    CHECK_IDS.policyAgentsToolNotDenied,
    "automatic",
    "Merge required built-in workspace tool denies.",
    { configTargets: ["agents"] },
  ),
  m(
    CHECK_IDS.policyToolsProfileUnapproved,
    "reviewRequired",
    "Set the tool profile to an allowed profile.",
    { configTargets: ["tools.profile"] },
  ),
  m(
    CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
    "reviewRequired",
    "Set workspace-only filesystem posture when required assets remain readable.",
    {
      configTargets: ["tools.fs.workspaceOnly"],
    },
  ),
  m(
    CHECK_IDS.policyToolsExecSecurityUnapproved,
    "reviewRequired",
    "Set exec security to an allowed value.",
    { configTargets: ["tools.exec.security"] },
  ),
  m(
    CHECK_IDS.policyToolsExecAskUnapproved,
    "reviewRequired",
    "Set exec ask mode to an allowed value.",
    { configTargets: ["tools.exec.ask"] },
  ),
  m(
    CHECK_IDS.policyToolsExecHostUnapproved,
    "reviewRequired",
    "Move exec host to an allowed host mode.",
    { configTargets: ["tools.exec.host"] },
  ),
  m(CHECK_IDS.policyToolsElevatedEnabled, "automatic", "Set tools elevated mode to disabled.", {
    configTargets: ["tools.elevated.enabled"],
  }),
  m(
    CHECK_IDS.policyToolsAlsoAllowMissing,
    "reviewRequired",
    "Add expected alsoAllow entries only when policy intentionally grants them.",
    { configTargets: ["tools.alsoAllow"] },
  ),
  m(
    CHECK_IDS.policyToolsAlsoAllowUnexpected,
    "reviewRequired",
    "Remove unexpected alsoAllow entries.",
    { configTargets: ["tools.alsoAllow"] },
  ),
  m(
    CHECK_IDS.policyToolsRequiredDenyMissing,
    "automatic",
    "Merge required built-in deny tool classes.",
    {
      configTargets: ["tools.deny", "agents.entries.<id>.tools.deny"],
    },
  ),
  m(
    CHECK_IDS.policySandboxModeUnapproved,
    "reviewRequired",
    "Set sandbox mode to an allowed value.",
    { configTargets: ["sandbox.mode"] },
  ),
  m(
    CHECK_IDS.policySandboxBackendUnapproved,
    "reviewRequired",
    "Choose an approved sandbox backend that is installed.",
    { configTargets: ["sandbox.backend"] },
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
    {
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
    "reviewRequired",
    "Disable joining container namespaces.",
    {
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerMountModeRequired,
    "reviewRequired",
    "Change required mounts to read-only.",
    {
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerRuntimeSocketMount,
    "reviewRequired",
    "Remove container runtime socket binds.",
    {
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerUnconfinedProfile,
    "reviewRequired",
    "Remove unconfined container profiles.",
    {
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
    "manual",
    "Add an explicit browser CDP source range.",
    {
      configTargets: ["agents.sandbox.browser"],
    },
  ),
  m(
    CHECK_IDS.policyDataHandlingTelemetryContentCapture,
    "automatic",
    "Disable telemetry content capture.",
    {
      configTargets: ["diagnostics.otel.captureContent"],
    },
  ),
  m(
    CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
    "reviewRequired",
    "Set session maintenance to enforced mode.",
    {
      configTargets: ["session.maintenance.mode"],
    },
  ),
  m(
    CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
    "reviewRequired",
    "Disable transcript indexing for the affected agent scope.",
    {
      configTargets: ["memory"],
    },
  ),
  m(
    CHECK_IDS.policySecretsUnmanagedProvider,
    "manual",
    "Migrate the secret to a managed provider.",
    { configTargets: ["secrets"] },
  ),
  m(
    CHECK_IDS.policySecretsDeniedProviderSource,
    "reviewRequired",
    "Move the secret out of the denied source.",
    { configTargets: ["secrets"] },
  ),
  m(
    CHECK_IDS.policySecretsInsecureProvider,
    "reviewRequired",
    "Remove insecure provider overrides.",
    { configTargets: ["secrets"] },
  ),
  m(
    CHECK_IDS.policyAuthProfileInvalidMetadata,
    "manual",
    "Add required provider and mode metadata to auth profiles.",
    { configTargets: ["auth.profiles"] },
  ),
  m(
    CHECK_IDS.policyAuthProfileUnapprovedMode,
    "manual",
    "Change auth mode and credentials through the auth owner flow.",
    { configTargets: ["auth.profiles"] },
  ),
  m(
    CHECK_IDS.policyExecApprovalsMissing,
    "manual",
    "Restore an attributable exec-approvals evidence file.",
    {
      configTargets: [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
    },
  ),
  m(CHECK_IDS.policyExecApprovalsInvalid, "manual", "Repair the exec approvals evidence artifact."),
  m(
    CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
    "manual",
    "Update reviewed default approval evidence or policy.",
    {
      configTargets: [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
    "manual",
    "Update reviewed agent approval evidence or policy.",
    {
      configTargets: [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
    "reviewRequired",
    "Disable auto-allow skills in the approval owner surface.",
    {
      configTargets: [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAllowlistMissing,
    "manual",
    "Add expected approval patterns through approval review.",
    {
      configTargets: [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
    "manual",
    "Remove unexpected approval patterns through approval review.",
    {
      configTargets: [EXEC_APPROVALS_POLICY_DOCUMENT_NAME],
    },
  ),
  m(
    CHECK_IDS.policyMissingToolRisk,
    "manual",
    "Add tool risk metadata in the owning tool declaration.",
    { configTargets: ["tools"] },
  ),
  m(CHECK_IDS.policyUnknownToolRisk, "manual", "Use a supported tool risk level.", {
    policyPath: ["tools", "requireMetadata"],
    configTargets: ["tools"],
  }),
  m(
    CHECK_IDS.policyMissingToolSensitivity,
    "manual",
    "Add tool sensitivity metadata in the owning tool declaration.",
    { configTargets: ["tools"] },
  ),
  m(
    CHECK_IDS.policyMissingToolOwner,
    "manual",
    "Add owner metadata in the owning tool declaration.",
    { configTargets: ["tools"] },
  ),
  m(CHECK_IDS.policyUnknownToolSensitivity, "manual", "Use a supported tool sensitivity token.", {
    policyPath: ["tools", "requireMetadata"],
    configTargets: ["tools"],
  }),
] as const satisfies readonly PolicyFixMetadata[];

export const POLICY_FIX_METADATA_BY_CHECK_ID = new Map(
  POLICY_FIX_METADATA.map((rule) => [rule.checkId, rule] as const),
);
