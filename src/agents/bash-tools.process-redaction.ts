import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import { deriveSessionName } from "./bash-tools.shared.js";

export function deriveRedactedProcessSessionName(command: string): string | undefined {
  return redactSecrets(deriveSessionName(redactToolPayloadText(command)));
}
