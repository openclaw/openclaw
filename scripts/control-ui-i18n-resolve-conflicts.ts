import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GENERATED_CONFLICT_RE =
  /^(?:ui\/src\/i18n\/\.i18n\/(?:catalog-fallbacks|raw-copy-baseline)\.json|ui\/src\/i18n\/\.i18n\/[^/]+\.(?:meta\.json|tm\.jsonl)|ui\/src\/i18n\/locales\/(?!en\.ts$)[^/]+\.ts)$/u;
const TRANSLATION_MEMORY_RE = /^ui\/src\/i18n\/\.i18n\/[^/]+\.tm\.jsonl$/u;
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

type TranslationMemoryEntry = Record<string, unknown> & { cache_key: string };

export function isControlUiGeneratedI18nPath(filePath: string): boolean {
  return GENERATED_CONFLICT_RE.test(filePath);
}

function parseTranslationMemory(raw: string, label: string): TranslationMemoryEntry[] {
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !("cache_key" in parsed) ||
        typeof parsed.cache_key !== "string" ||
        !parsed.cache_key.trim()
      ) {
        throw new Error(`${label}:${index + 1} has no cache_key`);
      }
      return parsed as TranslationMemoryEntry;
    });
}

export function mergeControlUiTranslationMemory(ours: string, theirs: string): string {
  const merged = new Map<string, TranslationMemoryEntry>();
  for (const entry of parseTranslationMemory(ours, "stage 2 translation memory")) {
    merged.set(entry.cache_key, entry);
  }
  // During rebase, stage 3 is the replayed branch. Preserve its choice when a
  // cache key exists on both sides while retaining unique entries from both.
  for (const entry of parseTranslationMemory(theirs, "stage 3 translation memory")) {
    merged.set(entry.cache_key, entry);
  }
  const ordered = [...merged.values()].toSorted((left, right) =>
    left.cache_key.localeCompare(right.cache_key),
  );
  return ordered.length === 0
    ? ""
    : `${ordered.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function resolveControlUiGeneratedConflict(
  filePath: string,
  ours: string | null,
  theirs: string | null,
): string | null {
  if (theirs === null) {
    return null;
  }
  return TRANSLATION_MEMORY_RE.test(filePath)
    ? mergeControlUiTranslationMemory(ours ?? "", theirs)
    : theirs;
}

function runCapture(cwd: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${executable} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function runInherited(cwd: string, executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function runPnpm(cwd: string, args: string[]): void {
  if (process.platform === "win32") {
    runInherited(cwd, process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm", ...args]);
    return;
  }
  runInherited(cwd, "pnpm", args);
}

function readIndexStage(cwd: string, stage: 2 | 3, filePath: string): string | null {
  const result = spawnSync("git", ["show", `:${stage}:${filePath}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0 ? result.stdout : null;
}

function listUnmerged(cwd: string): string[] {
  return runCapture(cwd, "git", ["diff", "--name-only", "--diff-filter=U", "-z"])
    .split("\0")
    .filter(Boolean);
}

function writeResolvedFile(root: string, filePath: string, contents: string): void {
  const absolutePath = path.join(root, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

function resolveGeneratedConflict(root: string, filePath: string): void {
  const ours = readIndexStage(root, 2, filePath);
  const theirs = readIndexStage(root, 3, filePath);
  if (ours === null && theirs === null) {
    throw new Error(`cannot read either conflict stage for ${filePath}`);
  }
  const resolved = resolveControlUiGeneratedConflict(filePath, ours, theirs);
  if (resolved === null) {
    rmSync(path.join(root, filePath), { force: true });
    return;
  }
  writeResolvedFile(root, filePath, resolved);
}

function assertNoRecordedFallbacks(root: string): void {
  const assetsDir = path.join(root, "ui", "src", "i18n", ".i18n");
  const failures = readdirSync(assetsDir)
    .filter((fileName) => fileName.endsWith(".meta.json"))
    .flatMap((fileName) => {
      const meta = JSON.parse(readFileSync(path.join(assetsDir, fileName), "utf8")) as {
        fallbackKeys?: unknown;
      };
      return Array.isArray(meta.fallbackKeys) && meta.fallbackKeys.length > 0
        ? [`${fileName}: ${meta.fallbackKeys.length}`]
        : [];
    });
  if (failures.length > 0) {
    throw new Error(`generated locales still contain fallbacks:\n${failures.join("\n")}`);
  }
}

function main(): void {
  const root = runCapture(process.cwd(), "git", ["rev-parse", "--show-toplevel"]).trim();
  const conflicts = listUnmerged(root);
  if (conflicts.length === 0) {
    throw new Error("no unmerged files found");
  }
  const unsupported = conflicts.filter((filePath) => !isControlUiGeneratedI18nPath(filePath));
  if (unsupported.length > 0) {
    throw new Error(
      `resolve and stage non-generated conflicts first:\n${unsupported.map((filePath) => `- ${filePath}`).join("\n")}`,
    );
  }

  for (const filePath of conflicts) {
    resolveGeneratedConflict(root, filePath);
  }

  runPnpm(root, ["ui:i18n:baseline"]);
  runInherited(root, process.execPath, [
    "--import",
    "tsx",
    "scripts/control-ui-i18n.ts",
    "sync",
    "--write",
  ]);
  assertNoRecordedFallbacks(root);
  runPnpm(root, ["ui:i18n:check"]);
  runInherited(root, "git", [
    "add",
    "-A",
    "--",
    "ui/src/i18n/.i18n/catalog-fallbacks.json",
    "ui/src/i18n/.i18n/raw-copy-baseline.json",
    ":(glob)ui/src/i18n/.i18n/*.meta.json",
    ":(glob)ui/src/i18n/.i18n/*.tm.jsonl",
    ":(glob)ui/src/i18n/locales/*.ts",
    ":(exclude)ui/src/i18n/locales/en.ts",
  ]);

  const remaining = listUnmerged(root);
  if (remaining.length > 0) {
    throw new Error(
      `unmerged files remain:\n${remaining.map((filePath) => `- ${filePath}`).join("\n")}`,
    );
  }
  process.stdout.write(
    `control-ui-i18n: resolved, regenerated, verified, and staged ${conflicts.length} generated conflict(s)\n`,
  );
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
