import { formatErrorMessage, readErrorName } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

export const subagentRegistryLog = createSubsystemLogger("agents/subagent-registry");

export function buildSafeLifecycleErrorMeta(error: unknown): Record<string, string> {
  const message = formatErrorMessage(error);
  const name = readErrorName(error);
  return name ? { name, message } : { message };
}
