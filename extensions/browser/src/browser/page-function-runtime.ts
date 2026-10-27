type BrowserEvaluateOptions = {
  fnSource: string;
  timeoutMs: number;
};

/** Serialized by Playwright; this body only runs in the browser. */
export function evaluateBrowserFunction(
  ...args: [options: BrowserEvaluateOptions] | [element: Element, options: BrowserEvaluateOptions]
): unknown {
  const options = args.length === 1 ? args[0] : args[1];
  try {
    // eslint-disable-next-line no-eval -- caller JavaScript executes only in the browser
    const candidate: unknown = eval(`"use strict";\n(${options.fnSource})`);
    if (typeof candidate !== "function") {
      throw new Error("evaluate source did not produce a function");
    }
    const result: unknown = args.length === 1 ? candidate() : candidate(args[0]);
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      return Promise.race([
        Promise.resolve(result),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`evaluate timed out after ${options.timeoutMs}ms`)),
            options.timeoutMs,
          );
        }),
      ]);
    }
    return result;
  } catch (error) {
    const message =
      error &&
      (typeof error === "object" || typeof error === "function") &&
      "message" in error &&
      error.message
        ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve arbitrary page-thrown message values, including custom toString
          String(error.message)
        : String(error);
    throw new Error(`Invalid evaluate function: ${message}`, { cause: error });
  }
}

export type BrowserWaitPredicateState = {
  document: unknown;
  source: string;
  pending?: boolean;
  predicate?: () => unknown;
  settled?: { kind: "value"; value: unknown } | { error: unknown; kind: "error" };
};

/** Serialized by Playwright; state stays in the original browser document. */
export function evaluateBrowserWaitPredicate(state: BrowserWaitPredicateState): boolean {
  if (state.document !== globalThis.document) {
    throw new Error("Wait predicate document changed");
  }
  if (!state.predicate) {
    // Global evaluation preserves the page function's ordinary `this` binding.
    // eslint-disable-next-line no-eval -- caller JavaScript executes only in the browser
    const candidate: unknown = globalThis.eval(`(${state.source})`);
    if (typeof candidate !== "function") {
      throw new Error("wait source did not produce a function");
    }
    state.predicate = () => candidate();
  }
  const settled = state.settled;
  if (settled) {
    delete state.settled;
    if (settled.kind === "error") {
      throw settled.error;
    }
    if (settled.value) {
      return true;
    }
  }
  if (state.pending) {
    return false;
  }
  const value = state.predicate();
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    !("then" in value) ||
    typeof value.then !== "function"
  ) {
    return Boolean(value);
  }
  state.pending = true;
  value.then(
    (resolved: unknown) => {
      state.settled = { kind: "value", value: resolved };
      delete state.pending;
    },
    (error: unknown) => {
      state.settled = { error, kind: "error" };
      delete state.pending;
    },
  );
  return false;
}
