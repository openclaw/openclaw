// Whatsapp plugin module reads Baileys' persisted LID mapping entries.
import path from "node:path";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { loadJsonFile } from "openclaw/plugin-sdk/json-store";
import { CONFIG_DIR, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";

export type WhatsAppLidMappingFileOptions = {
  authDir?: string;
  lidMappingDirs?: string[];
};

function resolveLidMappingDirs(options?: WhatsAppLidMappingFileOptions): string[] {
  const candidates = [
    options?.authDir,
    ...(options?.lidMappingDirs ?? []),
    CONFIG_DIR,
    path.join(CONFIG_DIR, "credentials"),
  ];
  return [
    ...new Set(
      candidates.filter((dir): dir is string => Boolean(dir)).map((dir) => resolveUserPath(dir)),
    ),
  ];
}

function readMappingFile(
  mappingPath: string,
  normalize: (candidate: string) => string | null,
): string | null {
  const value = loadJsonFile<string | number>(mappingPath);
  return value === undefined ? null : normalize(String(value).trim());
}

const normalizePhone = (candidate: string) =>
  /^\+?\d+$/.test(candidate) ? normalizeE164(candidate) : null;
const normalizeLid = (candidate: string) => (/^\d+$/.test(candidate) ? candidate : null);

type StoredLidMapping = { kind: "mapped"; e164: string } | { kind: "rejected" };

function* readLidToPnMappingCandidates(params: {
  lid: string;
  mappingDirs: readonly string[];
}): Generator<StoredLidMapping, void> {
  for (const dir of new Set(params.mappingDirs.map((candidate) => resolveUserPath(candidate)))) {
    const phone = readMappingFile(
      path.join(dir, `lid-mapping-${params.lid}_reverse.json`),
      normalizePhone,
    );
    if (!phone) {
      continue;
    }
    const currentLid = readMappingFile(
      path.join(dir, `lid-mapping-${phone.slice(1)}.json`),
      normalizeLid,
    );
    // Baileys can leave the old reverse entry when it replaces a PN's LID.
    if (currentLid && currentLid !== params.lid) {
      yield { kind: "rejected" };
      continue;
    }
    yield { kind: "mapped", e164: phone };
  }
}

export function readWhatsAppLidToPnMappings(params: {
  lid: string;
  mappingDirs: readonly string[];
}): string[] {
  const phones = new Set<string>();
  for (const mapping of readLidToPnMappingCandidates(params)) {
    if (mapping.kind === "mapped") {
      phones.add(mapping.e164);
    }
  }
  return [...phones];
}

export function readWhatsAppLidToPnMapping(params: {
  lid: string;
  options?: WhatsAppLidMappingFileOptions;
}): StoredLidMapping | { kind: "missing" } {
  const candidate = readLidToPnMappingCandidates({
    lid: params.lid,
    mappingDirs: resolveLidMappingDirs(params.options),
  }).next();
  return candidate.done ? { kind: "missing" } : candidate.value;
}

export function readWhatsAppPnToLidMapping(params: {
  phoneDigits: string;
  options?: WhatsAppLidMappingFileOptions;
}): string | null {
  for (const dir of resolveLidMappingDirs(params.options)) {
    const lid = readMappingFile(
      path.join(dir, `lid-mapping-${params.phoneDigits}.json`),
      normalizeLid,
    );
    if (!lid) {
      continue;
    }
    const currentPhone = readMappingFile(
      path.join(dir, `lid-mapping-${lid}_reverse.json`),
      normalizePhone,
    );
    if (!currentPhone || currentPhone === `+${params.phoneDigits}`) {
      return lid;
    }
  }
  return null;
}
