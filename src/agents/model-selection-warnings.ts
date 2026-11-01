import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog(): ReturnType<typeof createSubsystemLogger> {
  return (log ??= createSubsystemLogger("model-selection"));
}

function sanitizeModelWarningValue(value: string): string {
  const stripped = value ? stripAnsi(value) : "";
  let controlBoundary = -1;
  for (let index = 0; index < stripped.length; index += 1) {
    const code = stripped.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      controlBoundary = index;
      break;
    }
  }
  return sanitizeForLog(controlBoundary === -1 ? stripped : stripped.slice(0, controlBoundary));
}

export function warnUnqualifiedConfiguredModel(model: string, defaultProvider: string): void {
  const safe = sanitizeModelWarningValue(model);
  const resolved = sanitizeForLog(`${defaultProvider}/${safe}`);
  getLog().warn(
    `Model "${safe}" specified without provider. Falling back to "${resolved}". Please use "${resolved}" in your config.`,
  );
}

export function warnUnresolvedConfiguredModel(
  model: string,
  defaultProvider: string,
  defaultModel: string,
): void {
  const safe = sanitizeForLog(model);
  const fallback = sanitizeForLog(`${defaultProvider}/${defaultModel}`);
  getLog().warn(`Model "${safe}" could not be resolved. Falling back to default "${fallback}".`);
}

export function warnDisallowedConfiguredModel(
  requestedModel: string,
  selectedModel: string,
  configPath: string | null,
  repairConfigPath: string | null,
): void {
  const requested = sanitizeForLog(requestedModel);
  const selected = sanitizeForLog(selectedModel);
  getLog().warn(
    `Configured model "${requested}" is not allowed by ${configPath}. Falling back to "${selected}". Update the configured model or ${repairConfigPath}.`,
  );
}
