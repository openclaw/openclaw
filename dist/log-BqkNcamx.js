import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
//#region src/agents/cli-runner/log.ts
const cliBackendLog = createSubsystemLogger("agent/cli-backend");
const CLI_BACKEND_LOG_OUTPUT_ENV = "OPENCLAW_CLI_BACKEND_LOG_OUTPUT";
const LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV = "OPENCLAW_CLAUDE_CLI_LOG_OUTPUT";
//#endregion
export { LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV as n, cliBackendLog as r, CLI_BACKEND_LOG_OUTPUT_ENV as t };
