import type { DeltaChatProbe } from "./types.js";

export async function probeDeltaChat({
  _accountId,
  _timeoutMs = 5000,
}: {
  _accountId?: string;
  _timeoutMs?: number;
}): Promise<DeltaChatProbe> {
  // Delta.Chat core doesn't have a simple "probe" endpoint
  // We'll check if the account is configured and can start IO
  const start = Date.now();
  try {
    // For now, we'll just return a basic probe
    // In a full implementation, we'd check the Delta.Chat core status
    const elapsedMs = Date.now() - start;
    return {
      ok: true,
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs,
    };
  }
}
