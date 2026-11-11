import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

export const unsupportedSecretRefSurfacePatterns = [
  "channels.discord.threadBindings.webhookToken",
  "channels.discord.accounts.*.threadBindings.webhookToken",
] as const;

export function collectUnsupportedSecretRefConfigCandidates(
  raw: unknown,
): UnsupportedSecretRefConfigCandidate[] {
  if (!isRecord(raw) || !isRecord(raw.channels) || !isRecord(raw.channels.discord)) {
    return [];
  }

  const candidates: UnsupportedSecretRefConfigCandidate[] = [];
  const discord = raw.channels.discord;
  const addCandidate = (account: unknown, path: string) => {
    if (isRecord(account) && isRecord(account.threadBindings)) {
      candidates.push({
        path: `${path}.threadBindings.webhookToken`,
        value: account.threadBindings.webhookToken,
      });
    }
  };
  addCandidate(discord, "channels.discord");
  for (const [accountId, account] of Object.entries(
    isRecord(discord.accounts) ? discord.accounts : {},
  )) {
    addCandidate(account, `channels.discord.accounts.${accountId}`);
  }
  return candidates;
}
