/**
 * Error thrown when a session transcript file cannot be parsed.
 *
 * Wraps the original SyntaxError so callers can distinguish a session-load
 * failure from a JSON parse error that occurred elsewhere during a prompt call
 * (e.g. inside a tool handler or model response decoder).
 */
export class SessionParseError extends Error {
  readonly sessionFile: string;

  constructor(message: string, params: { sessionFile: string; cause?: unknown }) {
    super(message, { cause: params.cause });
    this.name = "SessionParseError";
    this.sessionFile = params.sessionFile;
  }
}

export function isSessionParseError(err: unknown): err is SessionParseError {
  return err instanceof SessionParseError;
}
