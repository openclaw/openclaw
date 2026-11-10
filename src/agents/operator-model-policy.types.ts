import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";

export type PreparedOperatorModelPolicy = Readonly<{
  /** Ordered concrete choices for Default and automatic fallback; never a global catalog. */
  models: readonly ProviderModelRef[];
  /** Compares resolved logical identities, preserving provider/auth routing. */
  allows: (ref: ProviderModelRef) => boolean;
}>;

export type OperatorModelPolicySnapshot = {
  models: ProviderModelRef[];
  allowed: { exact: string[]; wildcards: string[] };
  denied: { exact: string[]; wildcards: string[] };
};
/** Durable restrictions are not operator identity, credentials, or permission grants. */
export type RequesterModelPolicySnapshot =
  | { kind: "unbounded" }
  | { kind: "bounded"; constraints: OperatorModelPolicySnapshot[] }
  | { kind: "unknown" };
