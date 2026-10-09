import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";

const TELEGRAM_STARTUP_PROBE_CONCURRENCY = 2;
const startupProbePermits = createPermitPool(TELEGRAM_STARTUP_PROBE_CONCURRENCY);

export async function withTelegramStartupProbeSlot<T>(
  abortSignal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const release = await startupProbePermits.acquire({ signal: abortSignal });
  try {
    if (!release || abortSignal?.aborted) {
      throw new Error("telegram startup check wait aborted");
    }
    return await run();
  } finally {
    release?.();
  }
}
