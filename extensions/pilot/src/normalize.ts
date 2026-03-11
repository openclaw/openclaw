/**
 * Pilot Protocol address format: N:NNNN.HHHH.LLLL (48-bit, colon-separated segments).
 * Hostnames are human-readable labels registered with the daemon.
 */

const PILOT_ADDRESS_PATTERN = /^\d+:\d{4}\.\d{4}\.\d{4}$/;
const PILOT_HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9\-]{0,62}$/i;

export function looksLikePilotAddress(raw: string): boolean {
  return PILOT_ADDRESS_PATTERN.test(raw.trim());
}

export function looksLikePilotHostname(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (looksLikePilotAddress(trimmed)) {
    return false;
  }
  return PILOT_HOSTNAME_PATTERN.test(trimmed);
}

export function looksLikePilotTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  let target = trimmed;
  if (target.toLowerCase().startsWith("pilot:")) {
    target = target.slice("pilot:".length).trim();
  }
  return looksLikePilotAddress(target) || looksLikePilotHostname(target);
}

export function normalizePilotTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let target = trimmed;
  if (target.toLowerCase().startsWith("pilot:")) {
    target = target.slice("pilot:".length).trim();
  }
  if (!target || !looksLikePilotTargetId(target)) {
    return undefined;
  }
  return target;
}

export function normalizePilotAllowEntry(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (value.startsWith("pilot:")) {
    value = value.slice("pilot:".length);
  }
  return value.trim();
}

export function normalizePilotAllowlist(entries?: string[]): string[] {
  return (entries ?? []).map((entry) => normalizePilotAllowEntry(entry)).filter(Boolean);
}

export function resolvePilotAllowlistMatch(params: {
  allowFrom: string[];
  sender: string;
  senderHostname?: string;
}): { allowed: boolean; source?: string } {
  const allowFrom = new Set(
    params.allowFrom.map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  if (allowFrom.has("*")) {
    return { allowed: true, source: "wildcard" };
  }
  const senderLower = params.sender.trim().toLowerCase();
  if (allowFrom.has(senderLower)) {
    return { allowed: true, source: senderLower };
  }
  if (params.senderHostname) {
    const hostnameLower = params.senderHostname.trim().toLowerCase();
    if (allowFrom.has(hostnameLower)) {
      return { allowed: true, source: hostnameLower };
    }
  }
  return { allowed: false };
}
