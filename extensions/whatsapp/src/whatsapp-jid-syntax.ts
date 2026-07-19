// Whatsapp plugin module owns dependency-free JID syntax checks.

// Baileys encodes direct JIDs as user[_agent][:device]@server. Validate every
// numeric component before its normalizer strips agent and device metadata.
const DIRECT_LOCAL_PART_RE = /^(\d+)(?:_(\d+))?(?::(\d+))?$/;
const GROUP_LOCAL_PART_RE = /^[0-9]+(?:-[0-9]+)*$/;
const NUMERIC_LOCAL_PART_RE = /^\d+$/;

type WhatsAppDirectJidInputServer = "s.whatsapp.net" | "c.us" | "hosted" | "lid" | "hosted.lid";
type WhatsAppDirectJidSyntaxServer = Exclude<WhatsAppDirectJidInputServer, "c.us">;
type WhatsAppJidDomainType = 0 | 1 | 128 | 129;

const DIRECT_JID_SERVERS = new Set<WhatsAppDirectJidInputServer>([
  "s.whatsapp.net",
  "c.us",
  "hosted",
  "lid",
  "hosted.lid",
]);

// These byte values mirror Baileys WAJIDDomains. Setup imports this dependency-free
// parser; the runtime classifier cross-checks them against Baileys jidDecode.
const DOMAIN_TYPE_BY_SERVER: Record<WhatsAppDirectJidSyntaxServer, WhatsAppJidDomainType> = {
  "s.whatsapp.net": 0,
  lid: 1,
  hosted: 128,
  "hosted.lid": 129,
};
const SERVER_BY_DOMAIN_TYPE: Record<WhatsAppJidDomainType, WhatsAppDirectJidSyntaxServer> = {
  0: "s.whatsapp.net",
  1: "lid",
  128: "hosted",
  129: "hosted.lid",
};

type WhatsAppDirectJidSyntax = {
  kind: "pn" | "lid";
  user: string;
  server: WhatsAppDirectJidSyntaxServer;
  input: string;
  domainType: WhatsAppJidDomainType;
  device?: number;
};

type WhatsAppJidSyntax =
  | WhatsAppDirectJidSyntax
  | {
      kind: "group" | "newsletter";
      user: string;
      server: "g.us" | "newsletter";
      input: string;
    };

function parseUint8(value: string | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : null;
}

function isWhatsAppJidDomainType(value: number): value is WhatsAppJidDomainType {
  return value === 0 || value === 1 || value === 128 || value === 129;
}

function parseDirectJidSyntax(
  localPart: string,
  inputServer: WhatsAppDirectJidInputServer,
): WhatsAppDirectJidSyntax | null {
  const match = DIRECT_LOCAL_PART_RE.exec(localPart);
  const user = match?.[1];
  if (!user) {
    return null;
  }
  const agent = parseUint8(match[2]);
  const device = parseUint8(match[3]);
  if (agent === null || device === null) {
    return null;
  }

  const textualServer = inputServer === "c.us" ? "s.whatsapp.net" : inputServer;
  const textualDomainType = DOMAIN_TYPE_BY_SERVER[textualServer];
  if (agent !== undefined && !isWhatsAppJidDomainType(agent)) {
    return null;
  }
  if (agent !== undefined && textualDomainType !== 0 && agent !== textualDomainType) {
    return null;
  }
  const domainType = agent ?? textualDomainType;
  const server = SERVER_BY_DOMAIN_TYPE[domainType];
  if (device === 99 && server !== "hosted" && server !== "hosted.lid") {
    return null;
  }
  return {
    kind: server === "lid" || server === "hosted.lid" ? "lid" : "pn",
    user,
    server,
    input: `${localPart}@${inputServer}`,
    domainType,
    device,
  };
}

export function parseWhatsAppJidSyntax(value: string | null | undefined): WhatsAppJidSyntax | null {
  const trimmed = value?.trim();
  const separatorIndex = trimmed?.indexOf("@") ?? -1;
  if (!trimmed || separatorIndex <= 0 || separatorIndex !== trimmed.lastIndexOf("@")) {
    return null;
  }

  const localPart = trimmed.slice(0, separatorIndex);
  const server = trimmed.slice(separatorIndex + 1).toLowerCase();
  if (DIRECT_JID_SERVERS.has(server as WhatsAppDirectJidInputServer)) {
    return parseDirectJidSyntax(localPart, server as WhatsAppDirectJidInputServer);
  }
  if (server === "g.us" && GROUP_LOCAL_PART_RE.test(localPart)) {
    return { kind: "group", user: localPart, server, input: `${localPart}@${server}` };
  }
  if (server === "newsletter" && NUMERIC_LOCAL_PART_RE.test(localPart)) {
    return { kind: "newsletter", user: localPart, server, input: `${localPart}@${server}` };
  }
  return null;
}

export function parseWhatsAppDirectJidSyntax(
  value: string | null | undefined,
): WhatsAppDirectJidSyntax | null {
  const parsed = parseWhatsAppJidSyntax(value);
  return parsed?.kind === "pn" || parsed?.kind === "lid" ? parsed : null;
}

export function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

export function canonicalizeWhatsAppGroupJid(value: string | null | undefined): string | null {
  const parsed = parseWhatsAppJidSyntax(value);
  return parsed?.kind === "group" ? parsed.input : null;
}
