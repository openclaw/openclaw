import { clearActiveProgressLine } from "./progress-line.js";

/** Writer facade that tracks closed/broken-pipe state. */
export type SafeStreamWriter = {
  write: (stream: NodeJS.WriteStream, text: string) => boolean;
  writeLine: (stream: NodeJS.WriteStream, text: string) => boolean;
};

/** Detect broken pipe style stream errors. */
function isBrokenPipeError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPIPE" || code === "EIO";
}

/** Create a stream writer that stops writing after EPIPE/EIO. */
export function createSafeStreamWriter(
  onBrokenPipe?: (err: NodeJS.ErrnoException, stream: NodeJS.WriteStream) => void,
): SafeStreamWriter {
  let closed = false;

  const write = (stream: NodeJS.WriteStream, text: string): boolean => {
    if (closed) {
      return false;
    }
    let errorStream: NodeJS.WriteStream = process.stderr;
    try {
      clearActiveProgressLine();
      errorStream = stream;
      stream.write(text);
      return !closed;
    } catch (err) {
      if (!isBrokenPipeError(err)) {
        throw err;
      }
      if (!closed) {
        closed = true;
        onBrokenPipe?.(err, errorStream);
      }
      return false;
    }
  };

  return {
    write,
    writeLine: (stream, text) => write(stream, `${text}\n`),
  };
}
