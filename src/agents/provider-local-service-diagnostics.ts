import { isSensitiveFieldKey, redactSensitiveText } from "../logging/redact.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";

const LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES = 8 * 1024;

export type LocalServiceExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type LocalServiceDiagnostics = {
  providerId: string;
  healthUrl: string;
  pid?: number;
  startedAt: number;
  spawnedAt?: number;
  readyAt?: number;
  lastHealthyAt?: number;
  stdoutTail: string;
  stderrTail: string;
  lastExit?: LocalServiceExit;
};

export function appendLocalServiceOutputTail(
  current: string,
  chunk: Buffer | string,
  serviceEnv: Record<string, string> | undefined,
  inheritedEnv: NodeJS.ProcessEnv,
  serviceArgs: string[] | undefined,
  healthHeaders: HeadersInit | undefined,
): string {
  let redacted = redactSensitiveText(`${current}${chunk.toString()}`, { mode: "tools" });
  const secretValues = [
    ...Object.values(serviceEnv ?? {}),
    ...Object.entries(inheritedEnv).flatMap(([key, value]) =>
      value && isSensitiveFieldKey(key) ? [value] : [],
    ),
    ...(serviceArgs ?? []),
    ...new Headers(healthHeaders).values(),
  ];
  for (const value of secretValues) {
    if (value) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  return truncateUtf8Suffix(redacted, LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES);
}

export function formatLocalServiceDiagnosticTail(diagnostics: LocalServiceDiagnostics): string {
  return diagnostics.stderrTail ? `; stderr: ${diagnostics.stderrTail}` : "";
}

export function formatLocalServiceExit(exit: LocalServiceExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 0}`;
}
