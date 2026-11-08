import { normalizeLineAllowEntry } from "./bot-access.js";
import type { ResolvedLineAccount } from "./types.js";

type LineCredentialAccount = Partial<
  Pick<
    ResolvedLineAccount,
    "channelAccessToken" | "channelSecret" | "tokenStatus" | "signingSecretStatus"
  >
>;

export function hasLineCredentials(account: LineCredentialAccount): boolean {
  if (account.tokenStatus && account.signingSecretStatus) {
    return account.tokenStatus !== "missing" && account.signingSecretStatus !== "missing";
  }
  return Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim());
}

export function parseLineAllowFromId(raw: string): string | null {
  const trimmed = normalizeLineAllowEntry(raw);
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
