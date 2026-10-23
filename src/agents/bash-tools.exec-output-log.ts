import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { formatFullOutputFooter } from "./sessions/tools/tool-contracts.js";

const MAX_OUTPUT_LOG_BYTES = 2 * 1024 * 1024;

/** An explicitly requested workspace artifact, independent of process-result retention. */
export type ExecOutputLog = {
  path?: string;
  chars: number;
  truncated: boolean;
  failed: boolean;
};

export async function createExecOutputLog(workdir: string, sessionId: string) {
  const log: ExecOutputLog = {
    chars: 0,
    truncated: false,
    failed: false,
  };
  let stream: WriteStream | undefined;
  let completion = Promise.resolve();
  try {
    const directory = await mkdtemp(path.join(workdir, `.openclaw-exec-${sessionId}-`));
    const filePath = path.join(directory, "output.log");
    stream = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
    completion = finished(stream).catch(() => {
      log.failed = true;
    });
    await once(stream, "open");
    log.path = filePath;
  } catch {
    log.failed = true;
    stream?.destroy();
    await completion;
    stream = undefined;
  }
  let bytes = 0;
  let closed = false;
  return {
    log,
    append(text: string) {
      if (closed || log.failed || log.truncated) {
        return;
      }
      const retained = truncateUtf8Prefix(text, MAX_OUTPUT_LOG_BYTES - bytes);
      // Account before enqueueing: even a fast producer cannot build an unbounded write queue.
      bytes += Buffer.byteLength(retained);
      log.chars += retained.length;
      log.truncated = retained.length < text.length;
      if (retained) {
        stream?.write(retained);
      }
    },
    async close() {
      closed = true;
      stream?.end();
      await completion;
    },
  };
}

export function execOutputLogDetails(log?: ExecOutputLog) {
  return log
    ? {
        ...(log.path ? { fullOutputPath: log.path } : {}),
        spilledChars: log.chars,
        spillTruncated: log.truncated || log.failed,
        ...(log.failed
          ? { outputLogError: "Output capture failed; check disk space and workdir permissions." }
          : {}),
      }
    : {};
}

export function canRecoverExecOutput(
  log: ExecOutputLog | undefined,
  discardedChars: number,
): boolean {
  // A truncated saved prefix can still cover everything discarded from the in-memory tail.
  return Boolean(log?.path && !log.failed && log.chars >= discardedChars);
}

export function execOutputLogNote(log?: ExecOutputLog): string {
  if (!log) {
    return "";
  }
  if (!log.path) {
    return "[Output capture failed; command execution continued. Check disk space and workdir permissions.]\n\n";
  }
  const limitation = log.failed
    ? " Write failed; saved content may be incomplete."
    : log.truncated
      ? " Only the first 2 MiB of output was retained."
      : "";
  return `[${formatFullOutputFooter(log.path)}.${limitation}]\n\n`;
}
