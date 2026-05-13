export type RaceResult<T> =
  | { status: "success"; value: T }
  | { status: "timeout" }
  | { status: "aborted" };

export async function raceWithTimeoutAndAbort<T>(
  promise: Promise<T>,
  opts: { timeoutMs: number; abortSignal?: AbortSignal },
): Promise<RaceResult<T>> {
  const { timeoutMs, abortSignal } = opts;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  const timeoutOutcome = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  const abortOutcome: Promise<{ kind: "aborted" }> | Promise<never> = abortSignal
    ? new Promise<{ kind: "aborted" }>((resolve) => {
        if (abortSignal.aborted) {
          resolve({ kind: "aborted" });
          return;
        }
        abortHandler = () => resolve({ kind: "aborted" });
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      })
    : new Promise<never>(() => {});

  try {
    const winner = await Promise.race([
      promise.then((value) => ({ kind: "success" as const, value })),
      timeoutOutcome,
      abortOutcome,
    ]);

    if (winner.kind === "success") {
      return { status: "success", value: winner.value };
    }
    if (winner.kind === "timeout") {
      return { status: "timeout" };
    }
    return { status: "aborted" };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }
}
