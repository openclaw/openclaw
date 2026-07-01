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
  "sv",
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
const SOURCE_ROOTS: Record<NativeI18nSurface, string[]> = {
  android: [path.join(ROOT, "apps", "android", "app", "src", "main")],
  apple: [
    path.join(ROOT, "apps", "ios"),
    path.join(ROOT, "apps", "macos", "Sources"),
    path.join(ROOT, "apps", "shared", "OpenClawKit", "Sources"),
  ],
};

const ANDROID_EXTENSIONS = new Set([".kt", ".kts"]);
const APPLE_EXTENSIONS = new Set([".swift", ".plist"]);
const APPLE_UI_CALLS =
  /(?:Text|Label|Button|TextField|SecureField|Picker|Section|LabeledContent|Toggle|Menu|ShareLink|Link|TextEditor|ProgressView|Gauge|DisclosureGroup|ControlGroup|DatePicker|Stepper)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const APPLE_MODIFIER_CALLS =
  /\.(?:navigationTitle|accessibilityLabel|accessibilityHint|help|alert|confirmationDialog)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_CALLS =
  /\b(?:Text|OutlinedTextField|BasicTextField|Button|IconButton|TopAppBar|Snackbar|AlertDialog)\s*\(\s*(?:text\s*=\s*)?"((?:\\.|[^"\\])*)"/gu;
const ANDROID_PROPERTIES =
  /\b(?:contentDescription|label|placeholder|title|message|supportingText)\s*=\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_WRAPPER_ARGS =
  /\b[A-Z][A-Za-z0-9_]*\s*\([^)\n]{0,160}?\b(?:text|title|label|message|contentDescription|placeholder)\s*=\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_TOAST_ARGS =
  /\b(?:Toast\.makeText|Snackbar\.make)\s*\([^,\n]*,\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_DIALOG_CALLS =
  /\.(?:setTitle|setMessage|setPositiveButton|setNegativeButton|setNeutralButton)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_STATE_CALLS = /\b(?:MutableStateFlow|StateFlow|flowOf)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const CONDITIONAL_BRANCHES = [
  /\bif\s*\([^)]*\)\s*"((?:\\.|[^"\\])*)"\s*else\s*"((?:\\.|[^"\\])*)"/gu,
  /\?\s*"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/gu,
];
const ANDROID_RESOURCE_STRINGS = /<string\b[^>]*>([\s\S]*?)<\/string>/gu;
const APPLE_NAMED_ARGUMENTS =
  /\b(?:title|subtitle|label|message|text|prompt|description|help)\s*:\s*"((?:\\.|[^"\\])*)"/gu;
const APPLE_PLIST_STRINGS = /<string>([\s\S]*?)<\/string>/gu;
const GENERATED_PATH_RE = /(?:^|[\\/])(?:build|\.gradle|\.build|DerivedData)(?:$|[\\/])/u;
const EXCLUDED_PATH_RE = /(?:^|[\\/])(?:Tests?|UITests?|test|Preview(?:s)?)(?:$|[\\/])/u;
const EXCLUDED_FILE_RE = /(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u;
const BUILD_SETTING_RE = /\$\([A-Za-z0-9_.-]+\)/gu;

function isTranslatableCandidate(source: string, kind: string): boolean {
  if (BUILD_SETTING_RE.test(source)) {
    BUILD_SETTING_RE.lastIndex = 0;
    return false;
  }
  BUILD_SETTING_RE.lastIndex = 0;
  if (/^[a-z0-9_.:/$-]+$/u.test(source) || /^[A-Z0-9_.:/$-]+$/u.test(source)) {
    return false;
  }
  if (kind === "conditional-branch" && /^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/u.test(source)) {
    return false;
  }
  if (/[{}[\]]/u.test(source) && !/(?:\\\(|\$\{)/u.test(source)) {
    return false;
  }
  return kind !== "plist-string" || /\s/u.test(source);
}

function extractSwiftInterpolations(source: string): string[] | null {
  const values: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\" || source[index + 1] !== "(") continue;
    const start = index;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    for (index += 2; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = !quoted;
      else if (!quoted && character === "(") depth += 1;
      else if (!quoted && character === ")") {
        depth -= 1;
        if (depth === 0) {
          values.push(source.slice(start, index + 1));
          break;
        }
      }
    }
    if (depth !== 0) return null;
  }
  return values;
}

function extractKotlinInterpolations(source: string): string[] | null {
  const values = [...source.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/gu)].map((match) => match[0]);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$" || source[index + 1] !== "{") continue;
    const start = index;
    let depth = 1;
    for (index += 2; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          values.push(source.slice(start, index + 1));
          break;
        }
      }
    }
    if (depth !== 0) return null;
  }
  return values;
}

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
  return source;
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
  if (!normalized.trim() || !/\p{L}/u.test(normalized)) {
    return;
  }
  if (!isTranslatableCandidate(normalized, kind)) {
    return;
  }
  if (
    normalized.length > 500 ||
    extractSwiftInterpolations(normalized) === null ||
    extractKotlinInterpolations(normalized) === null
  ) {
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
          [APPLE_NAMED_ARGUMENTS, "ui-named-argument"],
          ...CONDITIONAL_BRANCHES.map((pattern) => [pattern, "conditional-branch"] as const),
        ]
      : [
          [ANDROID_CALLS, "ui-call"],
          [ANDROID_PROPERTIES, "ui-property"],
          [ANDROID_WRAPPER_ARGS, "ui-wrapper-argument"],
          [ANDROID_TOAST_ARGS, "ui-toast"],
          [ANDROID_DIALOG_CALLS, "ui-dialog"],
          [ANDROID_STATE_CALLS, "ui-state"],
          ...CONDITIONAL_BRANCHES.map((pattern) => [pattern, "conditional-branch"] as const),
        ];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const offset = match.index ?? 0;
      for (const value of match.slice(1)) {
        if (value) {
          addCandidate(entries, surface, repoPath, value, kind, lineNumber(source, offset));
        }
      }
    }
  }
  if (surface === "android" && repoPath.endsWith("/res/values/strings.xml")) {
    for (const match of source.matchAll(ANDROID_RESOURCE_STRINGS)) {
      if (match[1])
        addCandidate(
          entries,
          surface,
          repoPath,
          match[1],
          "resource-string",
          lineNumber(source, match.index ?? 0),
        );
    }
  }
  if (surface === "apple" && repoPath.endsWith(".plist")) {
    for (const match of source.matchAll(APPLE_PLIST_STRINGS)) {
      if (match[1])
        addCandidate(
          entries,
          surface,
          repoPath,
          match[1],
          "plist-string",
          lineNumber(source, match.index ?? 0),
        );
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
    const allowed =
      surface === "apple"
        ? APPLE_EXTENSIONS
        : fullPath.endsWith(`${path.sep}res${path.sep}values${path.sep}strings.xml`)
          ? new Set([...ANDROID_EXTENSIONS, ".xml"])
          : ANDROID_EXTENSIONS;
    if (entry.isFile() && allowed.has(extension) && !EXCLUDED_FILE_RE.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function withIds(entries: Candidate[]): NativeI18nEntry[] {
  const seen = new Set<string>();
  const unique = [
    ...new Map(
      entries.map((entry) => [`${entry.surface}\u0000${entry.path}\u0000${entry.source}`, entry]),
    ).values(),
  ];
  return unique
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
    for (const sourceRoot of SOURCE_ROOTS[surface]) {
      const files = await walkFiles(sourceRoot, surface);
      for (const filePath of files.toSorted()) {
        const source = await readFile(filePath, "utf8");
        const repoPath = path.relative(ROOT, filePath).split(path.sep).join("/");
        entries.push(...extractCandidates(surface, repoPath, source));
      }
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
