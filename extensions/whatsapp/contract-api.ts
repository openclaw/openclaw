type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const unsupportedSecretRefSurfacePatterns = [
  "channels.whatsapp.creds.json",
  "channels.whatsapp.accounts.*.creds.json",
] as const;

export { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./src/session-contract.js";
export { createWhatsAppPollFixture, expectWhatsAppPollSent } from "./src/outbound-test-support.js";
export { whatsappCommandPolicy } from "./src/command-policy.js";
export { resolveLegacyGroupSessionKey } from "./src/group-session-contract.js";
export { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./src/normalize-target.js";
export { __testing as whatsappAccessControlTesting } from "./src/inbound/access-control.js";

export function collectUnsupportedSecretRefConfigCandidates(
  raw: unknown,
): UnsupportedSecretRefConfigCandidate[] {
  if (!isRecord(raw)) {
    return [];
  }
  if (!isRecord(raw.channels) || !isRecord(raw.channels.whatsapp)) {
    return [];
  }

  const candidates: UnsupportedSecretRefConfigCandidate[] = [];
  const whatsapp = raw.channels.whatsapp;
  const creds = isRecord(whatsapp.creds) ? whatsapp.creds : null;
  if (creds) {
    candidates.push({
      path: "channels.whatsapp.creds.json",
      value: creds.json,
    });
  }

  const accounts = isRecord(whatsapp.accounts) ? whatsapp.accounts : null;
  if (!accounts) {
    return candidates;
  }
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account) || !isRecord(account.creds)) {
      continue;
    }
    candidates.push({
      path: `channels.whatsapp.accounts.${accountId}.creds.json`,
      value: account.creds.json,
    });
  }
  return candidates;
}
