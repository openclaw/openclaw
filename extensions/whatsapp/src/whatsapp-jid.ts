// Whatsapp plugin module owns canonical JID parsing and classification.
import {
  getServerFromDomainType,
  isHostedLidUser,
  isHostedPnUser,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidDecode,
  jidEncode,
  WAJIDDomains,
} from "baileys";
import { parseWhatsAppJidSyntax } from "./whatsapp-jid-syntax.js";

type WhatsAppJidServer = "s.whatsapp.net" | "hosted" | "lid" | "hosted.lid" | "g.us" | "newsletter";

type ClassifiedWhatsAppJid<Kind extends string, Server extends string> = {
  kind: Kind;
  server: Server;
  user: string;
  jid: string;
};

export type WhatsAppDirectJid =
  | ClassifiedWhatsAppJid<"pn", "s.whatsapp.net" | "hosted">
  | ClassifiedWhatsAppJid<"lid", "lid" | "hosted.lid">;

type WhatsAppRoomJid =
  | ClassifiedWhatsAppJid<"group", "g.us">
  | ClassifiedWhatsAppJid<"newsletter", "newsletter">;

export type WhatsAppJid = WhatsAppDirectJid | WhatsAppRoomJid | { kind: "unsupported" };

const UNSUPPORTED_JID = { kind: "unsupported" } as const;

function classifyCanonicalJid(jid: string): WhatsAppJid {
  const decoded = jidDecode(jid);
  const user = decoded?.user;
  if (!user) {
    return UNSUPPORTED_JID;
  }
  if (isPnUser(jid) === true) {
    return { kind: "pn", server: "s.whatsapp.net", user, jid: jidEncode(user, "s.whatsapp.net") };
  }
  if (isHostedPnUser(jid) === true) {
    return { kind: "pn", server: "hosted", user, jid: jidEncode(user, "hosted") };
  }
  if (isLidUser(jid) === true) {
    return { kind: "lid", server: "lid", user, jid: jidEncode(user, "lid") };
  }
  if (isHostedLidUser(jid) === true) {
    return { kind: "lid", server: "hosted.lid", user, jid: jidEncode(user, "hosted.lid") };
  }
  if (isJidGroup(jid) === true) {
    return { kind: "group", server: "g.us", user, jid: jidEncode(user, "g.us") };
  }
  if (isJidNewsletter(jid) === true) {
    return { kind: "newsletter", server: "newsletter", user, jid: jidEncode(user, "newsletter") };
  }
  return UNSUPPORTED_JID;
}

export function classifyWhatsAppJid(value: string | null | undefined): WhatsAppJid {
  const parsed = parseWhatsAppJidSyntax(value);
  if (!parsed) {
    return UNSUPPORTED_JID;
  }
  const decoded = jidDecode(parsed.input);
  if (!decoded || decoded.user !== parsed.user) {
    return UNSUPPORTED_JID;
  }

  let canonicalInput = parsed.input;
  if (parsed.kind === "pn" || parsed.kind === "lid") {
    const decodedServer = decoded.server === "c.us" ? "s.whatsapp.net" : decoded.server;
    const domainServer = getServerFromDomainType(decodedServer, decoded.domainType as WAJIDDomains);
    if (
      decoded.domainType !== parsed.domainType ||
      decoded.device !== parsed.device ||
      domainServer !== parsed.server
    ) {
      return UNSUPPORTED_JID;
    }
    canonicalInput = jidEncode(parsed.user, parsed.server);
  } else if (decoded.server !== parsed.server || decoded.device !== undefined) {
    return UNSUPPORTED_JID;
  }

  // Syntax validation keeps Baileys' domain and device metadata intact until
  // the canonical routing server is known; only then is device state removed.
  const classified = classifyCanonicalJid(canonicalInput);
  return classified.kind === parsed.kind ? classified : UNSUPPORTED_JID;
}

export function encodeWhatsAppJid(user: string, server: WhatsAppJidServer): string {
  const parsed = parseWhatsAppJidSyntax(`${user}@${server}`);
  if (!parsed || parsed.user !== user) {
    throw new Error(`Invalid WhatsApp ${server} JID user`);
  }
  const classified = classifyWhatsAppJid(jidEncode(user, server));
  if (classified.kind === "unsupported") {
    throw new Error(`Invalid WhatsApp ${server} JID user`);
  }
  return classified.jid;
}

export function classifyWhatsAppDirectJid(
  value: string | null | undefined,
): WhatsAppDirectJid | null {
  const classified = classifyWhatsAppJid(value);
  return classified.kind === "pn" || classified.kind === "lid" ? classified : null;
}

export function canonicalizeWhatsAppDirectJids(
  values: ReadonlyArray<string | null | undefined>,
): string[] {
  const canonical = new Set<string>();
  for (const value of values) {
    const classified = classifyWhatsAppDirectJid(value);
    if (classified) {
      canonical.add(classified.jid);
    }
  }
  return [...canonical];
}

export function areSameWhatsAppJid(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftJid = classifyWhatsAppJid(left);
  const rightJid = classifyWhatsAppJid(right);
  if (leftJid.kind === "unsupported" || rightJid.kind === "unsupported") {
    return false;
  }
  // Baileys cleanMessage collapses hosted routing domains into their standard
  // PN/LID form. Cross-class PN/LID equality still requires a verified mapping.
  return leftJid.kind === rightJid.kind && leftJid.user === rightJid.user;
}
