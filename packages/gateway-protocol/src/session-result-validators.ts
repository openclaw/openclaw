import * as Checks from "./compiled/protocol.generated/session-result-validators.js";
import { createProtocolValidator } from "./protocol-validator.js";
import { NativeSubagentsSnapshotSchema } from "./schema/native-subagents.js";
import { SessionsGoalMutationResultSchema } from "./schema/sessions-goal.js";
import { SessionsResolveResultSchema } from "./schema/sessions-resolve.js";

export const validateNativeSubagentsSnapshot = createProtocolValidator(
  NativeSubagentsSnapshotSchema,
  Checks.isNativeSubagentsSnapshot,
);
export const validateSessionsGoalMutationResult = createProtocolValidator(
  SessionsGoalMutationResultSchema,
  Checks.isSessionsGoalMutationResult,
);
export const validateSessionsResolveResult = createProtocolValidator(
  SessionsResolveResultSchema,
  Checks.isSessionsResolveResult,
);
