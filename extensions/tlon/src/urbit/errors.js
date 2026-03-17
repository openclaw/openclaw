class UrbitError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "UrbitError";
    this.code = code;
  }
}
class UrbitUrlError extends UrbitError {
  constructor(message, options) {
    super("invalid_url", message, options);
    this.name = "UrbitUrlError";
  }
}
class UrbitHttpError extends UrbitError {
  constructor(params) {
    const suffix = params.bodyText ? ` - ${params.bodyText}` : "";
    super("http_error", `${params.operation} failed: ${params.status}${suffix}`, {
      cause: params.cause
    });
    this.name = "UrbitHttpError";
    this.status = params.status;
    this.operation = params.operation;
    this.bodyText = params.bodyText;
  }
}
class UrbitAuthError extends UrbitError {
  constructor(code, message, options) {
    super(code, message, options);
    this.name = "UrbitAuthError";
  }
}
export {
  UrbitAuthError,
  UrbitError,
  UrbitHttpError,
  UrbitUrlError
};
