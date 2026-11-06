import { redactUrbitErrorText } from "./redact.js";

export class UrbitUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrbitUrlError";
  }
}

export class UrbitHttpError extends Error {
  readonly status: number;

  constructor(params: { operation: string; status: number; bodyText?: string }) {
    // A ship or proxy can reflect the session cookie sent with the request in the
    // error body; mask it before the text enters messages, logs, or diagnostics.
    const bodyText = params.bodyText ? redactUrbitErrorText(params.bodyText) : undefined;
    const suffix = bodyText ? ` - ${bodyText}` : "";
    super(`${params.operation} failed: ${params.status}${suffix}`);
    this.name = "UrbitHttpError";
    this.status = params.status;
  }
}

export class UrbitAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrbitAuthError";
  }
}
