import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeWhatsAppAllowFromEntry } from "./allowlist-format.js";
import {
  readWhatsAppLidToPnMapping,
  readWhatsAppPnToLidMapping,
  type WhatsAppLidMappingFileOptions,
} from "./lid-mapping-files.js";
import { stripWhatsAppTargetPrefixes } from "./whatsapp-jid-syntax.js";
import {
  classifyWhatsAppDirectJid,
  classifyWhatsAppJid,
  encodeWhatsAppJid,
  type WhatsAppDirectJid,
} from "./whatsapp-jid.js";

export type WebChannel = "web";

export function assertWebChannel(input: string): asserts input is WebChannel {
  if (input !== "web") {
    throw new Error("Web channel must be 'web'");
  }
}

export function isSelfChatMode(
  selfE164: string | null | undefined,
  allowFrom?: Array<string | number> | null,
): boolean {
  if (!selfE164 || !allowFrom?.length) {
    return false;
  }
  const normalizedSelf = normalizeWhatsAppAllowFromEntry(selfE164);
  if (!normalizedSelf || normalizedSelf === "*") {
    return false;
  }
  return allowFrom.some((n) => {
    const normalized = normalizeWhatsAppAllowFromEntry(String(n));
    return normalized !== "*" && normalized === normalizedSelf;
  });
}

export function toWhatsappJid(number: string): string {
  const withoutPrefix = stripWhatsAppTargetPrefixes(number);
  if (withoutPrefix.includes("@")) {
    const classified = classifyWhatsAppJid(withoutPrefix);
    if (classified.kind === "unsupported") {
      throw new Error(`Invalid WhatsApp JID: ${withoutPrefix}`);
    }
    return classified.jid;
  }
  const e164 = normalizeE164(withoutPrefix);
  const digits = e164.replace(/\D/g, "");
  return encodeWhatsAppJid(digits, "s.whatsapp.net");
}

// LID-aware outbound JID resolver. When a forward mapping file
// `lid-mapping-{phone-digits}.json` is present in any candidate dir, prefer
// the `{lid}@lid` JID over `{phone-digits}@s.whatsapp.net`. This avoids the
// ghost-chat failure mode where messages route to a sender-only thread that
// never reaches recipients whose contact is internally LID-based (#67378).
export function toWhatsappJidWithLid(number: string, opts?: JidToE164Options): string {
  const stripped = stripWhatsAppTargetPrefixes(number);
  if (stripped.includes("@")) {
    return toWhatsappJid(stripped);
  }
  const e164 = normalizeE164(stripped);
  const phoneDigits = e164.replace(/\D/g, "");
  const lid = readWhatsAppPnToLidMapping({ phoneDigits, options: opts });
  return lid ? encodeWhatsAppJid(lid, "lid") : encodeWhatsAppJid(phoneDigits, "s.whatsapp.net");
}

export type JidToE164Options = WhatsAppLidMappingFileOptions & {
  logMissing?: boolean;
};

type LidLookup = {
  getLIDForPN?: (jid: string) => Promise<string | null>;
  getPNForLID?: (jid: string) => Promise<string | null>;
};

function addUniqueString(target: string[], value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized && !target.includes(normalized)) {
    target.push(normalized);
  }
}

async function tryLookupMappedJid(
  lookup: () => Promise<string | null> | undefined,
): Promise<string | null> {
  try {
    return (await lookup()) ?? null;
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`LID mapping lookup failed: ${String(err)}`);
    }
    return null;
  }
}

function addEquivalentDirectChatCandidate(
  target: string[],
  jid: string | null | undefined,
  expectedKind?: WhatsAppDirectJid["kind"],
): void {
  const classified = classifyWhatsAppDirectJid(jid);
  if (!classified || (expectedKind && classified.kind !== expectedKind)) {
    return;
  }
  addUniqueString(target, classified.jid);
  const aliasServer =
    classified.kind === "pn"
      ? classified.server === "hosted"
        ? "s.whatsapp.net"
        : "hosted"
      : classified.server === "hosted.lid"
        ? "lid"
        : "hosted.lid";
  // Baileys collapses hosted domains on receive. Keep both routing aliases so
  // reactions can find bindings saved under the original delivered JID.
  addUniqueString(target, encodeWhatsAppJid(classified.user, aliasServer));
}

export async function resolveEquivalentWhatsAppDirectChatJids(
  jid: string | null | undefined,
  opts?: JidToE164Options & { lidLookup?: LidLookup },
): Promise<string[]> {
  const directJid = classifyWhatsAppDirectJid(jid);
  if (!directJid) {
    return [];
  }

  const candidates: string[] = [];
  addEquivalentDirectChatCandidate(candidates, directJid.jid);
  if (directJid.kind === "pn") {
    const mappedLid = await tryLookupMappedJid(() => opts?.lidLookup?.getLIDForPN?.(directJid.jid));
    addEquivalentDirectChatCandidate(candidates, mappedLid, "lid");

    const mappedLocalLid = readWhatsAppPnToLidMapping({
      phoneDigits: directJid.user,
      options: opts,
    });
    const localLidDomain = directJid.server === "hosted" ? "hosted.lid" : "lid";
    addEquivalentDirectChatCandidate(
      candidates,
      mappedLocalLid ? encodeWhatsAppJid(mappedLocalLid, localLidDomain) : null,
    );
    return candidates;
  }

  const e164 = await resolveJidToE164(directJid.jid, { ...opts, logMissing: false });
  const localPnDomain = directJid.server === "hosted.lid" ? "hosted" : "s.whatsapp.net";
  addEquivalentDirectChatCandidate(
    candidates,
    e164 ? encodeWhatsAppJid(e164.replace(/\D/g, ""), localPnDomain) : null,
  );
  return candidates;
}

export function jidToE164(jid: string, opts?: JidToE164Options): string | null {
  const directJid = classifyWhatsAppDirectJid(jid);
  if (!directJid) {
    return null;
  }
  if (directJid.kind === "pn") {
    return `+${directJid.user}`;
  }
  const mapping = readWhatsAppLidToPnMapping({
    lid: directJid.user,
    options: opts,
  });
  if (mapping.kind === "mapped") {
    return mapping.e164;
  }
  const shouldLog = opts?.logMissing ?? shouldLogVerbose();
  if (shouldLog) {
    logVerbose(`LID mapping not found for ${directJid.user}; skipping inbound message`);
  }
  return null;
}

export async function resolveJidToE164(
  jid: string | null | undefined,
  opts?: JidToE164Options & { lidLookup?: LidLookup },
): Promise<string | null> {
  if (!jid) {
    return null;
  }
  const directJid = classifyWhatsAppDirectJid(jid);
  if (!directJid) {
    return null;
  }
  if (directJid.kind === "pn") {
    return `+${directJid.user}`;
  }
  const mapping = readWhatsAppLidToPnMapping({ lid: directJid.user, options: opts });
  if (mapping.kind === "mapped") {
    return mapping.e164;
  }
  // Baileys may return the same stale reverse entry that the file owner rejected.
  if (mapping.kind === "rejected" || !opts?.lidLookup?.getPNForLID) {
    return null;
  }
  try {
    const pnJid = await opts.lidLookup.getPNForLID(directJid.jid);
    if (!pnJid) {
      return null;
    }
    return jidToE164(pnJid, opts);
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`LID mapping lookup failed for ${directJid.jid}: ${String(err)}`);
    }
    return null;
  }
}

export { markdownToWhatsApp, markdownToWhatsAppChunks } from "./whatsapp-format.js";
