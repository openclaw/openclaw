import * as Checks from "../compiled/protocol.generated/schema-worker-exec-approval.js";
import { createProtocolValidator } from "../protocol-validator.js";
import { WorkerExecApprovalParamsSchema } from "./worker-exec-approval-schemas.js";

export * from "./worker-exec-approval-schemas.js";

export const validateWorkerExecApprovalParams = createProtocolValidator(
  WorkerExecApprovalParamsSchema,
  Checks.isWorkerExecApprovalParams,
);
