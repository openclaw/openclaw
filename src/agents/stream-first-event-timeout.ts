type StreamStage = "responses" | "completions";

export type FirstStreamEventTimeoutContext = {
  provider?: string;
  api?: string;
  model?: string;
  timeoutMs: number;
  stage?: StreamStage;
  hint?: string;
  abort?: (reason: Error) => void;
};

export type FirstStreamEventAbortController = {
  signal: AbortSignal;
  abort: (reason: Error) => void;
  dispose: () => void;
};

function formatOptionalField(name: string, value: string | undefined): string {
  return value ? ` ${name}=${value}` : "";
}

export function createFirstStreamEventTimeoutError(context: FirstStreamEventTimeoutContext): Error {
  const stage = context.stage ? `${context.stage} ` : "";
  const details = [
    formatOptionalField("provider", context.provider),
    formatOptionalField("api", context.api),
    formatOptionalField("model", context.model),
  ].join("");
  return new Error(
    `${stage}HTTP stream opened but did not deliver a first SSE event within ${context.timeoutMs}ms after streaming headers.${details}` +
      (context.hint ? ` ${context.hint}` : ""),
  );
}

export function createFirstStreamEventAbortController(
  parentSignal?: AbortSignal,
): FirstStreamEventAbortController {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    abort(reason: Error) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    dispose() {
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function withFirstStreamEventTimeout<T>(
  stream: AsyncIterable<T>,
  context: FirstStreamEventTimeoutContext,
): AsyncIterable<T> {
  if (context.timeoutMs <= 0 || !Number.isFinite(context.timeoutMs)) {
    return stream;
  }
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clear = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      try {
        const first = await new Promise<IteratorResult<T>>((resolve, reject) => {
          timer = setTimeout(() => {
            const timeoutError = createFirstStreamEventTimeoutError(context);
            context.abort?.(timeoutError);
            reject(timeoutError);
          }, context.timeoutMs);
          timer.unref?.();
          iterator.next().then(resolve, reject);
        }).finally(clear);
        if (first.done) {
          return;
        }
        yield first.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            return;
          }
          yield next.value;
        }
      } catch (error) {
        void iterator.return?.().catch(() => undefined);
        throw error;
      } finally {
        clear();
      }
    },
  };
}
