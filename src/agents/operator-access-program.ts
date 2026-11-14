import type { CyberAccessProgram } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";

type AccessRolePolicy = Pick<
  NonNullable<AdmittedRunOperatorAuthority["rolePolicy"]>,
  "accessPrograms"
>;

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
  authority: AdmittedRunOperatorAuthority | undefined,
): boolean {
  return (
    authority?.modelPolicy !== undefined ||
    !isOperatorAccessProgramAllowed(authority?.rolePolicy, "daybreak_blue") ||
    !isOperatorAccessProgramAllowed(authority?.rolePolicy, "daybreak_red")
  );
}
