// Minimax shares one response envelope across every API surface. Centralize the
// shape + assertion so tts/music/video fail identically instead of re-deriving
// the check per provider file.
export type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

// MiniMax returns HTTP 200 even for quota/billing/validation failures;
// base_resp.status_code is the only error signal (0 = success). Throwing lets
// callers treat envelope errors like transport errors (e.g. TTS fallback).
export function assertMinimaxBaseResp(
  baseResp: MinimaxBaseResp | undefined,
  context: string,
): void {
  if (!baseResp || typeof baseResp.status_code !== "number" || baseResp.status_code === 0) {
    return;
  }
  throw new Error(
    `${context} (${baseResp.status_code}): ${baseResp.status_msg ?? "unknown error"}`,
  );
}
