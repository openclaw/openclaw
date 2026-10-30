import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";

type PolicyEvidenceSource = {
  readonly id: string;
  readonly source: string;
};

type PolicyScopedValueEvidence<
  Scope extends "global" | "defaults" | "agent",
  Value extends boolean | string = boolean | string,
> = PolicyEvidenceSource & {
  readonly scope: Scope;
  readonly agentId?: string;
  readonly value?: Value;
  readonly explicit?: boolean;
};

/** Mutable during construction; collectors publish the readonly evidence contract. */
export type PolicyEvidenceBuilder<T> = { -readonly [Key in keyof T]: T[Key] };

export type PolicyAttestation = {
  readonly checkedAt: string;
  readonly policy?: {
    readonly path: string;
    readonly hash: string;
  };
  readonly workspace: {
    readonly scope: "policy";
    readonly hash: string;
  };
  readonly findingsHash?: string;
  readonly attestationHash?: string;
};

export type PolicyEvidence = {
  readonly channels: readonly PolicyChannelEvidence[];
  readonly tools?: readonly PolicyToolEvidence[];
  readonly toolPosture?: readonly PolicyToolPostureEvidence[];
  readonly sandboxPosture?: readonly PolicySandboxPostureEvidence[];
  readonly mcpServers: readonly PolicyMcpServerEvidence[];
  readonly modelProviders: readonly PolicyModelProviderEvidence[];
  readonly modelRefs: readonly PolicyModelRefEvidence[];
  readonly network: readonly PolicyNetworkEvidence[];
  readonly ingress?: readonly PolicyIngressEvidence[];
  readonly gatewayExposure?: readonly PolicyGatewayExposureEvidence[];
  readonly agentWorkspace?: readonly PolicyAgentWorkspaceEvidence[];
  readonly dataHandling?: readonly PolicyDataHandlingEvidence[];
  readonly secrets?: readonly PolicySecretEvidence[];
  readonly authProfiles?: readonly PolicyAuthProfileEvidence[];
  readonly execApprovals?: readonly PolicyExecApprovalEvidence[];
  readonly routing?: PolicyRoutingEvidence;
};

export type PolicyRoutingEvidence = {
  readonly bindings: readonly {
    readonly index: number;
    readonly source: string;
    readonly channel: string;
  }[];
  readonly probes: readonly {
    readonly id: string;
    readonly source: string;
    readonly agentId: string;
    readonly matchedBy: ResolvedAgentRoute["matchedBy"];
  }[];
};

export type PolicyChannelEvidence = PolicyEvidenceSource & {
  readonly provider: string;
  readonly enabled?: boolean;
};

export type PolicyMcpServerEvidence = PolicyEvidenceSource & {
  readonly transport: "stdio" | "sse" | "streamable-http" | "unknown";
  readonly command?: string;
  readonly url?: string;
};

export type PolicyToolEvidence = PolicyEvidenceSource & {
  readonly line: number;
  readonly risk?: string;
  readonly sensitivity?: string;
  readonly owner?: string;
  readonly capabilities?: readonly string[];
};

export type PolicyToolPostureEvidence = PolicyScopedValueEvidence<"global" | "agent"> & {
  readonly kind:
    | "allow"
    | "alsoAllow"
    | "deny"
    | "elevatedAllowFrom"
    | "elevatedEnabled"
    | "execAsk"
    | "execHost"
    | "execSecurity"
    | "fsWorkspaceOnly"
    | "profile";
  readonly entries?: readonly string[];
};

export type PolicySandboxPostureEvidence = PolicyScopedValueEvidence<"defaults" | "agent"> & {
  readonly kind:
    | "backend"
    | "browserCdpSourceRange"
    | "containerMount"
    | "containerNetwork"
    | "containerSecurityProfile"
    | "mode";
  readonly bind?: string;
  readonly bindMode?: string;
  readonly bindHost?: string;
  readonly bindSurface?: "browser" | "docker";
  readonly networkSurface?: "browser" | "docker";
  readonly profile?: "apparmor" | "seccomp";
};

export type PolicyModelProviderEvidence = PolicyEvidenceSource;

export type PolicyModelRefEvidence = {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
};

export type PolicyNetworkEvidence = PolicyEvidenceSource & {
  readonly value: boolean;
};

export type PolicyIngressEvidence = PolicyEvidenceSource & {
  readonly kind:
    | "channelDmPolicy"
    | "channelGroupPolicy"
    | "channelRequireMention"
    | "sessionDmScope";
  readonly channel?: string;
  readonly accountId?: string;
  readonly groupId?: string;
  readonly value?: boolean | string;
  readonly explicit?: boolean;
};

export type PolicyGatewayExposureEvidence = PolicyEvidenceSource & {
  readonly kind:
    | "auth"
    | "authRateLimit"
    | "bind"
    | "controlUi"
    | "httpEndpoint"
    | "httpUrlFetch"
    | "nodeCommand"
    | "nodeDenyCommand"
    | "remote"
    | "tailscale";
  readonly value?: boolean | string;
  readonly nonLoopback?: boolean;
  readonly explicit?: boolean;
  readonly endpoint?: string;
  readonly hasAllowlist?: boolean;
  readonly command?: string;
};

export type PolicyAgentWorkspaceEvidence = PolicyScopedValueEvidence<
  "defaults" | "agent",
  string
> & {
  readonly kind: "workspaceAccess" | "toolDeny";
  readonly sandboxMode?: string;
  readonly sandboxModeSource?: string;
  readonly sandboxEnabled?: boolean;
  readonly tool?: string;
  readonly denied?: boolean;
};

export type PolicySecretEvidence = PolicyEvidenceSource & {
  readonly kind: "input" | "provider";
  readonly provenance?: "secretRef";
  readonly refSource?: "env" | "file" | "exec" | "store";
  readonly refProvider?: string;
  readonly providerSource?: string;
};

export type PolicyAuthProfileEvidence = PolicyEvidenceSource & {
  readonly validMetadata: boolean;
  readonly provider?: string;
  readonly mode?: string;
};

export type PolicyExecApprovalEvidence = PolicyEvidenceSource & {
  readonly kind: "agent" | "allowlist" | "defaults";
  readonly agentId?: string;
  readonly security?: string;
  readonly securityConfigured?: boolean;
  readonly ask?: string;
  readonly askFallback?: string;
  readonly autoAllowSkills?: boolean;
  readonly pattern?: string;
  readonly argPattern?: string;
  readonly entrySource?: string;
};

export type PolicyDataHandlingEvidence = PolicyScopedValueEvidence<"global" | "agent"> & {
  readonly kind:
    | "memorySessionTranscriptIndexing"
    | "sensitiveLoggingRedaction"
    | "sessionRetentionMode"
    | "telemetryContentCapture";
};

export type SecretRefDefaults = NonNullable<Parameters<typeof coerceSecretRef>[1]>;

export const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
