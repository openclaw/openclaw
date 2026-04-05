import { createSubsystemLogger } from "../../logging/subsystem.js";

export const cliBackendLog = createSubsystemLogger("agent/cli-backend");
export const CLI_BACKEND_LOG_OUTPUT_ENV = "OPENCLAW_CLI_BACKEND_LOG_OUTPUT";
