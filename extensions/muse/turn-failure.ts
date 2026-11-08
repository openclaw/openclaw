// Muse turn-failure mapping: the typed quota signal decides failover, never the wording.
/** The typed quota signal MSP sends on a failed turn (`msp.d.ts` `TurnError.quota`). */
type MuseTurnQuota = { limitKind?: string | undefined; resetsAtMs?: number | undefined };
type MuseTurnError = {
  kind?: string | undefined;
  message?: string | undefined;
  quota?: MuseTurnQuota | undefined;
  retryable?: boolean | undefined;
};

/**
 * Muse reports quota exhaustion as a typed field, and MSP's contract says clients must
 * branch on its presence rather than parse the message. Status 429 keeps the host's
 * failover classification working for wording like "quota exhausted" or "Tier limit
 * reached", which the text classifier does not recognize.
 */
export class MuseQuotaLimitError extends Error {
  readonly status = 429;
}

/** Maps a failed Muse turn onto the error the host should classify. */
export function museTurnFailureError(
  turnError: MuseTurnError | undefined,
  reason: string | undefined,
): Error {
  if (turnError?.quota) {
    const resetsAtMs = turnError.quota.resetsAtMs;
    const resetHint =
      typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs)
        ? ` Quota resets at ${new Date(resetsAtMs).toISOString()}.`
        : "";
    const detail = turnError.message ?? reason ?? "Muse Code quota exhausted.";
    return new MuseQuotaLimitError(`Muse Code: ${detail}${resetHint}`);
  }
  return new Error(
    turnError?.kind === "authRequired"
      ? `Muse Code is not signed in on the Gateway host (${turnError.message}). Run \`muse login\` there, or set META_API_KEY for the Gateway.`
      : (turnError?.message ??
          reason ??
          "Muse model request failed. Run muse to check login and model access."),
  );
}
