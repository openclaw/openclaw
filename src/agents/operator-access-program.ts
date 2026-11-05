import type { CyberAccessProgram } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";

type AccessRolePolicy = Pick<
  NonNullable<AdmittedRunOperatorAuthority["rolePolicy"]>,
  "accessPrograms"
>;
type OperatorModelExecutionPolicy = Pick<AdmittedRunOperatorAuthority, "modelPolicy"> & {
  rolePolicy?: AccessRolePolicy;
};

/** Named roles grant each program explicitly; standalone/System behavior is unchanged. */
export function isOperatorAccessProgramAllowed(
  role: AccessRolePolicy | undefined,
  program: CyberAccessProgram | undefined,
): boolean {
  if (!role || !program || program === "standard") {
    return true;
  }
  return role.accessPrograms?.cyber.includes(program) === true;
}

/** Native dispatch must retain exact policy checks for model or Access restrictions. */
export function requiresOperatorModelExecutionPolicy(
  authority: OperatorModelExecutionPolicy | undefined,
): boolean {
  return (
    authority?.modelPolicy !== undefined ||
    !isOperatorAccessProgramAllowed(authority?.rolePolicy, "daybreak_blue") ||
    !isOperatorAccessProgramAllowed(authority?.rolePolicy, "daybreak_red")
  );
}

/** Built-in execution is checked by its host identity; plugin selections need exact enforcement. */
export function resolveAgentHarnessOperatorPolicyError(
  // Runtime types consume this policy leaf; accept only their capability contract.
  harness: { id: string; nativeModelPolicySupport?: "exact" } | undefined,
  authority: OperatorModelExecutionPolicy | undefined,
): string | undefined {
  return harness &&
    requiresOperatorModelExecutionPolicy(authority) &&
    harness.nativeModelPolicySupport !== "exact"
    ? `Agent harness ${harness.id} cannot enforce your operator role's model policy or Access grants. Choose a compatible runtime or ask a gateway administrator to update the harness.`
    : undefined;
}
