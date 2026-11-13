import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  loadControlUiTranslationMemory,
  type ControlUiTranslationValue,
} from "./control-ui-i18n-catalog-values.ts";

export const CONTROL_UI_MEMORY_PIN = "memory-revision.json";
export const CONTROL_UI_MEMORY_ASSETS = "ui/src/i18n/.i18n";
type FilePin = { memory: string; catalog: string };
export type ControlUiMemoryPin = {
  version: 1;
  repository: string;
  revision: string;
  files: Record<string, FilePin>;
};

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function git(store: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", store, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    maxBuffer: 32 * 1024 * 1024,
  });
}
function localeName(locale: string): boolean {
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale);
}
export function readControlUiMemoryPin(assets: string): ControlUiMemoryPin | undefined {
  const file = path.join(assets, CONTROL_UI_MEMORY_PIN);
  if (!existsSync(file)) {
    return undefined;
  }
  const pin = z
    .object({
      version: z.literal(1),
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      revision: z.string().regex(/^[a-f0-9]{40}$/u),
      files: z.record(
        z.string().refine(localeName),
        z.object({
          memory: z.string().regex(/^[a-f0-9]{64}$/u),
          catalog: z.string().regex(/^[a-f0-9]{64}$/u),
        }),
      ),
    })
    .parse(JSON.parse(readFileSync(file, "utf8")));
  return pin;
}

/** Before bootstrap, tracked TM remains the build input; afterwards only pinned projections do. */
export function controlUiBuildMemoryPath(memoryPath: string): string {
  const assets = path.dirname(memoryPath);
  return readControlUiMemoryPin(assets)
    ? memoryPath.replace(/\.tm\.jsonl$/u, ".catalog.jsonl")
    : memoryPath;
}

export function loadControlUiBuildMemory(
  memoryPath: string,
): Map<string, ControlUiTranslationValue> {
  const assets = path.dirname(memoryPath);
  const pin = readControlUiMemoryPin(assets);
  if (!pin) {
    return loadControlUiTranslationMemory(memoryPath);
  }
  const locale = path.basename(memoryPath, ".tm.jsonl");
  const expected = pin.files[locale];
  // A newly registered locale has no generated snapshot until its first refresh.
  if (!expected) {
    return new Map();
  }
  const content = readFileSync(memoryPath.replace(/\.tm\.jsonl$/u, ".catalog.jsonl"), "utf8");
  if (digest(content) !== expected.catalog) {
    throw new Error("Control UI build catalog digest mismatch: " + locale);
  }
  const entries = new Map<string, ControlUiTranslationValue>();
  for (const [index, line] of content.trimEnd().split("\n").entries()) {
    const row: unknown = JSON.parse(line);
    if (
      !Array.isArray(row) ||
      row.length !== 4 ||
      typeof row[0] !== "string" ||
      typeof row[1] !== "string" ||
      !Array.isArray(row[2]) ||
      !row[2].every((key) => typeof key === "string") ||
      typeof row[3] !== "string"
    ) {
      throw new Error("Invalid Control UI build catalog: " + locale);
    }
    entries.set(String(index), {
      text_hash: row[0],
      segment_id: row[1],
      segment_ids: row[2],
      translated: row[3],
    });
  }
  return entries;
}

function project(memoryPath: string): string {
  return (
    [...loadControlUiTranslationMemory(memoryPath).values()]
      .map((entry) =>
        JSON.stringify([
          entry.text_hash,
          entry.segment_id,
          entry.segment_ids ?? [],
          entry.translated,
        ]),
      )
      .join("\n") + "\n"
  );
}

/** Refresh a derived view during generation; never use it as translation-provider input. */
export function refreshControlUiBuildCatalog(assets: string, locale: string): void {
  const pin = readControlUiMemoryPin(assets);
  if (!pin) {
    return;
  }
  if (!localeName(locale)) {
    throw new Error("Invalid locale");
  }
  const memoryPath = path.join(assets, locale + ".tm.jsonl");
  const catalog = project(memoryPath);
  pin.files[locale] = { memory: digest(readFileSync(memoryPath)), catalog: digest(catalog) };
  writeFileSync(path.join(assets, locale + ".catalog.jsonl"), catalog);
  writeFileSync(path.join(assets, CONTROL_UI_MEMORY_PIN), JSON.stringify(pin, null, 2) + "\n");
}

/** Bootstrap verifies the prepared snapshot before removing local raw inputs; remote retention is operator-owned. */
export function bootstrapControlUiMemory(
  root: string,
  store: string,
  repository: string,
  revision: string,
  locales: string[],
): void {
  const assets = path.join(root, CONTROL_UI_MEMORY_ASSETS);
  if (readControlUiMemoryPin(assets)) {
    throw new Error("Control UI memory is already bootstrapped");
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    !locales.length ||
    locales.some((locale) => !localeName(locale)) ||
    new Set(locales).size !== locales.length
  ) {
    throw new Error("Bootstrap requires a repository, exact commit, and unique locales");
  }
  const pin: ControlUiMemoryPin = { version: 1, repository, revision, files: {} };
  const catalogs = new Map<string, string>();
  for (const locale of locales) {
    const file = locale + ".tm.jsonl";
    const raw = readFileSync(path.join(assets, file));
    if (!raw.equals(git(store, ["show", revision + ":" + file]))) {
      throw new Error("Canonical bootstrap snapshot differs from source memory: " + locale);
    }
    const catalog = project(path.join(assets, file));
    pin.files[locale] = { memory: digest(raw), catalog: digest(catalog) };
    catalogs.set(locale, catalog);
  }
  // All canonical bytes were verified before writing the cutover or removing raw files.
  for (const [locale, catalog] of catalogs) {
    writeFileSync(path.join(assets, locale + ".catalog.jsonl"), catalog);
  }
  writeFileSync(path.join(assets, CONTROL_UI_MEMORY_PIN), JSON.stringify(pin, null, 2) + "\n");
  const ignore = path.join(assets, ".gitignore");
  const previousIgnore = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!previousIgnore.split("\n").includes("*.tm.jsonl")) {
    writeFileSync(
      ignore,
      previousIgnore +
        (previousIgnore && !previousIgnore.endsWith("\n") ? "\n" : "") +
        "*.tm.jsonl\n",
    );
  }
  for (const locale of locales) {
    unlinkSync(path.join(assets, locale + ".tm.jsonl"));
  }
}

/** Restore exactly the source pin, not the store's latest translations. Validate the whole set first. */
export function restoreControlUiMemory(root: string, store: string, repository: string): void {
  const assets = path.join(root, CONTROL_UI_MEMORY_ASSETS);
  const pin = readControlUiMemoryPin(assets);
  if (!pin || pin.repository !== repository) {
    throw new Error("Canonical memory repository does not match the configured destination");
  }
  const contents = new Map<string, Buffer>();
  for (const [locale, expected] of Object.entries(pin.files)) {
    const bytes = git(store, ["show", pin.revision + ":" + locale + ".tm.jsonl"]);
    if (digest(bytes) !== expected.memory) {
      throw new Error("Canonical memory digest mismatch: " + locale);
    }
    contents.set(locale, bytes);
  }
  for (const [locale, bytes] of contents) {
    writeFileSync(path.join(assets, locale + ".tm.jsonl"), bytes);
  }
}

/** Writes a candidate snapshot only; caller owns commit/push and must not publish the main pin first. */
export function exportControlUiMemory(root: string, store: string, locales: string[]): void {
  const assets = path.join(root, CONTROL_UI_MEMORY_ASSETS);
  if (!locales.length || locales.some((locale) => !localeName(locale))) {
    throw new Error("Invalid memory snapshot locale roster");
  }
  const contents = locales.map(
    (locale) => [locale, readFileSync(path.join(assets, locale + ".tm.jsonl"))] as const,
  );
  mkdirSync(store, { recursive: true });
  for (const [locale, bytes] of contents) {
    writeFileSync(path.join(store, locale + ".tm.jsonl"), bytes);
  }
}

/** Only after durable publication: bind the generated catalogs to the verified new canonical commit. */
export function pinControlUiMemory(
  root: string,
  store: string,
  repository: string,
  revision: string,
): void {
  const assets = path.join(root, CONTROL_UI_MEMORY_ASSETS);
  const pin = readControlUiMemoryPin(assets);
  if (!pin || pin.repository !== repository || !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("Invalid canonical memory publication target");
  }
  for (const [locale, expected] of Object.entries(pin.files)) {
    if (digest(git(store, ["show", revision + ":" + locale + ".tm.jsonl"])) !== expected.memory) {
      throw new Error("Published canonical snapshot differs from generated catalog: " + locale);
    }
  }
  pin.revision = revision;
  writeFileSync(path.join(assets, CONTROL_UI_MEMORY_PIN), JSON.stringify(pin, null, 2) + "\n");
}
