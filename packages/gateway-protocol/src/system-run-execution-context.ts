import type { Static } from "typebox";
import * as Checks from "./compiled/protocol.generated/system-run-execution-context.js";
import { createProtocolValidator } from "./protocol-validator.js";
import { SystemRunExecutionContextSchema } from "./schema/system-run-execution-context.js";

export const SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY = "system.run.execution-context.v1";

export type SystemRunExecutionContext = Static<typeof SystemRunExecutionContextSchema>;
export const validateSystemRunExecutionContext = createProtocolValidator(
  SystemRunExecutionContextSchema,
  Checks.isSystemRunExecutionContext,
);
