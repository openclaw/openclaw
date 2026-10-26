import { operatorRecoverySnapshotFixture } from "../gateway/server/client-fixtures.test-support.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";

export function createOperatorRecoveryAuthority(profileId: string, grantGeneration: string) {
  return createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.read"],
    assertCurrent() {},
    recoverySnapshot: operatorRecoverySnapshotFixture(profileId, grantGeneration, {
      sourceIngress: "control-ui",
    }),
  });
}
