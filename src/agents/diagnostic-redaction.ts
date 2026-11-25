import { redactSecrets } from "../logging/redact.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";

export function redactAgentDiagnosticPayload(value: string): string;
export function redactAgentDiagnosticPayload(value: unknown): unknown;
export function redactAgentDiagnosticPayload(value: unknown): unknown {
  return redactSecrets(sanitizeDiagnosticPayload(value));
}
