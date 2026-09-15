// Line helper module supports account helpers behavior.
type LineCredentialAccount = {
  channelAccessToken?: string;
  channelSecret?: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  signingSecretStatus?: "available" | "configured_unavailable" | "missing";
};

/**
 * Reports whether both credentials are configured. A credential whose source was named
 * but could not be read ("configured_unavailable") still counts, so status keeps the
 * account visible as configured but unavailable instead of calling it unconfigured.
 */
export function hasLineCredentials(account: LineCredentialAccount): boolean {
  if (account.tokenStatus && account.signingSecretStatus) {
    return account.tokenStatus !== "missing" && account.signingSecretStatus !== "missing";
  }
  return hasUsableLineCredentials(account);
}

/** Running the account needs both values; a credential file that could not be read resolves to "". */
export function hasUsableLineCredentials(account: LineCredentialAccount): boolean {
  return Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim());
}

export function parseLineAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
