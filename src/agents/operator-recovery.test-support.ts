import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";

export function createOperatorRecoveryAuthority(profileId: string, grantGeneration: string) {
  return createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.read"],
    assertCurrent() {},
    recoverySnapshot: {
      profileId,
      scopes: ["operator.read"],
      assignedRole: null,
      githubLogin: null,
      grant: null,
      aliasBindingIds: [],
      authPolicy: {
        generation: "",
        grantGeneration,
        role: "operator",
        authMethod: "token",
      },
      controlUiAdmin: false,
      localOperator: false,
      sourceIngress: "control-ui",
    },
  });
}
