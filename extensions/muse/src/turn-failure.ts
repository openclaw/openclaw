type FailedMuseTurn = {
  error?: { kind?: string; message: string; quota?: { limitKind: string; resetsAtMs: number } };
  reason?: string;
};

/**
 * Error for a Muse turn that ended as failed. MSP types the quota and sign-in classes, so the
 * host classifies them from the status and reads the quota reset without parsing text.
 */
export function createMuseTurnFailure(turn: FailedMuseTurn): Error {
  const turnError = turn.error;
  const quota = turnError?.quota;
  const authRequired = turnError?.kind === "authRequired";
  return Object.assign(
    new Error(
      quota
        ? `Muse usage limit reached (${quota.limitKind}); resets at ${new Date(quota.resetsAtMs).toISOString()}. ${turnError?.message}`
        : authRequired
          ? `Muse Code is not signed in on the Gateway host (${turnError?.message}). Run \`muse login\` there, or set META_API_KEY for the Gateway.`
          : (turnError?.message ??
            turn.reason ??
            "Muse model request failed. Run muse to check login and model access."),
    ),
    quota
      ? { status: 429, retryAfterMs: Math.max(0, quota.resetsAtMs - Date.now()) }
      : authRequired
        ? { status: 401 }
        : {},
  );
}
