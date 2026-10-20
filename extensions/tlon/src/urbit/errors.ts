import { redactUrbitErrorText } from "./redact.js";

export class UrbitUrlError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UrbitUrlError";
  }
}

export class UrbitHttpError extends Error {
  readonly status: number;
  readonly operation: string;
  readonly bodyText?: string;

  constructor(params: { operation: string; status: number; bodyText?: string; cause?: unknown }) {
    // A ship or proxy can reflect the session cookie sent with the request in the
    // error body; mask it before the text enters messages, logs, or diagnostics.
    const bodyText = params.bodyText ? redactUrbitErrorText(params.bodyText) : undefined;
    const suffix = bodyText ? ` - ${bodyText}` : "";
    super(`${params.operation} failed: ${params.status}${suffix}`, {
      cause: params.cause,
    });
    this.name = "UrbitHttpError";
    this.status = params.status;
    this.operation = params.operation;
    this.bodyText = bodyText;
  }
}

export class UrbitAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UrbitAuthError";
  }
}
