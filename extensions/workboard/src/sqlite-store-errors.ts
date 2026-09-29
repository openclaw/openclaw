export type WorkboardSqliteFailure = {
  error: Error;
  name?: string;
  code?: string | number;
  errcode?: number;
  errstr?: string;
  cleanupConnection?: number;
  aggregate?: WorkboardSqliteFailure[];
  cause?: WorkboardSqliteFailure;
};
export type WorkboardSqliteResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: WorkboardSqliteFailure };

export function encodeWorkboardSqliteFailure(
  error: unknown,
  seen = new Map<Error, WorkboardSqliteFailure>(),
): WorkboardSqliteFailure {
  const failure = error instanceof Error ? error : new Error(String(error));
  const existing = seen.get(failure);
  if (existing) {
    return existing;
  }
  // V8 preserves standard Error kinds, but omits AggregateError details and SQLite fields.
  const encoded: WorkboardSqliteFailure = {
    error: failure,
    name: failure.name,
    ...("code" in failure && (typeof failure.code === "string" || typeof failure.code === "number")
      ? { code: failure.code }
      : {}),
    ...("errcode" in failure && typeof failure.errcode === "number"
      ? { errcode: failure.errcode }
      : {}),
    ...("errstr" in failure && typeof failure.errstr === "string"
      ? { errstr: failure.errstr }
      : {}),
  };
  seen.set(failure, encoded);
  if (failure instanceof AggregateError) {
    encoded.aggregate = failure.errors.map((entry) => encodeWorkboardSqliteFailure(entry, seen));
  }
  if (failure.cause instanceof Error) {
    encoded.cause = encodeWorkboardSqliteFailure(failure.cause, seen);
  }
  return encoded;
}

function decodeWorkboardSqliteFailure(
  failure: WorkboardSqliteFailure,
  seen = new Map<WorkboardSqliteFailure, Error>(),
): Error {
  const existing = seen.get(failure);
  if (existing) {
    return existing;
  }
  const error = failure.aggregate ? new AggregateError([], failure.error.message) : failure.error;
  seen.set(failure, error);
  if (failure.name !== undefined) {
    error.name = failure.name;
  }
  if (failure.error.stack !== undefined) {
    error.stack = failure.error.stack;
  }
  Object.assign(error, {
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.errcode === undefined ? {} : { errcode: failure.errcode }),
    ...(failure.errstr === undefined ? {} : { errstr: failure.errstr }),
  });
  if (failure.cause) {
    error.cause = decodeWorkboardSqliteFailure(failure.cause, seen);
  }
  if (failure.aggregate) {
    Object.assign(error, {
      errors: failure.aggregate.map((entry) => decodeWorkboardSqliteFailure(entry, seen)),
    });
  }
  return error;
}

export function unwrapWorkboardSqliteResult<T>(result: WorkboardSqliteResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw decodeWorkboardSqliteFailure(result.failure);
}
