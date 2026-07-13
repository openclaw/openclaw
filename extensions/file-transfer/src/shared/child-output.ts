// File Transfer helpers keep child-process output consumption error-aware.
import type { Readable } from "node:stream";

export function consumeChildOutput(
  stream: Readable,
  handlers: {
    onData: (chunk: Buffer) => void;
    onError: (error: Error) => void;
  },
): void {
  // Child stdout/stderr are independent EventEmitters: child `error`/`close`
  // cannot absorb a pipe error, so every consumed output owns both outcomes.
  stream.on("data", handlers.onData);
  stream.on("error", handlers.onError);
}
