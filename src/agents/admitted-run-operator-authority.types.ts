import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { GatewayAuthPolicyFacts } from "../gateway/auth-policy.types.js";
import type { RemoteIngressPrincipalIdentity } from "../gateway/server/client-identity-types.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

export type AdmittedRunOperatorRoleFacts = Readonly<{
  openclawIdAccountIds?: readonly string[];
  assignedRole: string | null;
  githubLogin?: string | null;
  policy?: GatewayOperatorRoleDefinition;
}>;

export type AdmittedRunOperatorAuthority = Readonly<{
  profileId: string;
  /** Canonical owner binding, or an explicitly host-issued opaque grant. */
  canonicalIdentity: Readonly<{ profileId: string }> | null;
  /** Original transport for presentation only; never grants authority. */
  clientId?: import("../../packages/gateway-protocol/src/client-info.js").GatewayClientId;
  /** Original OCID device and listing; profile attribution never replaces this source. */
  openclawIdPrincipal?: import("../gateway/openclaw-id/tunnel-principal.js").OpenClawIdTunnelPrincipal;
  /** Plain source evidence for another same-process start; never a lifetime check. */
  device?: Readonly<{ deviceId: string; key: string }>;
  deviceScopeCeiling?: readonly string[];
  authPolicy?: GatewayAuthPolicyFacts;
  sharedGeneration?: string;
  ingress?: Readonly<
    RemoteIngressPrincipalIdentity & {
      signal: AbortSignal;
      scopeCeiling: readonly string[];
    }
  >;
  /** Host-captured original input; claim/occurrence owners revalidate it for continuations. */
  recoverySnapshot?: import("../gateway/operator-run-recovery-source.codec.js").OperatorRunRecoverySnapshot;
  /** Diagnostic only; never participates in authority checks. */
  recoverySnapshotUnavailableReason?: import("../gateway/operator-run-recovery-source.codec.js").OperatorRecoveryUnavailableReason;
  /** Existing immutable policy and link; accepted-input owners may retain them for recovery. */
  channelRecoverySource?: Readonly<{
    reference: import("../state/user-profiles.types.js").UserChannelAuthorizationReference;
    modelPolicy?: PreparedOperatorModelPolicy;
  }>;
  scopes: readonly string[];
  /** Command-owner decision fixed at this run's start. */
  requesterOwner?: boolean;
  /** Original access dependency; null is proven independent, undefined is unclassified. */
  gatewayAccessGrant?: GatewayAccessGrantRef | null;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  /** Opaque authenticated source identity, independent of per-invocation restrictions. */
  source?: object;
  /** Independent invocation dependency; compatible queued input must retain this exact owner. */
  invocation?: object;
  /** Retains the original source independently of a foreground run or request. */
  retain?: () => () => void;
  /** Assignment and verified login from one check of the original live profile authority. */
  readCurrentRoleFacts?: (this: void) => AdmittedRunOperatorRoleFacts;
  /** Prepared role permissions; source-policy changes revoke the owning authority. */
  rolePolicy?: Readonly<{
    sessionAccessCap: GatewayOperatorRoleDefinition["sessions"]["others"];
    sandboxRequired: boolean;
    agents: "*" | readonly string[];
    accessPrograms?: Readonly<{
      cyber: ReadonlyArray<
        NonNullable<GatewayOperatorRoleDefinition["accessPrograms"]>["cyber"][number]
      >;
    }>;
  }>;
  modelPolicy?: PreparedOperatorModelPolicy;
  /** Committed policy changes invalidate only executions using a removed model. */
  onModelPolicyChanged?: (listener: () => void) => () => void;
}>;
