import type { IMessageRpcResponse } from "./client-types.js";

/**
 * Raised when the imsg subprocess prints a permission-denied banner to
 * stdout instead of a JSON-RPC frame. The most common trigger is macOS
 * Full Disk Access being revoked from the gateway's Node binary after a
 * version-manager bump (Homebrew, nvm, etc.). Once raised, every pending
 * request on the same client is rejected with this error and the client
 * marks itself permanently broken so the channel does not respawn imsg
 * straight back into the same denial.
 */
export class IMessagePermissionDeniedError extends Error {
  readonly code = "IMSG_PERMISSION_DENIED" as const;
  readonly snippet: string;

  constructor(snippet: string) {
    super(
      "imsg cannot read the Messages database. Grant Full Disk Access to the gateway's Node binary in System Settings, then restart the gateway.",
    );
    this.name = "IMessagePermissionDeniedError";
    this.snippet = snippet;
  }
}

export type StdoutClassification =
  | { kind: "empty" }
  | { kind: "json-frame"; parsed: IMessageRpcResponse<unknown> }
  | { kind: "permission-denied"; reason: string }
  | { kind: "noise" };

const PERMISSION_DENIED_PATTERN =
  /(permission\s+error|authorization\s+denied|full\s+disk\s+access)/i;

/**
 * Decide what a single stdout line from the imsg subprocess actually is.
 * imsg can write three kinds of output: JSON-RPC frames, blank lines, and
 * human-readable banners (e.g. the multi-line Full Disk Access help text).
 * Treating banner text as a malformed JSON frame is what produces the tight
 * log-flood loop this module exists to prevent.
 */
export function classifyImsgStdoutLine(line: string): StdoutClassification {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "empty" };
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as IMessageRpcResponse<unknown>;
      return { kind: "json-frame", parsed };
    } catch {
      // Looked like JSON, did not parse. Fall through to the noise path so
      // the operator still sees one grouped warning rather than an ERROR per
      // malformed frame.
      return { kind: "noise" };
    }
  }
  if (PERMISSION_DENIED_PATTERN.test(trimmed)) {
    return { kind: "permission-denied", reason: trimmed };
  }
  return { kind: "noise" };
}

export type ImsgStdoutHandlerCallbacks = {
  onJsonFrame: (parsed: IMessageRpcResponse<unknown>) => void;
  onPermissionDenied: (error: IMessagePermissionDeniedError) => void;
  onNoiseFlushed: (groupedText: string) => void;
};

/**
 * Buffers non-JSON stdout coming back from imsg so the operator sees one
 * grouped log entry per spawn cycle instead of one ERROR per banner line.
 * On detecting the permission-denied signature, raises a typed error
 * exactly once and routes every subsequent line into the same flush.
 */
export class ImsgStdoutHandler {
  private readonly maxBufferedLines: number;
  private readonly callbacks: ImsgStdoutHandlerCallbacks;
  private noiseBuffer: string[] = [];
  private permissionError: IMessagePermissionDeniedError | null = null;

  constructor(callbacks: ImsgStdoutHandlerCallbacks, opts: { maxBufferedLines?: number } = {}) {
    this.callbacks = callbacks;
    this.maxBufferedLines = opts.maxBufferedLines ?? 64;
  }

  handle(line: string): void {
    const classified = classifyImsgStdoutLine(line);
    switch (classified.kind) {
      case "empty":
        return;
      case "json-frame":
        // A real frame means imsg recovered. Flush any buffered banner so
        // the operator can still see what came before, then dispatch.
        this.flush();
        this.callbacks.onJsonFrame(classified.parsed);
        return;
      case "permission-denied":
        this.bufferLine(line);
        if (!this.permissionError) {
          this.permissionError = new IMessagePermissionDeniedError(classified.reason);
          this.callbacks.onPermissionDenied(this.permissionError);
        }
        return;
      case "noise":
        this.bufferLine(line);
        return;
    }
  }

  /**
   * Emit any buffered banner text as a single grouped string. Called when
   * imsg either recovers (a real JSON-RPC frame arrives) or the subprocess
   * closes. Safe to call repeatedly; a no-op when the buffer is empty.
   */
  flush(): void {
    if (this.noiseBuffer.length === 0) {
      return;
    }
    const grouped = this.noiseBuffer.join("\n");
    this.noiseBuffer = [];
    this.callbacks.onNoiseFlushed(grouped);
  }

  getPermissionError(): IMessagePermissionDeniedError | null {
    return this.permissionError;
  }

  private bufferLine(line: string): void {
    if (this.noiseBuffer.length >= this.maxBufferedLines) {
      return;
    }
    this.noiseBuffer.push(line.trimEnd());
  }
}
