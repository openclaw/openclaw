import type { NativeHookRelayApprovalAuthority } from "../agent-harness-approval-authority.types.js";
import type { NativeHookRelayRegistration } from "./native-hook-relay-types.js";

const approvalAuthorityByRegistration = new WeakMap<
  NativeHookRelayRegistration,
  NativeHookRelayApprovalAuthority
>();

/** Bind one structured host authority to the exact relay registration it created. */
export function bindNativeHookRelayApprovalAuthority(
  registration: NativeHookRelayRegistration,
  authority: NativeHookRelayApprovalAuthority,
): void {
  approvalAuthorityByRegistration.set(registration, authority);
}

export function resolveNativeHookRelayApprovalAuthority(
  registration: NativeHookRelayRegistration,
): NativeHookRelayApprovalAuthority | undefined {
  return approvalAuthorityByRegistration.get(registration);
}
