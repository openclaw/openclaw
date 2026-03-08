import { isNormalizedSenderAllowed } from "openclaw/plugin-sdk/zalo";

const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;

export function isZaloSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  return isNormalizedSenderAllowed({
    senderId,
    allowFrom,
    stripPrefixRe: ZALO_ALLOW_FROM_PREFIX_RE,
  });
}
