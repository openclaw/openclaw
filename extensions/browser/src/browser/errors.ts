import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";

export class BrowserError extends Error {
  status: number;

  constructor(message: string, status = 500, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
  }
}

export class BrowserValidationError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

export class BrowserConfigurationError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

export class BrowserTargetAmbiguousError extends BrowserError {
  constructor(message = "ambiguous target id prefix", options?: ErrorOptions) {
    super(message, 409, options);
  }
}

export class BrowserTabNotFoundError extends BrowserError {
  constructor(message = "tab not found", options?: ErrorOptions) {
    super(message, 404, options);
  }
}

export class BrowserProfileNotFoundError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 404, options);
  }
}

export class BrowserConflictError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 409, options);
  }
}

export class BrowserResetUnsupportedError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

export class BrowserProfileUnavailableError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 409, options);
  }
}

export class BrowserResourceExhaustedError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 507, options);
  }
}

export function toBrowserErrorResponse(err: unknown): {
  status: number;
  message: string;
} | null {
  if (err instanceof BrowserError) {
    return { status: err.status, message: err.message };
  }
  if (err instanceof SsrFBlockedError) {
    return { status: 400, message: err.message };
  }
  if (
    err instanceof InvalidBrowserNavigationUrlError ||
    (err instanceof Error && err.name === "InvalidBrowserNavigationUrlError")
  ) {
    return { status: 400, message: err.message };
  }
  return null;
}
