import { getMe, ZaloApiError } from "./api.js";
async function probeZalo(token, timeoutMs = 5e3, fetcher) {
  if (!token?.trim()) {
    return { ok: false, error: "No token provided", elapsedMs: 0 };
  }
  const startTime = Date.now();
  try {
    const response = await getMe(token.trim(), timeoutMs, fetcher);
    const elapsedMs = Date.now() - startTime;
    if (response.ok && response.result) {
      return { ok: true, bot: response.result, elapsedMs };
    }
    return { ok: false, error: "Invalid response from Zalo API", elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    if (err instanceof ZaloApiError) {
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
export {
  probeZalo
};
