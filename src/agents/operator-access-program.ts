import type { CyberAccessProgram } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

type AccessRolePolicy = Pick<
  NonNullable<AdmittedRunOperatorAuthority["rolePolicy"]>,
  "accessPrograms"
>;
type OperatorModelExecutionPolicy = Pick<AdmittedRunOperatorAuthority, "modelPolicy" | "scopes"> & {
  rolePolicy?: AccessRolePolicy;
};

/** Admin authority includes execution capabilities unless the role sets an explicit ceiling. */
export function isOperatorAccessProgramAllowed(
  authority: Pick<OperatorModelExecutionPolicy, "scopes" | "rolePolicy"> | undefined,
  program: CyberAccessProgram | undefined,
): boolean {
  if (!authority?.rolePolicy || !program || program === "standard") {
    return true;
  }
  const grants = authority.rolePolicy.accessPrograms;
  return grants ? grants.cyber.includes(program) : authority.scopes.includes("operator.admin");
}

/** Native dispatch must retain exact policy checks for model or Access restrictions. */
export function requiresOperatorModelExecutionPolicy(
  authority: OperatorModelExecutionPolicy | undefined,
  modelPolicy?: PreparedOperatorModelPolicy,
): boolean {
  return (
    modelPolicy !== undefined ||
    authority?.modelPolicy !== undefined ||
    !isOperatorAccessProgramAllowed(authority, "daybreak_blue") ||
    !isOperatorAccessProgramAllowed(authority, "daybreak_red")
  );
}

/** Built-in execution is checked by its host identity; plugin selections need exact enforcement. */
export function resolveAgentHarnessOperatorPolicyError(
  // Runtime types consume this policy leaf; accept only their capability contract.
  harness: { id: string; nativeModelPolicySupport?: "exact" } | undefined,
  authority: OperatorModelExecutionPolicy | undefined,
  modelPolicy?: PreparedOperatorModelPolicy,
): string | undefined {
  return harness &&
    requiresOperatorModelExecutionPolicy(authority, modelPolicy) &&
    harness.nativeModelPolicySupport !== "exact"
    ? `Agent harness ${harness.id} cannot enforce your operator role's model policy or Access grants. Choose a compatible runtime or ask a gateway administrator to update the harness.`
    : undefined;
}
