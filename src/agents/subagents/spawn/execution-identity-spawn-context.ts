import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { createPrivateContextCarrier } from "../../../shared/private-context-carrier.js";

/** Carry exact parent provenance without adding it to public spawn context types. */
export const { carry: withParentExecutionIdentity, read: readParentExecutionIdentity } =
  createPrivateContextCarrier<ExecutionIdentityAdmissionToken>();
