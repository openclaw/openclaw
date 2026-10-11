import { commitExecAuthorizationLocked } from "../infra/exec-approvals.js";
import type { ExecApprovalTransport } from "./bash-tools.exec-approval-request.js";

/** Keeps the committed policy and approval admission bound to the same process launch. */
export function createExecAuthorizationGuard(approvalTransport?: ExecApprovalTransport) {
  let assertCommittedAuthorization: (() => void) | undefined;
  return {
    assertCurrent(this: void) {
      if (!assertCommittedAuthorization) {
        throw new Error("Exec authorization has not been committed");
      }
      assertCommittedAuthorization();
    },
    async commit(this: void, params: Parameters<typeof commitExecAuthorizationLocked>[0]) {
      assertCommittedAuthorization = undefined;
      const assertApprovalCurrent =
        params.authorization?.source === "explicit-approval"
          ? approvalTransport?.assertCurrent
          : undefined;
      assertApprovalCurrent?.();
      const assertPolicyCurrent = await commitExecAuthorizationLocked(params);
      assertCommittedAuthorization = () => {
        assertApprovalCurrent?.();
        assertPolicyCurrent();
      };
    },
  };
}
