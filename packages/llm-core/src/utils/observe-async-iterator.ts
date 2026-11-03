type CloseReason = "return" | "throw" | "observer";

/**
 * Observe without a forwarding generator's per-event promises. Serial reads use
 * one stable continuation; overlapping operations retain generator FIFO/context.
 * The default close uses AsyncIteratorClose: source errors do not close, while
 * consumer/observer throws call return() and take precedence over cleanup errors.
 * onClose can retain a caller-owned cleanup policy; onFinally runs once after start.
 */
export function observeAsyncIterator<T>(options: {
  iterator: () => AsyncIterator<T>;
  onStart?: () => void;
  onEvent: (event: T) => void;
  onDone?: () => void;
  onError?: (error: unknown) => void;
  onClose?: (
    iterator: AsyncIterator<T> | undefined,
    reason: CloseReason,
  ) => Promise<unknown> | void;
  onFinally?: () => void;
  /** Eagerly acquired iterators may need cleanup even before the first read. */
  onUnopenedReturn?: (value: unknown) => Promise<IteratorResult<T>>;
}): Required<AsyncIterableIterator<T>> {
  let source: AsyncIterator<T> | undefined;
  let nextSource: AsyncIterator<T>["next"];
  let started = false;
  let closed = false;
  let reading = false;
  let active: Promise<IteratorResult<T>>;
  const queue: Array<{
    operation: () => Promise<IteratorResult<T>>;
    promise: Promise<IteratorResult<T>>;
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];

  function enqueue(operation: () => Promise<IteratorResult<T>>) {
    if (!reading) {
      reading = true;
      return (active = operation());
    }
    // Package declarations target ES2023, which lacks Promise.withResolvers.
    let resolve!: (result: IteratorResult<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<IteratorResult<T>>((resolvePending, rejectPending) => {
      resolve = resolvePending;
      reject = rejectPending;
    });
    queue.push({ operation, promise, resolve, reject });
    return promise;
  }
  function settled() {
    const pending = queue.shift();
    if (pending) {
      // Resume in the active operation's context, after its outward promise has
      // settled (including adoption of an asynchronous cleanup/rejection).
      const advance = () => {
        active = pending.promise;
        void pending.operation().then(pending.resolve, pending.reject);
      };
      void active.then(advance, advance);
    } else {
      reading = false;
    }
  }
  function finish() {
    try {
      if (started) {
        options.onFinally?.();
      }
    } finally {
      settled();
    }
  }
  function close(reason: CloseReason) {
    return options.onClose ? options.onClose(source, reason) : source?.return?.();
  }
  async function fail(error: unknown, reason?: CloseReason): Promise<never> {
    closed = true;
    try {
      if (reason) {
        try {
          const closing = close(reason);
          if (closing !== undefined) {
            await closing;
          }
        } catch {}
      }
      options.onError?.(error);
      throw error;
    } finally {
      finish();
    }
  }
  const rejectRead = (error: unknown) => fail(error);
  function observeNext(result: IteratorResult<T>): IteratorResult<T> | Promise<never> {
    let done: boolean | undefined;
    try {
      done = result.done;
    } catch (error) {
      return rejectRead(error);
    }
    if (done) {
      closed = true;
      try {
        options.onDone?.();
        return { done: true, value: undefined };
      } catch (error) {
        options.onError?.(error);
        throw error;
      } finally {
        finish();
      }
    }
    let value: T;
    try {
      // Iterator result accessors belong to the source, not the observer body.
      value = result.value;
    } catch (error) {
      return rejectRead(error);
    }
    try {
      options.onEvent(value);
      settled();
      return { done: false, value };
    } catch (error) {
      return fail(error, "observer");
    }
  }
  function read(): Promise<IteratorResult<T>> {
    if (closed) {
      settled();
      return Promise.resolve({ done: true, value: undefined });
    }
    try {
      if (!started) {
        options.onStart?.();
        started = true;
        source = options.iterator();
        nextSource = source.next.bind(source);
      }
      return Promise.resolve(nextSource()).then(observeNext, rejectRead);
    } catch (error) {
      return rejectRead(error);
    }
  }
  async function end(reason: "return" | "throw", value: unknown): Promise<IteratorResult<T>> {
    if (!started && !closed && reason === "return" && options.onUnopenedReturn) {
      closed = true;
      try {
        return await options.onUnopenedReturn(value);
      } finally {
        settled();
      }
    }
    let resolved = value;
    if (reason === "return") {
      try {
        resolved = await value;
      } catch (error) {
        return end("throw", error);
      }
    }
    if (closed || !started) {
      closed = true;
      settled();
      if (reason === "throw") {
        throw resolved;
      }
      return { done: true, value: resolved };
    }
    if (reason === "throw") {
      return fail(resolved, reason);
    }
    closed = true;
    try {
      await close(reason);
      return { done: true, value: resolved };
    } finally {
      finish();
    }
  }
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return enqueue(read);
    },
    return(value) {
      return enqueue(() => end("return", value));
    },
    throw(error) {
      return enqueue(() => end("throw", error));
    },
  };
}
