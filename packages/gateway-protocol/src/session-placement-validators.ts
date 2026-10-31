import * as Checks from "./compiled/protocol.generated/session-placement-validators.js";
import { createProtocolValidator } from "./protocol-validator.js";
import {
  SessionsDispatchParamsSchema,
  SessionsMoveParamsSchema,
} from "./schema/session-placement.js";

export const validateSessionsDispatchParams = createProtocolValidator(
  SessionsDispatchParamsSchema,
  Checks.isSessionsDispatchParams,
);
export const validateSessionsMoveParams = createProtocolValidator(
  SessionsMoveParamsSchema,
  Checks.isSessionsMoveParams,
);
