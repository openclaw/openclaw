import { lazyCompile } from "./protocol-validator.js";
import { DecisionReceiptV1Schema, ExecutionIdentityContextV1Schema } from "./schema/audit-run.js";

export const validateDecisionReceiptV1 = lazyCompile(DecisionReceiptV1Schema);
export const validateExecutionIdentityContextV1 = lazyCompile(ExecutionIdentityContextV1Schema);
