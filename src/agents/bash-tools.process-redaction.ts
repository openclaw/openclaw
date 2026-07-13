import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import {
  redactExecDetails,
  redactExecOutputText,
  withRedactionMarker,
} from "./bash-tools.exec-output.js";
import { deriveSessionName } from "./bash-tools.shared.js";

export function redactProcessSessionText(text: string): string {
  return redactSecrets(redactToolPayloadText(text));
}

export function deriveRedactedProcessSessionName(command: string): string | undefined {
  return redactSecrets(deriveSessionName(redactToolPayloadText(command)));
}

export function redactProcessToolDetails<T extends Record<string, unknown>>(
  details: T,
): T & { redacted?: true } {
  const result = redactExecDetails(details);
  const nestedRedacted = JSON.stringify(result.details).includes('"redacted":true');
  return withRedactionMarker(result.details, result.redacted || nestedRedacted);
}

export function redactProcessText(text: string, suffix = "") {
  const redacted = redactExecOutputText(text);
  return { text: redacted.text + suffix, redacted: redacted.redacted };
}

export function processSessionTextWasRedacted(text: string): boolean {
  return redactProcessSessionText(text) !== text;
}
