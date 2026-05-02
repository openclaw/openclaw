import { canonicalize } from "./canonical.js";
import { fromHex, parsePubkey, sign, toHex, verify } from "./identity.js";

export type Announcement = {
  version: 1;
  pubkey: string;
  url: string;
  label?: string;
  models?: string[];
  ttlSeconds: number;
  announcedAt: number;
};

export type SignedAnnouncement = {
  announcement: Announcement;
  signature: string;
};

export const ANNOUNCEMENT_MAX_SKEW_MS = 5 * 60 * 1000;

const enc = new TextEncoder();

export const signAnnouncement = (
  announcement: Announcement,
  secretKey: Uint8Array,
): SignedAnnouncement => {
  const signature = sign(enc.encode(canonicalize(announcement)), secretKey);
  return { announcement, signature: toHex(signature) };
};

export const verifyAnnouncement = (signed: SignedAnnouncement): boolean => {
  try {
    const pk = parsePubkey(signed.announcement.pubkey);
    return verify(fromHex(signed.signature), enc.encode(canonicalize(signed.announcement)), pk);
  } catch {
    return false;
  }
};

export type AnnouncementStatus = "ok" | "future" | "stale";

export const announcementStatus = (
  a: Announcement,
  now: number = Date.now(),
): AnnouncementStatus => {
  const skew = a.announcedAt - now;
  if (skew > ANNOUNCEMENT_MAX_SKEW_MS) return "future";
  const age = now - a.announcedAt;
  if (age > a.ttlSeconds * 1000) return "stale";
  return "ok";
};
