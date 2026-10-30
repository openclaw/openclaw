import * as Checks from "./compiled/protocol.generated/audit-run-validators.js";
import { createProtocolValidator } from "./protocol-validator.js";
import { DecisionReceiptV1Schema, ExecutionIdentityContextV1Schema } from "./schema/audit-run.js";

export const validateDecisionReceiptV1 = createProtocolValidator(
  DecisionReceiptV1Schema,
  Checks.isDecisionReceiptV1,
);
export const validateExecutionIdentityContextV1 = createProtocolValidator(
  ExecutionIdentityContextV1Schema,
  Checks.isExecutionIdentityContextV1,
);
