import { getBotInfo, KakaoApiError, type KakaoBotInfo, type KakaoFetch } from "./api.js";

export type KakaoProbeResult = {
  ok: boolean;
  bot?: KakaoBotInfo;
  error?: string;
  elapsedMs: number;
};

export async function probeKakao(
  appKey: string,
  timeoutMs = 5000,
  fetcher?: KakaoFetch,
): Promise<KakaoProbeResult> {
  if (!appKey?.trim()) {
    return { ok: false, error: "No app key provided", elapsedMs: 0 };
  }

  const startTime = Date.now();

  try {
    const response = await getBotInfo(appKey.trim(), timeoutMs, fetcher);
    const elapsedMs = Date.now() - startTime;

    if (response.success && response.info) {
      return { ok: true, bot: response.info, elapsedMs };
    }

    return { ok: false, error: "Invalid response from KakaoWork API", elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;

    if (err instanceof KakaoApiError) {
      return { ok: false, error: err.description ?? err.message, elapsedMs };
    }

    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return { ok: false, error: `Request timed out after ${timeoutMs}ms`, elapsedMs };
      }
      return { ok: false, error: err.message, elapsedMs };
    }

    return { ok: false, error: String(err), elapsedMs };
  }
}
