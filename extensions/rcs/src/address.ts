// Rcs plugin module implements address normalization behavior.
//
// RCS conversations have two address shapes:
// - identity: bare E.164 (`+15551234567`) used for allowlists, pairing, and session ids
// - wire: `rcs:+15551234567` used in Twilio To/From fields for RCS-routed traffic
const RCS_ADDRESS_PREFIX = /^(?:rcs|sms|twilio-rcs):/i;

export function normalizeRcsIdentity(raw: string): string {
  const trimmed = raw.trim().replace(RCS_ADDRESS_PREFIX, "");
  if (!trimmed) {
    return "";
  }
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  return withPlus.replace(/[^\d+]/g, "");
}

export function looksLikeRcsTarget(raw: string): boolean {
  const normalized = normalizeRcsIdentity(raw);
  return /^\+[1-9]\d{6,14}$/.test(normalized);
}

export function toRcsWireAddress(identity: string): string {
  const normalized = normalizeRcsIdentity(identity);
  return normalized ? `rcs:${normalized}` : "";
}

export function isRcsWireAddress(raw: string): boolean {
  return /^rcs:/i.test(raw.trim());
}

export function normalizeRcsSenderId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return /^rcs:/i.test(trimmed) ? `rcs:${trimmed.slice(4)}` : `rcs:${trimmed}`;
}

export function normalizeRcsAllowFrom(raw: string): string {
  if (raw.trim() === "*") {
    return "*";
  }
  return normalizeRcsIdentity(raw).toLowerCase();
}
