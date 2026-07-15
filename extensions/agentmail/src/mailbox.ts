import { Address, Group, parseFrom } from "@haraka/email-address";

export function normalizeMailbox(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function parseSingleFromMailbox(value: string): { address: string; name?: string } | null {
  try {
    const parsed = parseFrom(value);
    if (parsed.length !== 1 || parsed[0] instanceof Group || !(parsed[0] instanceof Address)) {
      return null;
    }
    const address = normalizeMailbox(parsed[0].address);
    if (!address) {
      return null;
    }
    const name = parsed[0].phrase.trim();
    return { address, ...(name ? { name } : {}) };
  } catch {
    return null;
  }
}

export function isAgentMailSenderAllowed(params: {
  policy: "allowlist" | "open" | "disabled";
  allowFrom: readonly string[];
  sender: string;
}): boolean {
  if (params.policy === "disabled") {
    return false;
  }
  const allowFrom = new Set(params.allowFrom.map(normalizeMailbox));
  if (params.policy === "open") {
    return allowFrom.has("*");
  }
  return allowFrom.has(normalizeMailbox(params.sender));
}
