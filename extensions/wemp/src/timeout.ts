export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null>;
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T>;
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback?: T,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T | null>((resolve) => {
        timer = setTimeout(() => resolve(fallback ?? null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withTimeoutStatus<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ value: T | null; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false })),
      new Promise<{ value: null; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ value: null, timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
