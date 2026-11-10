import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "./closed-object.js";
import {
  WorkerInferenceContextSchema,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
} from "./worker-inference.js";
import {
  LiveIntegerSchema,
  WorkerIdentifierSchema,
  checkWorkerProtocolJson,
  workerResponseSchema,
} from "./worker-protocol-primitives.js";

export const WORKER_TURN_ADMISSION_PROTOCOL_FEATURE = "worker-turn-admission-v1";
export const WORKER_TURN_ADMISSION_METHOD = "worker.turn.admit";

const AdmissionTextSchema = Type.String({ maxLength: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES });
const WorkerTurnAdmissionParamsSchema = closedObject({
  runEpoch: LiveIntegerSchema,
  systemPrompt: AdmissionTextSchema,
  prompt: AdmissionTextSchema,
  messages: WorkerInferenceContextSchema.properties.messages,
});
const WorkerTurnAdmissionResultSchema = Type.Union([
  closedObject({
    outcome: Type.Literal("allow"),
    baseLeafId: Type.Union([WorkerIdentifierSchema, Type.Null()]),
  }),
  closedObject({ outcome: Type.Literal("block") }),
]);

export const WorkerTurnAdmissionResponseFrameSchema = workerResponseSchema(
  WorkerTurnAdmissionResultSchema,
);

export type WorkerTurnAdmissionParams = Static<typeof WorkerTurnAdmissionParamsSchema>;
export type WorkerTurnAdmissionResult = Static<typeof WorkerTurnAdmissionResultSchema>;

export function validateWorkerTurnAdmissionParams(
  data: unknown,
): data is WorkerTurnAdmissionParams {
  return !checkWorkerProtocolJson(data) && Value.Check(WorkerTurnAdmissionParamsSchema, data);
}
