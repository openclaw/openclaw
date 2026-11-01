import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { compareAscii } from "./lib/canonical-json.mjs";
import {
  parseNativeI18nInventory,
  type NativeI18nCandidate,
  type NativeI18nInventoryEntry,
} from "./native-i18n-inventory.ts";
import { NATIVE_I18N_LOCALES } from "./native-i18n-locales.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TAURI_ENGLISH_SOURCE = "apps/linux/i18n/en.json";
const NATIVE_SOURCE = path.join(ROOT, "apps/.i18n/native-source.json");
const NATIVE_TRANSLATIONS = path.join(ROOT, "apps/.i18n/native");
const SHELL_CATALOG = path.join(ROOT, "apps/linux/ui/i18n/catalog.json");
const SHELL_CATALOG_SCRIPT = path.join(ROOT, "apps/linux/ui/i18n/catalog.js");
const TAURI_SURFACE = "tauri";

export type TauriMessageDeclaration = { args: string[]; source: string };
export type TauriEnglishDeclaration = {
  messages: Record<string, TauriMessageDeclaration>;
  version: 1;
};
export type TauriShellMessage = { args: string[]; en: string; ptPT: string };
export type TauriShellCatalog = {
  messages: Record<string, TauriShellMessage>;
  sourceInventorySha256: string;
  version: 1;
};

type NativeLocaleArtifact = {
  glossaryHash: string;
  locale: string;
  translations: Record<string, string>;
  version: 2;
};

function placeholderNames(value: string): string[] {
  const matches = [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)];
  const withoutTokens = value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, "");
  if (/[{}]/u.test(withoutTokens)) {
    throw new Error(`invalid Tauri named argument in ${JSON.stringify(value)}`);
  }
  return matches.map((match) => {
    const name = match[1];
    if (!name) {
      throw new Error(`invalid Tauri named argument in ${JSON.stringify(value)}`);
    }
    return name;
  });
}

export function parseTauriEnglishDeclaration(raw: string): TauriEnglishDeclaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid Tauri English declaration: malformed JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.messages)) {
    throw new Error("invalid Tauri English declaration: expected version 1 messages");
  }
  const messages: Record<string, TauriMessageDeclaration> = {};
  for (const [key, value] of Object.entries(parsed.messages)) {
    if (!/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/u.test(key)) {
      throw new Error(`invalid Tauri message key ${JSON.stringify(key)}`);
    }
    if (!isRecord(value) || typeof value.source !== "string" || !value.source.trim()) {
      throw new Error(`invalid Tauri English message ${JSON.stringify(key)}`);
    }
    const rawArgs = value.args;
    if (!Array.isArray(rawArgs) || !rawArgs.every((arg) => typeof arg === "string")) {
      throw new Error(`invalid Tauri argument declaration for ${JSON.stringify(key)}`);
    }
    const args = rawArgs as string[];
    const names = placeholderNames(value.source);
    const distinctNames = [...new Set(names)];
    if (
      args.some((arg) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(arg)) ||
      new Set(args).size !== args.length ||
      distinctNames.length !== args.length ||
      distinctNames.some((arg, index) => arg !== args[index])
    ) {
      throw new Error(`Tauri argument declaration does not match ${JSON.stringify(key)}`);
    }
    messages[key] = { source: value.source, args: [...args] };
  }
  if (Object.keys(messages).length === 0) {
    throw new Error("invalid Tauri English declaration: no messages");
  }
  return { version: 1, messages };
}

export async function collectTauriNativeI18nCandidates(): Promise<NativeI18nCandidate[]> {
  const raw = await readFile(path.join(ROOT, TAURI_ENGLISH_SOURCE), "utf8");
  const declaration = parseTauriEnglishDeclaration(raw);
  return Object.entries(declaration.messages).map(([key, message]) => ({
    source: message.source,
    surface: TAURI_SURFACE,
    path: TAURI_ENGLISH_SOURCE,
    kind: key,
    line: raw.slice(0, raw.indexOf(JSON.stringify(key))).split("\n").length,
  }));
}

export function mergeTauriLocaleTranslations(
  locale: string,
  artifact: NativeLocaleArtifact,
  entries: readonly NativeI18nInventoryEntry[],
): NativeLocaleArtifact {
  const translations = { ...artifact.translations };
  for (const entry of entries.filter(({ surface }) => surface === TAURI_SURFACE)) {
    const existing = translations[entry.id];
    if (typeof existing === "string" && existing.trim()) {
      continue;
    }
    if (locale === "pt-PT") {
      throw new Error(`missing reviewed Tauri PT-PT translation for ${entry.id}`);
    }
    translations[entry.id] = entry.source;
  }
  return {
    ...artifact,
    translations: Object.fromEntries(
      Object.entries(translations).toSorted(([left], [right]) => compareAscii(left, right)),
    ),
  };
}

function parseNativeLocaleArtifact(raw: string, locale: string): NativeLocaleArtifact {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.version !== 2 ||
    parsed.locale !== locale ||
    typeof parsed.glossaryHash !== "string" ||
    !isRecord(parsed.translations) ||
    !Object.values(parsed.translations).every((value) => typeof value === "string")
  ) {
    throw new Error(`invalid existing native locale artifact for ${locale}`);
  }
  return parsed as NativeLocaleArtifact;
}

export function assertTauriPlaceholderParity(source: string, translated: string, id: string): void {
  const count = (value: string) => {
    const names = placeholderNames(value);
    return [...names].toSorted(compareAscii).join("\u0000");
  };
  const sourceLineBreaks = (source.match(/\n/gu) ?? []).length;
  const translatedLineBreaks = (translated.match(/\n/gu) ?? []).length;
  if (count(source) !== count(translated) || sourceLineBreaks !== translatedLineBreaks) {
    throw new Error(`Tauri translation placeholders or line breaks differ for ${id}`);
  }
}

function tauriEntries(entries: readonly NativeI18nInventoryEntry[]) {
  return entries.filter((entry) => entry.surface === TAURI_SURFACE);
}

export async function syncTauriLocaleSlots(): Promise<void> {
  const inventoryRaw = await readFile(NATIVE_SOURCE, "utf8");
  const entries = tauriEntries(parseNativeI18nInventory(inventoryRaw));
  if (entries.length === 0) {
    throw new Error("native inventory has no Tauri entries; run native:i18n:baseline first");
  }
  for (const locale of NATIVE_I18N_LOCALES) {
    const artifactPath = path.join(NATIVE_TRANSLATIONS, `${locale}.json`);
    const previousRaw = await readFile(artifactPath, "utf8");
    const previous = parseNativeLocaleArtifact(previousRaw, locale);
    const next = mergeTauriLocaleTranslations(locale, previous, entries);
    for (const entry of entries) {
      const key = entry.sites.find((site) => site.path === TAURI_ENGLISH_SOURCE)?.kind;
      const translated = next.translations[entry.id];
      if (!key || typeof translated !== "string" || !translated.trim()) {
        throw new Error(`missing Tauri locale value for ${locale}:${entry.id}`);
      }
      assertTauriPlaceholderParity(entry.source, translated, entry.id);
    }
    const rendered = `${JSON.stringify(next, null, 2)}\n`;
    if (rendered !== previousRaw) {
      await writeFile(artifactPath, rendered, "utf8");
    }
  }
}

export async function buildTauriShellCatalog(): Promise<TauriShellCatalog> {
  const [inventoryRaw, englishRaw, ptRaw] = await Promise.all([
    readFile(NATIVE_SOURCE, "utf8"),
    readFile(path.join(ROOT, TAURI_ENGLISH_SOURCE), "utf8"),
    readFile(path.join(NATIVE_TRANSLATIONS, "pt-PT.json"), "utf8"),
  ]);
  const inventory = tauriEntries(parseNativeI18nInventory(inventoryRaw));
  const declaration = parseTauriEnglishDeclaration(englishRaw);
  const locale = parseNativeLocaleArtifact(ptRaw, "pt-PT");
  const idsByKey = new Map<string, NativeI18nInventoryEntry>();
  for (const entry of inventory) {
    const key = entry.sites.find((site) => site.path === TAURI_ENGLISH_SOURCE)?.kind;
    if (!key || idsByKey.has(key)) {
      throw new Error(`invalid Tauri source inventory key ${JSON.stringify(key)}`);
    }
    idsByKey.set(key, entry);
  }
  const declarationKeys = Object.keys(declaration.messages).toSorted(compareAscii);
  const inventoryKeys = [...idsByKey.keys()].toSorted(compareAscii);
  if (JSON.stringify(declarationKeys) !== JSON.stringify(inventoryKeys)) {
    throw new Error("Tauri source declaration and native inventory differ");
  }
  const messages = Object.fromEntries(
    declarationKeys.map((key) => {
      const declared = declaration.messages[key];
      const entry = idsByKey.get(key)!;
      if (!declared) {
        throw new Error(`missing Tauri English declaration for ${key}`);
      }
      const translated = locale.translations[entry.id];
      if (
        entry.source !== declared.source ||
        typeof translated !== "string" ||
        !translated.trim()
      ) {
        throw new Error(`missing or stale Tauri PT-PT translation for ${key}`);
      }
      assertTauriPlaceholderParity(declared.source, translated, entry.id);
      return [key, { en: declared.source, ptPT: translated, args: declared.args }];
    }),
  );
  return {
    version: 1,
    sourceInventorySha256: createHash("sha256").update(inventoryRaw).digest("hex"),
    messages,
  };
}

export function serializeTauriShellCatalogScript(catalog: TauriShellCatalog): string {
  return `(() => {
  if (window !== window.top) return;
  const pageUrl = new URL(location.href);
  const localOrigin =
    (pageUrl.protocol === "tauri:" && pageUrl.hostname === "localhost" && pageUrl.port === "" &&
      pageUrl.username === "" && pageUrl.password === "") ||
    ((pageUrl.origin === "http://tauri.localhost" || pageUrl.origin === "https://tauri.localhost") &&
      pageUrl.username === "" && pageUrl.password === "");
  if (!localOrigin || !["/", "/index.html", "/gateways.html", "/quickchat.html"].includes(pageUrl.pathname)) return;
  Object.defineProperty(window, "__OPENCLAW_TAURI_CATALOG__", {
    value: ${JSON.stringify(catalog)},
    configurable: false,
  });
})();
`;
}

export async function writeTauriShellCatalog(write: boolean): Promise<void> {
  const catalog = await buildTauriShellCatalog();
  const expected = `${JSON.stringify(catalog, null, 2)}\n`;
  const expectedScript = serializeTauriShellCatalogScript(catalog);
  let current = "";
  let currentScript = "";
  try {
    current = await readFile(SHELL_CATALOG, "utf8");
    currentScript = await readFile(SHELL_CATALOG_SCRIPT, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (current === expected && currentScript === expectedScript) {
    return;
  }
  if (!write) {
    throw new Error("Tauri shell catalog is stale; run tauri-app-i18n.ts sync --write");
  }
  await mkdir(path.dirname(SHELL_CATALOG), { recursive: true });
  await writeFile(SHELL_CATALOG, expected, "utf8");
  await writeFile(SHELL_CATALOG_SCRIPT, expectedScript, "utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const write = args.includes("--write");
  if (args.length > 2 || (args.length === 2 && args[1] !== "--write")) {
    throw new Error("usage: tauri-app-i18n.ts sync [--write] | check");
  }
  if (command === "sync" && write) {
    await syncTauriLocaleSlots();
    await writeTauriShellCatalog(true);
    process.stdout.write("tauri-app-i18n: locale fallbacks and shell catalog synced\n");
    return;
  }
  if (command === "check" && !write) {
    await writeTauriShellCatalog(false);
    process.stdout.write("tauri-app-i18n: shell catalog current\n");
    return;
  }
  throw new Error("usage: tauri-app-i18n.ts sync --write | check");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
