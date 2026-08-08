import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES,
  CROSS_OS_MANAGED_GATEWAY_DIAGNOSTIC_TAIL_BYTES,
} from "./config.ts";

function decodeBoundedUtf8Tail(buffer: Buffer, maxBytes: number): string {
  const tail = buffer.subarray(Math.max(0, buffer.byteLength - maxBytes));
  let start = 0;
  while (start < tail.byteLength) {
    const byte = tail[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  let end = tail.byteLength;
  let finalSequenceStart = end - 1;
  while (finalSequenceStart >= start && (tail[finalSequenceStart]! & 0xc0) === 0x80) {
    finalSequenceStart -= 1;
  }
  if (finalSequenceStart >= start) {
    const lead = tail[finalSequenceStart]!;
    const expectedBytes = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
    if (end - finalSequenceStart < expectedBytes) {
      end = finalSequenceStart;
    }
  }
  return tail.subarray(start, end).toString("utf8");
}

export function readLogFileSize(logPath: string) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

export function readLogTextSince(logPath: string, offsetBytes: number) {
  return readLogTextWindow(logPath, {
    offsetBytes,
    maxBytes: CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES,
  });
}

export function readLogTextTail(logPath: string) {
  return readLogTextWindow(logPath, {
    maxBytes: CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES,
  });
}

export function readLogTextWindow(
  logPath: string,
  options: { maxBytes?: number; offsetBytes?: number } = {},
) {
  const maxBytes = Math.max(
    1,
    Math.floor(options.maxBytes ?? CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES),
  );
  const offsetBytes =
    typeof options.offsetBytes === "number" && Number.isFinite(options.offsetBytes)
      ? Math.max(0, Math.floor(options.offsetBytes))
      : 0;
  let stat;
  try {
    stat = statSync(logPath);
  } catch {
    return "";
  }
  if (!stat.isFile() || stat.size <= 0) {
    return "";
  }

  const tailStart = Math.max(0, stat.size - maxBytes);
  const start = Math.min(stat.size, Math.max(offsetBytes, tailStart));
  const length = stat.size - start;
  if (length <= 0) {
    return "";
  }

  const fd = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return decodeBoundedUtf8Tail(buffer.subarray(0, bytesRead), maxBytes);
  } finally {
    closeSync(fd);
  }
}

export function writePrivateDiagnosticText(filePath: string, text: string) {
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  chmodSync(parentDir, 0o700);
  writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export function writeRedactedLogTail(params: {
  sourcePath: string;
  destinationPath: string;
  redact: (text: string) => string;
  maxBytes?: number;
}) {
  const maxBytes = Math.max(
    1,
    Math.floor(params.maxBytes ?? CROSS_OS_MANAGED_GATEWAY_DIAGNOSTIC_TAIL_BYTES),
  );
  const sourceText = readLogTextWindow(params.sourcePath, {
    // Keep bounded lookbehind so credentials crossing the retained-tail boundary
    // are redacted before the final 64 KiB artifact is selected.
    maxBytes: maxBytes * 2,
  });
  if (!sourceText) {
    return false;
  }
  const redactedTail = decodeBoundedUtf8Tail(Buffer.from(params.redact(sourceText)), maxBytes);
  writePrivateDiagnosticText(params.destinationPath, redactedTail);
  return true;
}
