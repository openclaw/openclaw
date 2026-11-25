import * as Checks from "./compiled/protocol.generated/worker-response-validators.js";
import { createProtocolValidator } from "./protocol-validator.js";
import {
  WorkerAdmissionResponseFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  WorkerLiveEventResponseFrameSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerTranscriptCommitResponseFrameSchema,
} from "./schema/worker-admission.js";
import { WorkerComputerResponseFrameSchema } from "./schema/worker-computer.js";
import { WorkerExecApprovalResponseFrameSchema } from "./schema/worker-exec-approval-schemas.js";
import {
  WorkerGatewayToolCancelResponseFrameSchema,
  WorkerGatewayToolResponseFrameSchema,
} from "./schema/worker-gateway-tool.js";
import {
  WorkerInferenceCancelResponseFrameSchema,
  WorkerInferenceStartResponseFrameSchema,
} from "./schema/worker-inference.js";
import { WorkerTurnAdmissionResponseFrameSchema } from "./schema/worker-turn-admission.js";

export const validateWorkerAdmissionResponseFrame = createProtocolValidator(
  WorkerAdmissionResponseFrameSchema,
  Checks.isWorkerAdmissionResponseFrame,
);
export const validateWorkerProtocolCloseReason = createProtocolValidator(
  WorkerProtocolCloseReasonSchema,
  Checks.isWorkerProtocolCloseReason,
);
export const validateWorkerTurnAdmissionResponseFrame = createProtocolValidator(
  WorkerTurnAdmissionResponseFrameSchema,
  Checks.isWorkerTurnAdmissionResponseFrame,
);
export const validateWorkerGatewayToolResponseFrame = createProtocolValidator(
  WorkerGatewayToolResponseFrameSchema,
  Checks.isWorkerGatewayToolResponseFrame,
);
export const validateWorkerGatewayToolCancelResponseFrame = createProtocolValidator(
  WorkerGatewayToolCancelResponseFrameSchema,
  Checks.isWorkerGatewayToolCancelResponseFrame,
);
export const validateWorkerHeartbeatResponseFrame = createProtocolValidator(
  WorkerHeartbeatResponseFrameSchema,
  Checks.isWorkerHeartbeatResponseFrame,
);
export const validateWorkerTranscriptCommitResponseFrame = createProtocolValidator(
  WorkerTranscriptCommitResponseFrameSchema,
  Checks.isWorkerTranscriptCommitResponseFrame,
);
export const validateWorkerLiveEventResponseFrame = createProtocolValidator(
  WorkerLiveEventResponseFrameSchema,
  Checks.isWorkerLiveEventResponseFrame,
);
export const validateWorkerComputerResponseFrame = createProtocolValidator(
  WorkerComputerResponseFrameSchema,
  Checks.isWorkerComputerResponseFrame,
);
export const validateWorkerInferenceStartResponseFrame = createProtocolValidator(
  WorkerInferenceStartResponseFrameSchema,
  Checks.isWorkerInferenceStartResponseFrame,
);
export const validateWorkerInferenceCancelResponseFrame = createProtocolValidator(
  WorkerInferenceCancelResponseFrameSchema,
  Checks.isWorkerInferenceCancelResponseFrame,
);
export const validateWorkerExecApprovalResponseFrame = createProtocolValidator(
  WorkerExecApprovalResponseFrameSchema,
  Checks.isWorkerExecApprovalResponseFrame,
);
