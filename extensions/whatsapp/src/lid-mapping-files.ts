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

function* readMappingCandidates(
  mappingFilename: string,
  mappingDirs: readonly string[],
  normalize: (candidate: string) => string | null,
): Generator<string> {
  for (const dir of new Set(mappingDirs.map((candidate) => resolveUserPath(candidate)))) {
    const mapping = readMappingFile(path.join(dir, mappingFilename), normalize);
    if (mapping) {
      yield mapping;
    }
  }
}

const normalizePhone = (candidate: string) =>
  /^\+?\d+$/.test(candidate) ? normalizeE164(candidate) : null;
const normalizeLid = (candidate: string) => (/^\d+$/.test(candidate) ? candidate : null);

export function readWhatsAppLidToPnMappings(params: {
  lid: string;
  mappingDirs: readonly string[];
}): string[] {
  return [
    ...new Set(
      readMappingCandidates(
        `lid-mapping-${params.lid}_reverse.json`,
        params.mappingDirs,
        normalizePhone,
      ),
    ),
  ];
}

export function readWhatsAppLidToPnMapping(params: {
  lid: string;
  options?: WhatsAppLidMappingFileOptions;
}): string | null {
  return (
    readMappingCandidates(
      `lid-mapping-${params.lid}_reverse.json`,
      resolveLidMappingDirs(params.options),
      normalizePhone,
    ).next().value ?? null
  );
}

export function readWhatsAppPnToLidMapping(params: {
  phoneDigits: string;
  options?: WhatsAppLidMappingFileOptions;
}): string | null {
  return (
    readMappingCandidates(
      `lid-mapping-${params.phoneDigits}.json`,
      resolveLidMappingDirs(params.options),
      normalizeLid,
    ).next().value ?? null
  );
}
