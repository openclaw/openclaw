import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export class SignalRpcError extends Error {
  readonly code: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly hasCaptchaChallenge: boolean;
  #data: unknown;

  constructor(failure: unknown, safeMessage?: string) {
    const error = isRecord(failure) ? failure : {};
    const code = typeof error.code === "number" ? error.code : undefined;
    const response = isRecord(error.data) ? error.data.response : undefined;
    const results = isRecord(response) && Array.isArray(response.results) ? response.results : [];
    let retryAfterSeconds: number | undefined;
    let hasCaptchaChallenge = false;
    for (const result of results) {
      if (!isRecord(result) || result.type !== "RATE_LIMIT_FAILURE") {
        continue;
      }
      const retry = result.retryAfterSeconds;
      if (typeof retry === "number" && Number.isSafeInteger(retry) && retry >= 0) {
        retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, retry);
      }
      hasCaptchaChallenge ||= typeof result.token === "string" && result.token.length > 0;
    }
    // A proof-required message can echo the token. Render only its presence, not remote text.
    const detail = hasCaptchaChallenge
      ? "captcha challenge present; complete signal-cli's rate-limit challenge and retry"
      : (safeMessage ?? (typeof error.message === "string" ? error.message : "Signal RPC error"));
    const retryHint =
      retryAfterSeconds === undefined ? "" : `; retryAfterSeconds=${retryAfterSeconds}`;
    super(`Signal RPC ${code ?? "unknown"}: ${detail}${retryHint}`);
    this.name = "SignalRpcError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.hasCaptchaChallenge = hasCaptchaChallenge;
    this.#data = error.data;
  }

  // Keep raw results/tokens available to explicit callers, but out of JSON and normal inspection.
  get data(): unknown {
    return this.#data;
  }
}
