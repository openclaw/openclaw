/// <reference lib="es2024.promise" />
import { AsyncLocalStorage } from "node:async_hooks";

export type RetainedOutcome<T> =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "fulfilled"; value: T }>
  | Readonly<{ status: "rejected"; error: unknown }>;

export type RetainedOperation<T> = {
  readonly result: Promise<T>;
  read(): RetainedOutcome<T>;
  service(): void;
};

/** One producer settlement serves awaited callers and its named synchronous consumer. */
export function createRetainedOperation<T>(
  service: () => void,
  options: { observeRejection?: boolean } = {},
): {
  operation: RetainedOperation<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  const completion = Promise.withResolvers<T>();
  let outcome: RetainedOutcome<T> = Object.freeze({ status: "pending" });
  // A synchronous consumer can observe rejection without ever awaiting result.
  if (options.observeRejection !== false) {
    void completion.promise.catch(() => undefined);
  }
  return {
    operation: {
      result: completion.promise,
      read: () => outcome,
      service,
    },
    resolve(value) {
      if (outcome.status !== "pending") {
        return;
      }
      outcome = Object.freeze({ status: "fulfilled", value });
      completion.resolve(value);
    },
    reject(error) {
      if (outcome.status !== "pending") {
        return;
      }
      outcome = Object.freeze({ status: "rejected", error });
      completion.reject(error);
    },
  };
}

/** Transform settled facts without making Promise reactions part of their progress. */
export function mapRetainedOperation<T, U>(
  source: RetainedOperation<T>,
  receive: (value: T) => U,
): RetainedOperation<U> {
  const inContext = AsyncLocalStorage.snapshot();
  let servicing = false;
  const serviceInContext = () => inContext(service);
  const completion = createRetainedOperation<U>(serviceInContext);
  function service() {
    if (servicing || completion.operation.read().status !== "pending") {
      return;
    }
    servicing = true;
    try {
      source.service();
      const outcome = source.read();
      if (outcome.status === "fulfilled") {
        completion.resolve(receive(outcome.value));
      } else if (outcome.status === "rejected") {
        completion.reject(outcome.error);
      }
    } catch (error) {
      completion.reject(error);
    } finally {
      servicing = false;
    }
  }
  void source.result.then(serviceInContext, serviceInContext);
  completion.operation.service();
  return completion.operation;
}

/** Sequence operations while retaining the continuation's captured caller context. */
export function flatMapRetainedOperation<T, U>(
  source: RetainedOperation<T>,
  next: (value: T) => RetainedOperation<U>,
): RetainedOperation<U> {
  const inContext = AsyncLocalStorage.snapshot();
  let child: RetainedOperation<U> | undefined;
  let servicing = false;
  const serviceInContext = () => inContext(service);
  const completion = createRetainedOperation<U>(serviceInContext);
  function service() {
    if (servicing || completion.operation.read().status !== "pending") {
      return;
    }
    servicing = true;
    try {
      if (!child) {
        source.service();
        const outcome = source.read();
        if (outcome.status === "pending") {
          return;
        }
        if (outcome.status === "rejected") {
          throw outcome.error;
        }
        child = next(outcome.value);
        void child.result.then(serviceInContext, serviceInContext);
      }
      child.service();
      const outcome = child.read();
      if (outcome.status === "fulfilled") {
        completion.resolve(outcome.value);
      } else if (outcome.status === "rejected") {
        completion.reject(outcome.error);
      }
    } catch (error) {
      completion.reject(error);
    } finally {
      servicing = false;
    }
  }
  void source.result.then(serviceInContext, serviceInContext);
  completion.operation.service();
  return completion.operation;
}

/** Join the owner's real cleanup; that owner chooses how simultaneous failures combine. */
export function finallyRetainedOperation<T>(
  source: RetainedOperation<T>,
  cleanup: (outcome: Exclude<RetainedOutcome<T>, { status: "pending" }>) => RetainedOperation<void>,
  combineErrors: (sourceError: unknown, cleanupError: unknown) => unknown = (
    _source,
    cleanupError,
  ) => cleanupError,
): RetainedOperation<T> {
  const inContext = AsyncLocalStorage.snapshot();
  let original: Exclude<RetainedOutcome<T>, { status: "pending" }> | undefined;
  let child: RetainedOperation<void> | undefined;
  let servicing = false;
  const serviceInContext = () => inContext(service);
  const completion = createRetainedOperation<T>(serviceInContext);
  function service() {
    if (servicing || completion.operation.read().status !== "pending") {
      return;
    }
    servicing = true;
    try {
      if (!original) {
        try {
          source.service();
          const outcome = source.read();
          if (outcome.status === "pending") {
            return;
          }
          original = outcome;
        } catch (error) {
          original = { status: "rejected", error };
        }
        child = cleanup(original);
        void child.result.then(serviceInContext, serviceInContext);
      }
      if (!child) {
        return;
      }
      child.service();
      const outcome = child.read();
      if (outcome.status === "pending") {
        return;
      }
      if (outcome.status === "rejected") {
        throw outcome.error;
      }
      if (original.status === "rejected") {
        completion.reject(original.error);
      } else {
        completion.resolve(original.value);
      }
    } catch (error) {
      try {
        completion.reject(
          original?.status === "rejected" ? combineErrors(original.error, error) : error,
        );
      } catch (combined) {
        completion.reject(combined);
      }
    } finally {
      servicing = false;
    }
  }
  void source.result.then(serviceInContext, serviceInContext);
  completion.operation.service();
  return completion.operation;
}
