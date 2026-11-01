import type { ChildProcess } from "node:child_process";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";
import { isSensitiveFieldKey, redactSensitiveText } from "../logging/redact.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import type { ProviderLocalServiceLease } from "./provider-local-service-target.js";
import {
  collectRequestHeaderSecretValues,
  redactProviderResponseErrorText,
} from "./provider-request-header-redaction.js";

const LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES = 8 * 1024;
const LOCAL_SERVICE_OUTPUT_TAIL_MAX_LINES = 64;

export type LocalServiceExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type LocalServiceDiagnostics = {
  healthUrl: string;
  pid?: number;
  spawnedAt?: number;
  readyAt?: number;
  stderrTail: string;
};

const redactors = new WeakMap<LocalServiceDiagnostics, (text: string) => string>();
const leaseDiagnostics = new WeakMap<
  ProviderLocalServiceLease,
  { diagnostics: LocalServiceDiagnostics; headers: HeadersInit | undefined }
>();

/** The raw byte ring belongs to this child; redaction happens only when a failure leaves it. */
export function captureLocalServiceOutput(
  child: Pick<ChildProcess, "stderr">,
  diagnostics: LocalServiceDiagnostics,
  service: ModelProviderLocalServiceConfig,
  healthHeaders: HeadersInit | undefined,
): void {
  let truncated = false;
  const values = [
    ...Object.values(service.env ?? {}),
    ...Object.entries(process.env).flatMap(([key, value]) =>
      value && isSensitiveFieldKey(key) ? [value] : [],
    ),
    ...(service.args ?? []),
    ...collectRequestHeaderSecretValues(healthHeaders ?? {}),
  ];
  const secretValues = [
    ...new Set(values.flatMap((value) => [value].concat(value.split(/\r?\n/u)))),
  ].filter(Boolean);
  redactors.set(diagnostics, (rawText) => {
    let text = rawText;
    if (truncated) {
      // A cut line can contain an unrecognizable credential suffix. Keep complete lines only.
      const newline = text.indexOf("\n");
      text =
        newline < 0
          ? "[redacted] oversized stderr line"
          : `[truncated]\n${text.slice(newline + 1)}`;
    }
    for (const value of secretValues) {
      if (value) {
        text = text.replaceAll(value, "[redacted]");
      }
    }
    return redactSensitiveText(text, { mode: "tools" });
  });
  const ring = Buffer.alloc(LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES);
  let offset = 0;
  let size = 0;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const input = Buffer.from(chunk);
    truncated ||= size + input.length > ring.length;
    const bytes = input.subarray(-ring.length);
    const first = Math.min(bytes.length, ring.length - offset);
    ring.set(bytes.subarray(0, first), offset);
    ring.set(bytes.subarray(first), 0);
    offset = (offset + bytes.length) % ring.length;
    size = Math.min(size + bytes.length, ring.length);
    const tail =
      size < ring.length
        ? ring.subarray(0, size)
        : Buffer.concat([ring.subarray(offset), ring.subarray(0, offset)]);
    let start = 0;
    for (const byte of tail) {
      if ((byte & 0xc0) !== 0x80) {
        break;
      }
      start += 1;
    }
    diagnostics.stderrTail = tail
      .subarray(start)
      .toString("utf8")
      .split("\n")
      .slice(-LOCAL_SERVICE_OUTPUT_TAIL_MAX_LINES)
      .join("\n");
  });
}

export function createLocalServiceLease(
  release: () => void,
  diagnostics?: LocalServiceDiagnostics,
  headers?: HeadersInit,
): ProviderLocalServiceLease {
  const lease = { release };
  if (diagnostics) {
    // Peer requests share this child's stderr; use the existing bounded egress registry.
    for (const value of collectRequestHeaderSecretValues(headers ?? {})) {
      registerSecretValueForRedaction(value);
    }
    leaseDiagnostics.set(lease, { diagnostics, headers });
  }
  return lease;
}

export function getLocalServiceDiagnosticTail(
  lease: ProviderLocalServiceLease | undefined,
): string {
  const owned = lease && leaseDiagnostics.get(lease);
  return owned ? formatLocalServiceDiagnosticTail(owned.diagnostics, owned.headers) : "";
}

export function attachLocalServiceDiagnostics(
  error: unknown,
  lease: ProviderLocalServiceLease | undefined,
): unknown {
  if (error instanceof Error && error.name !== "AbortError") {
    const tail = getLocalServiceDiagnosticTail(lease);
    if (tail) {
      // DOMException has a getter-only message. Preserve the error and its metadata.
      Object.defineProperty(error, "message", {
        value: `${error.message}${tail}`,
        configurable: true,
        writable: true,
      });
    }
  }
  return error;
}

export function formatLocalServiceDiagnosticTail(
  diagnostics: LocalServiceDiagnostics,
  headers?: HeadersInit,
): string {
  const rawTail = redactors.get(diagnostics)?.(diagnostics.stderrTail) ?? "";
  const tail = headers
    ? redactProviderResponseErrorText(rawTail, headers, { sourceTruncated: true })
    : rawTail;
  return tail ? `; stderr: ${truncateUtf8Suffix(tail, LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES)}` : "";
}

export function formatLocalServiceExit(exit: LocalServiceExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 0}`;
}
