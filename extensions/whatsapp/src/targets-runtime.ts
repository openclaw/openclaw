// Whatsapp plugin module implements targets runtime behavior.
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
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

const WHATSAPP_FENCE_PLACEHOLDER = "\x00FENCE";
const WHATSAPP_INLINE_CODE_PLACEHOLDER = "\x00CODE";
// Terminates the numeric index in a placeholder so the restore regex cannot
// absorb a digit from adjacent user text (e.g. `code`5) into the index.
const WHATSAPP_PLACEHOLDER_TERMINATOR = "\x00";

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
  if (!selfE164) {
    return false;
  }
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
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
  lookup: (() => Promise<string | null> | undefined) | undefined,
): Promise<string | null> {
  if (!lookup) {
    return null;
  }
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
}

export async function resolveEquivalentWhatsAppDirectChatJids(
  jid: string | null | undefined,
  opts?: JidToE164Options & { lidLookup?: LidLookup; knownE164?: string | null },
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
    addUniqueString(
      candidates,
      mappedLocalLid ? encodeWhatsAppJid(mappedLocalLid, localLidDomain) : null,
    );
    return candidates;
  }

  const knownPhoneDigits = opts?.knownE164?.match(/^\+(\d+)$/)?.[1];
  if (knownPhoneDigits) {
    const knownPnDomain = directJid.server === "hosted.lid" ? "hosted" : "s.whatsapp.net";
    addUniqueString(candidates, encodeWhatsAppJid(knownPhoneDigits, knownPnDomain));
    return candidates;
  }

  const mappedPn = await tryLookupMappedJid(() => opts?.lidLookup?.getPNForLID?.(directJid.jid));
  addEquivalentDirectChatCandidate(candidates, mappedPn, "pn");

  const e164 = jidToE164(directJid.jid, { ...opts, logMissing: false });
  const localPnDomain = directJid.server === "hosted.lid" ? "hosted" : "s.whatsapp.net";
  addUniqueString(
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
  const phone = readWhatsAppLidToPnMapping({
    lid: directJid.user,
    options: opts,
  });
  if (phone) {
    return phone;
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
  const direct = jidToE164(directJid.jid, opts);
  if (direct) {
    return direct;
  }
  if (directJid.kind !== "lid" || !opts?.lidLookup?.getPNForLID) {
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

export function markdownToWhatsApp(text: string): string {
  if (!text) {
    return text;
  }

  const fences: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `${WHATSAPP_FENCE_PLACEHOLDER}${fences.length - 1}${WHATSAPP_PLACEHOLDER_TERMINATOR}`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `${WHATSAPP_INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}${WHATSAPP_PLACEHOLDER_TERMINATOR}`;
  });

  // Convert combined GFM strong+emphasis before plain strong so the plain
  // rules cannot leave literal `**` around the inner emphasis.
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "*_$1_*");
  result = result.replace(/___(.+?)___/g, "*_$1_*");
  result = result.replace(/\*\*_(.+?)_\*\*/g, "*_$1_*");
  result = result.replace(/__\*(.+?)\*__/g, "*_$1_*");
  result = result.replace(/_\*\*(.+?)\*\*_/g, "*_$1_*");
  result = result.replace(/\*__(.+?)__\*/g, "*_$1_*");

  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  const terminator = escapeRegExp(WHATSAPP_PLACEHOLDER_TERMINATOR);
  result = result.replace(
    new RegExp(`${escapeRegExp(WHATSAPP_INLINE_CODE_PLACEHOLDER)}(\\d+)${terminator}`, "g"),
    (_, idx) => inlineCodes[Number(idx)] ?? "",
  );
  result = result.replace(
    new RegExp(`${escapeRegExp(WHATSAPP_FENCE_PLACEHOLDER)}(\\d+)${terminator}`, "g"),
    (_, idx) => fences[Number(idx)] ?? "",
  );
  return result;
}
