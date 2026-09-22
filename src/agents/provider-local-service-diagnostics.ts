import { isSensitiveFieldKey, redactSensitiveText } from "../logging/redact.js";

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
  for (const value of Object.values(serviceEnv ?? {})) {
    if (value) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value && isSensitiveFieldKey(key)) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  for (const value of serviceArgs ?? []) {
    if (value) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  for (const [, value] of new Headers(healthHeaders)) {
    if (value) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  const bytes = Buffer.from(redacted);
  if (bytes.byteLength <= LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES) {
    return redacted;
  }
  let start = bytes.byteLength - LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES;
  while (start < bytes.byteLength) {
    const byte = bytes.at(start);
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

export function formatLocalServiceDiagnosticTail(diagnostics: LocalServiceDiagnostics): string {
  return diagnostics.stderrTail ? `; stderr: ${diagnostics.stderrTail}` : "";
}

export function formatLocalServiceExit(exit: LocalServiceExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 0}`;
}
