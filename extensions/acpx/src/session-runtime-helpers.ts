export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class InterruptedError extends Error {
  constructor() {
    super("Interrupted");
    this.name = "InterruptedError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (timeoutMs == null || timeoutMs <= 0) {
    return await promise;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function withInterrupt<T>(
  run: () => Promise<T>,
  onInterrupt: () => Promise<void>,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (cb: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
      cb();
    };

    const rejectInterrupted = () => {
      void onInterrupt().finally(() => {
        finish(() => reject(new InterruptedError()));
      });
    };

    const onSigint = () => {
      rejectInterrupted();
    };

    const onSigterm = () => {
      rejectInterrupted();
    };

    const onSighup = () => {
      rejectInterrupted();
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);

    void run().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}
