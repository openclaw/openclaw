import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

export type AdmittedRunOperatorAuthority = Readonly<{
  profileId: string;
  /** Original OCID device and listing; profile attribution never replaces this source. */
  openclawIdPrincipal?: import("../gateway/openclaw-id/tunnel-principal.js").OpenClawIdTunnelPrincipal;
  /** Host-captured original input; claim/occurrence owners revalidate it for continuations. */
  recoverySnapshot?: import("../gateway/operator-run-recovery-source.codec.js").OperatorRunRecoverySnapshot;
  /** Existing immutable policy and link; accepted-input owners may retain them for recovery. */
  channelRecoverySource?: Readonly<{
    reference: import("../state/user-profiles.types.js").UserChannelAuthorizationReference;
    modelPolicy?: PreparedOperatorModelPolicy;
  }>;
  scopes: readonly string[];
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
  readCurrentRoleFacts?: (this: void) => Readonly<{
    assignedRole: string | null;
    githubLogin?: string | null;
    /** Non-named source policy, checked by the original authority before each read. */
    policy?: GatewayOperatorRoleDefinition;
  }>;
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
