import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";

type PolicyStrictnessKind =
  | "allowlist-subset"
  | "denylist-superset"
  | "ordered-string"
  | "requires-true"
  | "requires-false"
  | "exact-list"
  | "routing-probes";

type PolicyEmptyListSemantics = "disabled" | "meaningful";

export type PolicyScopeSelectorKind = "agentIds" | "channelIds";

export type PolicyRuleMetadata = {
  readonly policyPath: readonly string[];
  readonly strictness: PolicyStrictnessKind;
  readonly valueType:
    | "boolean"
    | "channel-provider-deny-rules"
    | "routing-probes"
    | "string"
    | "string-list";
  readonly checkIds: readonly (typeof POLICY_CHECK_IDS)[number][];
  /**
   * Evidence source of the runtime invariant that satisfies this rule unconditionally.
   * Set only when `checkIds` is empty, so a rule can never enforce nothing without saying
   * why; `metadata.test.ts` asserts the pairing and that policy state emits the source.
   */
  readonly satisfiedByInvariant?: string;
  readonly emptyList?: PolicyEmptyListSemantics;
  readonly allowedValues?: readonly string[];
  readonly caseSensitive?: boolean;
  readonly normalizeValues?: "model-provider";
  readonly orderedValues?: readonly string[];
  readonly scopeSelectors?: readonly PolicyScopeSelectorKind[];
};

type RuleOptions = Omit<PolicyRuleMetadata, "policyPath" | "strictness" | "valueType" | "checkIds">;
type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

function booleanRule(
  path: string,
  checkId: PolicyCheckId,
  required: boolean,
  options: RuleOptions = {},
): PolicyRuleMetadata {
  return {
    policyPath: path.split("."),
    strictness: required ? "requires-true" : "requires-false",
    valueType: "boolean",
    checkIds: [checkId],
    ...options,
  };
}

function allowlistRule(
  path: string,
  checkId: PolicyCheckId,
  options: RuleOptions = {},
): PolicyRuleMetadata {
  return {
    policyPath: path.split("."),
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [checkId],
    emptyList: "disabled",
    ...options,
  };
}

function denylistRule(
  path: string,
  checkId: PolicyCheckId,
  options: RuleOptions = {},
): PolicyRuleMetadata {
  return {
    policyPath: path.split("."),
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [checkId],
    ...options,
  };
}

export const SANDBOX_CONTAINER_POLICY_RULES = [
  {
    key: "denyHostNetwork",
    label: "host network posture",
    checkIds: [CHECK_IDS.policySandboxContainerHostNetworkDenied],
  },
  {
    key: "denyContainerNamespaceJoin",
    label: "container namespace posture",
    checkIds: [CHECK_IDS.policySandboxContainerNamespaceJoinDenied],
  },
  {
    key: "requireReadOnlyMounts",
    label: "container mount mode posture",
    checkIds: [CHECK_IDS.policySandboxContainerMountModeRequired],
  },
  {
    key: "denyContainerRuntimeSocketMounts",
    label: "container runtime socket mount posture",
    checkIds: [CHECK_IDS.policySandboxContainerRuntimeSocketMount],
  },
  {
    key: "denyUnconfinedProfiles",
    label: "container security profile posture",
    checkIds: [CHECK_IDS.policySandboxContainerUnconfinedProfile],
  },
] as const;

const SANDBOX_POLICY_RULE_METADATA = [
  allowlistRule("sandbox.requireMode", CHECK_IDS.policySandboxModeUnapproved, {
    allowedValues: ["off", "non-main", "all"],
    scopeSelectors: ["agentIds"],
  }),
  allowlistRule("sandbox.allowBackends", CHECK_IDS.policySandboxBackendUnapproved, {
    scopeSelectors: ["agentIds"],
  }),
  ...SANDBOX_CONTAINER_POLICY_RULES.map((rule) => ({
    policyPath: ["sandbox", "containers", rule.key] as const,
    strictness: "requires-true" as const,
    valueType: "boolean" as const,
    checkIds: rule.checkIds,
    scopeSelectors: ["agentIds"] as const,
  })),
  booleanRule(
    "sandbox.browser.requireCdpSourceRange",
    CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
    true,
    {
      scopeSelectors: ["agentIds"],
    },
  ),
] as const satisfies readonly PolicyRuleMetadata[];

export const POLICY_RULE_METADATA: readonly PolicyRuleMetadata[] = [
  {
    policyPath: ["channels", "denyRules"],
    strictness: "denylist-superset",
    valueType: "channel-provider-deny-rules",
    checkIds: [CHECK_IDS.policyDeniedChannelProvider],
    emptyList: "meaningful",
    caseSensitive: true,
  },
  allowlistRule("mcp.servers.allow", CHECK_IDS.policyUnapprovedMcpServer, {
    caseSensitive: true,
  }),
  denylistRule("mcp.servers.deny", CHECK_IDS.policyDeniedMcpServer, {
    caseSensitive: true,
  }),
  allowlistRule("models.providers.allow", CHECK_IDS.policyUnapprovedModelProvider, {
    normalizeValues: "model-provider",
  }),
  denylistRule("models.providers.deny", CHECK_IDS.policyDeniedModelProvider, {
    normalizeValues: "model-provider",
  }),
  booleanRule("network.privateNetwork.allow", CHECK_IDS.policyPrivateNetworkAccess, false),
  booleanRule("routing.requireBindings", CHECK_IDS.policyRoutingBindingsRequired, true),
  booleanRule(
    "routing.requireConfiguredChannels",
    CHECK_IDS.policyRoutingBindingChannelUnconfigured,
    true,
  ),
  {
    policyPath: ["routing", "probes"],
    strictness: "routing-probes",
    valueType: "routing-probes",
    checkIds: [CHECK_IDS.policyRoutingAgentMismatch, CHECK_IDS.policyRoutingMatchKindMismatch],
  },
  {
    policyPath: ["ingress", "session", "requireDmScope"],
    strictness: "ordered-string",
    valueType: "string",
    orderedValues: ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"],
    checkIds: [CHECK_IDS.policyIngressDmScopeUnapproved],
  },
  booleanRule(
    "gateway.exposure.allowNonLoopbackBind",
    CHECK_IDS.policyGatewayNonLoopbackBind,
    false,
  ),
  booleanRule(
    "gateway.exposure.allowTailscaleFunnel",
    CHECK_IDS.policyGatewayTailscaleFunnel,
    false,
  ),
  booleanRule("gateway.auth.requireAuth", CHECK_IDS.policyGatewayAuthDisabled, true),
  booleanRule(
    "gateway.auth.requireExplicitRateLimit",
    CHECK_IDS.policyGatewayRateLimitMissing,
    true,
  ),
  booleanRule("gateway.controlUi.allowInsecure", CHECK_IDS.policyGatewayControlUiInsecure, false),
  booleanRule("gateway.remote.allow", CHECK_IDS.policyGatewayRemoteEnabled, false),
  denylistRule("gateway.http.denyEndpoints", CHECK_IDS.policyGatewayHttpEndpointEnabled, {
    allowedValues: ["chatCompletions", "responses"],
    caseSensitive: true,
  }),
  booleanRule(
    "gateway.http.requireUrlAllowlists",
    CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
    true,
  ),
  denylistRule("gateway.nodes.denyCommands", CHECK_IDS.policyGatewayNodeCommandDenied, {
    caseSensitive: true,
  }),
  allowlistRule("agents.workspace.allowedAccess", CHECK_IDS.policyAgentsWorkspaceAccessDenied, {
    allowedValues: ["none", "ro", "rw"],
    scopeSelectors: ["agentIds"],
  }),
  denylistRule("agents.workspace.denyTools", CHECK_IDS.policyAgentsToolNotDenied, {
    allowedValues: ["exec", "process", "write", "edit", "apply_patch"],
    scopeSelectors: ["agentIds"],
  }),
  allowlistRule("tools.profiles.allow", CHECK_IDS.policyToolsProfileUnapproved, {
    allowedValues: ["minimal", "coding", "messaging", "full"],
    scopeSelectors: ["agentIds"],
  }),
  booleanRule("tools.fs.requireWorkspaceOnly", CHECK_IDS.policyToolsFsWorkspaceOnlyRequired, true, {
    scopeSelectors: ["agentIds"],
  }),
  allowlistRule("tools.exec.allowSecurity", CHECK_IDS.policyToolsExecSecurityUnapproved, {
    allowedValues: ["deny", "allowlist", "full"],
    scopeSelectors: ["agentIds"],
  }),
  allowlistRule("tools.exec.requireAsk", CHECK_IDS.policyToolsExecAskUnapproved, {
    allowedValues: ["off", "on-miss", "always"],
    scopeSelectors: ["agentIds"],
  }),
  allowlistRule("tools.exec.allowHosts", CHECK_IDS.policyToolsExecHostUnapproved, {
    allowedValues: ["auto", "sandbox", "gateway", "node"],
    scopeSelectors: ["agentIds"],
  }),
  booleanRule("tools.elevated.allow", CHECK_IDS.policyToolsElevatedEnabled, false, {
    scopeSelectors: ["agentIds"],
  }),
  {
    policyPath: ["tools", "alsoAllow", "expected"],
    strictness: "exact-list",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsAlsoAllowMissing, CHECK_IDS.policyToolsAlsoAllowUnexpected],
    emptyList: "meaningful",
    scopeSelectors: ["agentIds"],
  },
  denylistRule("tools.denyTools", CHECK_IDS.policyToolsRequiredDenyMissing, {
    scopeSelectors: ["agentIds"],
  }),
  {
    policyPath: ["tools", "requireMetadata"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [
      CHECK_IDS.policyUnmigratedToolsFile,
      CHECK_IDS.policyMissingToolRisk,
      CHECK_IDS.policyMissingToolSensitivity,
      CHECK_IDS.policyMissingToolOwner,
    ],
    allowedValues: ["risk", "sensitivity", "owner"],
  },
  ...SANDBOX_POLICY_RULE_METADATA,
  allowlistRule("ingress.channels.allowDmPolicies", CHECK_IDS.policyIngressDmPolicyUnapproved, {
    allowedValues: ["pairing", "allowlist", "open", "disabled"],
    scopeSelectors: ["channelIds"],
  }),
  booleanRule("ingress.channels.denyOpenGroups", CHECK_IDS.policyIngressOpenGroupsDenied, true, {
    scopeSelectors: ["channelIds"],
  }),
  booleanRule(
    "ingress.channels.requireMentionInGroups",
    CHECK_IDS.policyIngressGroupMentionRequired,
    true,
    {
      scopeSelectors: ["channelIds"],
    },
  ),
  {
    // Redaction is unconditional in src/logging/redact.ts, so no doctor check can fail for
    // this rule. The key stays a policy contract: `openclaw policy compare` still enforces
    // baseline strictness, and policy state records the invariant below as satisfied.
    policyPath: ["dataHandling", "sensitiveLogging", "requireRedaction"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [],
    satisfiedByInvariant: "oc://openclaw.invariant/logging/redaction",
  },
  booleanRule(
    "dataHandling.telemetry.denyContentCapture",
    CHECK_IDS.policyDataHandlingTelemetryContentCapture,
    true,
  ),
  booleanRule(
    "dataHandling.retention.requireSessionMaintenance",
    CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
    true,
  ),
  booleanRule(
    "dataHandling.memory.denySessionTranscriptIndexing",
    CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
    true,
    {
      scopeSelectors: ["agentIds"],
    },
  ),
  booleanRule("secrets.requireManagedProviders", CHECK_IDS.policySecretsUnmanagedProvider, true),
  denylistRule("secrets.denySources", CHECK_IDS.policySecretsDeniedProviderSource),
  booleanRule("secrets.allowInsecureProviders", CHECK_IDS.policySecretsInsecureProvider, false),

  booleanRule("execApprovals.requireFile", CHECK_IDS.policyExecApprovalsMissing, true),
  allowlistRule(
    "execApprovals.defaults.allowSecurity",
    CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
    {
      allowedValues: ["deny", "allowlist", "full"],
    },
  ),
  allowlistRule(
    "execApprovals.agents.allowSecurity",
    CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
    {
      allowedValues: ["deny", "allowlist", "full"],
      scopeSelectors: ["agentIds"],
    },
  ),
  booleanRule(
    "execApprovals.agents.allowAutoAllowSkills",
    CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
    false,
    {
      scopeSelectors: ["agentIds"],
    },
  ),
  {
    policyPath: ["execApprovals", "agents", "allowlist", "expected"],
    strictness: "exact-list",
    valueType: "string-list",
    checkIds: [
      CHECK_IDS.policyExecApprovalsAllowlistMissing,
      CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
    ],
    emptyList: "meaningful",
    caseSensitive: true,
    scopeSelectors: ["agentIds"],
  },
  denylistRule("auth.profiles.requireMetadata", CHECK_IDS.policyAuthProfileInvalidMetadata, {
    allowedValues: ["provider", "mode"],
  }),
  allowlistRule("auth.profiles.allowModes", CHECK_IDS.policyAuthProfileUnapprovedMode, {
    allowedValues: ["api_key", "aws-sdk", "oauth", "token"],
  }),
];
