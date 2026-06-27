import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type NativeI18nSurface = "android" | "apple";

export const NATIVE_I18N_LOCALES = [
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "hi",
  "ar",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "vi",
  "nl",
  "fa",
  "ru",
] as const;

export type NativeI18nEntry = {
  id: string;
  kind: string;
  line: number;
  path: string;
  source: string;
  surface: NativeI18nSurface;
};

type Candidate = Omit<NativeI18nEntry, "id">;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUTPUT_PATH = path.join(ROOT, "apps", ".i18n", "native-source.json");
const SOURCE_ROOTS: Record<NativeI18nSurface, string> = {
  android: path.join(ROOT, "apps", "android", "app", "src", "main"),
  apple: path.join(ROOT, "apps"),
};

const ANDROID_EXTENSIONS = new Set([".kt", ".kts"]);
const APPLE_EXTENSIONS = new Set([".swift"]);
const APPLE_UI_CALLS =
  /(?:Text|Label|Button|TextField|SecureField|Picker|Section|LabeledContent|Toggle|Menu|ShareLink)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const APPLE_MODIFIER_CALLS =
  /\.(?:navigationTitle|accessibilityLabel|accessibilityHint|help|alert|confirmationDialog)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_CALLS =
  /\b(?:Text|OutlinedTextField|BasicTextField|Button|IconButton|TopAppBar|Snackbar|AlertDialog)\s*\(\s*(?:text\s*=\s*)?"((?:\\.|[^"\\])*)"/gu;
const ANDROID_PROPERTIES =
  /\b(?:contentDescription|label|placeholder|title|message|supportingText)\s*=\s*"((?:\\.|[^"\\])*)"/gu;
const GENERATED_PATH_RE = /(?:\/build\/|\/\.gradle\/|\/\.build\/|\/DerivedData\/)/u;
const EXCLUDED_PATH_RE =
  /(?:^|[\\/])(?:Tests?|UITests?|test|Preview(?:s)?)(?:$|[\\/])/u;
const EXCLUDED_FILE_RE = /(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u;

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function decodeLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function normalizeSource(source: string): string {
  return source.replace(/\s+/gu, " ").trim();
}

function addCandidate(
  entries: Candidate[],
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  kind: string,
  line: number,
) {
  const normalized = normalizeSource(decodeLiteral(source));
  if (!normalized || !/\p{L}/u.test(normalized)) {
    return;
  }
  if (normalized.length > 500 || normalized.includes("${") || normalized.includes("\\(")) {
    return;
  }
  entries.push({ kind, line, path: repoPath, source: normalized, surface });
}

function extractCandidates(
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
): Candidate[] {
  const entries: Candidate[] = [];
  const patterns =
    surface === "apple"
      ? [
          [APPLE_UI_CALLS, "ui-call"],
          [APPLE_MODIFIER_CALLS, "ui-modifier"],
        ]
      : [
          [ANDROID_CALLS, "ui-call"],
          [ANDROID_PROPERTIES, "ui-property"],
        ];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      const offset = match.index ?? 0;
      if (value) {
        addCandidate(entries, surface, repoPath, value, kind, lineNumber(source, offset));
      }
    }
  }
  return entries;
}

async function walkFiles(
  root: string,
  surface: NativeI18nSurface,
  out: string[] = [],
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (GENERATED_PATH_RE.test(fullPath) || EXCLUDED_PATH_RE.test(fullPath)) {
        continue;
      }
      await walkFiles(fullPath, surface, out);
      continue;
    }
    const extension = path.extname(entry.name);
    const allowed = surface === "apple" ? APPLE_EXTENSIONS : ANDROID_EXTENSIONS;
    const isAndroidUiFile =
      surface !== "android" ||
      fullPath.includes(`${path.sep}ui${path.sep}`) ||
      fullPath.endsWith(`${path.sep}MainActivity.kt`);
    if (entry.isFile() && allowed.has(extension) && isAndroidUiFile && !EXCLUDED_FILE_RE.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function withIds(entries: Candidate[]): NativeI18nEntry[] {
  const seen = new Set<string>();
  return entries
    .toSorted(
      (left, right) =>
        left.surface.localeCompare(right.surface) ||
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.kind.localeCompare(right.kind) ||
        left.source.localeCompare(right.source),
    )
    .map((entry) => {
      const digest = createHash("sha256")
        .update([entry.surface, entry.path, entry.kind, entry.source].join("\u0000"))
        .digest("hex")
        .slice(0, 16);
      let id = `native.${entry.surface}.${digest}`;
      if (seen.has(id)) {
        id = `${id}.${entry.line}`;
      }
      seen.add(id);
      return { ...entry, id };
    });
}

export async function collectNativeI18nEntries(): Promise<NativeI18nEntry[]> {
  const entries: Candidate[] = [];
  for (const surface of ["android", "apple"] as const) {
    const files = await walkFiles(SOURCE_ROOTS[surface], surface);
    for (const filePath of files.toSorted()) {
      const source = await readFile(filePath, "utf8");
      const repoPath = path.relative(ROOT, filePath).split(path.sep).join("/");
      entries.push(...extractCandidates(surface, repoPath, source));
    }
  }
  return withIds(entries);
}

function render(entries: NativeI18nEntry[]): string {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

export async function syncNativeI18n(options: { checkOnly: boolean; write: boolean }) {
  const expected = render(await collectNativeI18nEntries());
  let current = "";
  try {
    current = await readFile(OUTPUT_PATH, "utf8");
  } catch {
    // The first sync creates the inventory.
  }
  if (current !== expected && options.checkOnly) {
    throw new Error(
      "native app i18n inventory drift detected. Run `pnpm native:i18n:sync` and commit apps/.i18n/native-source.json.",
    );
  }
  if (current !== expected && options.write) {
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, expected, "utf8");
  }
  const count = JSON.parse(expected).entries.length as number;
  process.stdout.write(`native-app-i18n: entries=${count} changed=${current !== expected}\n`);
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command !== "check" && command !== "sync") {
    throw new Error("usage: node --import tsx scripts/native-app-i18n.ts check|sync [--write]");
  }
  await syncNativeI18n({
    checkOnly: command === "check",
    write: command === "sync" && process.argv.includes("--write"),
  });
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  await main();
}
