import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { readConfigFileSnapshot } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  feedEntryMatchesQuery,
  loadFeedDocument,
  parseFeedDocument,
  type FeedDocument,
  type FeedDocumentRuntime,
  type FeedEntry,
  type FeedEntryType,
  type FeedSourceConfig,
  type LoadedFeedDocument,
} from "./feed-document.js";

type FeedConfigSnapshot = {
  readonly valid: boolean;
  readonly issues?: readonly { readonly message?: string }[];
  readonly config: {
    readonly plugins?: {
      readonly entries?: Record<string, { readonly config?: unknown } | undefined>;
    };
  };
};

export type FeedsCommandRuntime = FeedDocumentRuntime & {
  writeStdout(value: string): void;
  error(value: string): void;
  isTTY?: boolean;
  writeFile?: (path: string, value: string) => Promise<void>;
  readConfigSnapshot?: (options: { readonly observe?: boolean }) => Promise<FeedConfigSnapshot>;
  runOpenClawCommand?: (argv: readonly string[]) => Promise<number>;
};

export type FeedsCommandOptions = {
  readonly json?: boolean;
  readonly source?: string;
  readonly type?: string;
};

export type FeedsUpdatesOptions = FeedsCommandOptions & {
  readonly installed?: string;
  readonly approvedOnly?: boolean;
};

export type FeedsBuildOptions = FeedsCommandOptions & {
  readonly inventory?: string;
  readonly rules?: string;
  readonly out?: string;
  readonly id?: string;
  readonly generatedAt?: string;
};

export type FeedsDiffOptions = FeedsCommandOptions & {
  readonly previous?: string;
  readonly current?: string;
};

export type FeedInstallPolicyMode = "off" | "warn" | "enforce";

export type FeedInstallPolicy = {
  readonly mode: FeedInstallPolicyMode;
  readonly requireApproval: boolean;
};

export type FeedsInstallOptions = FeedsCommandOptions & {
  readonly dryRun?: boolean;
  readonly force?: boolean;
};

type ConfiguredFeeds = {
  readonly sources: readonly FeedSourceConfig[];
  readonly installPolicy: FeedInstallPolicy;
};

export type FeedInstalledEntry = {
  readonly type: "skill" | "plugin";
  readonly id: string;
  readonly version: string;
};

export type FeedUpdateResult = FeedEntryResult & {
  readonly installedVersion: string;
  readonly availableVersion: string;
  readonly approved: boolean;
};

export type FeedUpdateNotice = {
  readonly type: FeedEntryType;
  readonly id: string;
  readonly sourceId: string;
  readonly feedId: string;
  readonly installedVersion: string;
  readonly availableVersion: string;
  readonly approved: boolean;
  readonly message: string;
  readonly installCommand?: string;
};

export type FeedEntryResult = FeedEntry & {
  readonly sourceId: string;
  readonly feedId: string;
};

export type FeedBuildRules = {
  readonly includeTypes?: readonly FeedEntryType[];
  readonly includeTags?: readonly string[];
  readonly excludeTags?: readonly string[];
  readonly requireApproval?: boolean;
};

const defaultRuntime: FeedsCommandRuntime = {
  isTTY: process.stdout.isTTY,
  writeStdout(value) {
    process.stdout.write(value);
  },
  error(value) {
    process.stderr.write(`${value}\n`);
  },
  runOpenClawCommand(argv) {
    return runOpenClawSubcommand(argv);
  },
};

export function registerFeedsCli(program: Command): void {
  const feeds = program.command("feeds").description("Inspect configured skill and plugin feeds");

  feeds
    .command("sources")
    .description("List configured feed sources")
    .option("--json", "Emit JSON output")
    .action(async (options: FeedsCommandOptions) => {
      process.exitCode = await feedsSourcesCommand(options);
    });

  feeds
    .command("list")
    .description("List entries from configured feed sources")
    .option("--source <id>", "Limit to one feed source id")
    .option("--type <type>", "Limit to skill or plugin entries")
    .option("--json", "Emit JSON output")
    .action(async (options: FeedsCommandOptions) => {
      process.exitCode = await feedsListCommand(options);
    });

  feeds
    .command("search")
    .argument("<query>", "Text to match against feed entry metadata")
    .description("Search entries from configured feed sources")
    .option("--source <id>", "Limit to one feed source id")
    .option("--type <type>", "Limit to skill or plugin entries")
    .option("--json", "Emit JSON output")
    .action(async (query: string, options: FeedsCommandOptions) => {
      process.exitCode = await feedsSearchCommand(query, options);
    });

  feeds
    .command("updates")
    .description("Compare installed inventory against approved feed versions")
    .requiredOption("--installed <path>", "Path to installed skill/plugin inventory JSON")
    .option("--source <id>", "Limit to one feed source id")
    .option("--type <type>", "Limit to skill or plugin entries")
    .option("--approved-only", "Only report feed entries with approval.status=approved")
    .option("--json", "Emit JSON output")
    .action(async (options: FeedsUpdatesOptions) => {
      process.exitCode = await feedsUpdatesCommand(options);
    });

  feeds
    .command("notices")
    .description("Show subscriber update notices from configured feeds")
    .requiredOption("--installed <path>", "Path to installed skill/plugin inventory JSON")
    .option("--source <id>", "Limit to one feed source id")
    .option("--type <type>", "Limit to skill or plugin entries")
    .option("--approved-only", "Only report feed entries with approval.status=approved")
    .option("--json", "Emit JSON output")
    .action(async (options: FeedsUpdatesOptions) => {
      process.exitCode = await feedsNoticesCommand(options);
    });

  feeds
    .command("validate")
    .argument("<path>", "Path to a feed JSON document")
    .description("Validate a feed document and print its pinning integrity")
    .option("--json", "Emit JSON output")
    .action(async (path: string, options: FeedsCommandOptions) => {
      process.exitCode = await feedsValidateCommand(path, options);
    });

  feeds
    .command("hash")
    .argument("<path>", "Path to a feed JSON document")
    .description("Print the sha256 integrity string for a feed document")
    .action(async (path: string) => {
      process.exitCode = await feedsHashCommand(path, {});
    });

  feeds
    .command("build")
    .description("Build a curated feed artifact from a local inventory snapshot")
    .requiredOption("--inventory <path>", "Path to a feed or inventory JSON document")
    .requiredOption("--out <path>", "Path to write the curated feed document")
    .option("--rules <path>", "Path to feed build rules JSON")
    .option("--id <id>", "Feed id for the generated artifact")
    .option("--generated-at <iso>", "Timestamp to write into generatedAt")
    .option("--json", "Emit JSON output")
    .action(async (options: FeedsBuildOptions) => {
      process.exitCode = await feedsBuildCommand(options);
    });

  feeds
    .command("diff")
    .description("Compare two feed artifacts and report entry deltas")
    .requiredOption("--previous <path>", "Previous feed document")
    .requiredOption("--current <path>", "Current feed document")
    .option("--json", "Emit JSON output")
    .action(async (options: FeedsDiffOptions) => {
      process.exitCode = await feedsDiffCommand(options);
    });

  feeds
    .command("install")
    .argument("<id>", "Feed entry id to install")
    .description("Install one feed entry through the existing OpenClaw install command")
    .option("--source <id>", "Limit to one feed source id")
    .option("--type <type>", "Limit to skill or plugin entries")
    .option("--dry-run", "Print the install command without running it")
    .option("--force", "Forward --force to the existing install command")
    .action(async (id: string, options: FeedsInstallOptions) => {
      process.exitCode = await feedsInstallCommand(id, options);
    });
}

export async function feedsSourcesCommand(
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const sources = await readConfiguredFeedSources(runtime);
    if (options.json === true || runtime.isTTY !== true) {
      runtime.writeStdout(JSON.stringify({ sources }, null, 2) + "\n");
    } else {
      runtime.writeStdout(formatSourceRows(sources));
    }
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsListCommand(
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    assertFeedEntryType(options.type);
    const loaded = await loadConfiguredFeedDocuments(options, runtime);
    const entries = filterEntriesByType(flattenFeedEntries(loaded), options.type);
    writeEntries(entries, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsSearchCommand(
  query: string,
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    assertFeedEntryType(options.type);
    const loaded = await loadConfiguredFeedDocuments(options, runtime);
    const entries = filterEntriesByType(
      flattenFeedEntries(loaded).filter((entry) => feedEntryMatchesQuery(entry, query)),
      options.type,
    );
    writeEntries(entries, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsUpdatesCommand(
  options: FeedsUpdatesOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    assertFeedEntryType(options.type);
    if (options.installed === undefined || options.installed.trim() === "") {
      throw new Error("Provide --installed <path>.");
    }
    const installed = await readInstalledInventory(options.installed, runtime);
    const loaded = await loadConfiguredFeedDocuments(options, runtime);
    const updates = findFeedUpdates(flattenFeedEntries(loaded), installed, options);
    writeUpdates(updates, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsNoticesCommand(
  options: FeedsUpdatesOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    assertFeedEntryType(options.type);
    if (options.installed === undefined || options.installed.trim() === "") {
      throw new Error("Provide --installed <path>.");
    }
    const installed = await readInstalledInventory(options.installed, runtime);
    const loaded = await loadConfiguredFeedDocuments(options, runtime);
    const updates = findFeedUpdates(flattenFeedEntries(loaded), installed, options);
    writeNotices(buildFeedUpdateNotices(updates), options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsValidateCommand(
  path: string,
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const raw = await readFeedFile(path, runtime);
    const document = parseFeedDocument(JSON.parse(raw.toString("utf8")), path);
    const integrity = feedIntegrity(raw);
    const result = {
      ok: true,
      id: document.id,
      entries: document.entries.length,
      integrity,
    };
    if (options.json === true || runtime.isTTY !== true) {
      runtime.writeStdout(JSON.stringify(result, null, 2) + "\n");
    } else {
      runtime.writeStdout(`Feed ${document.id} is valid.\nIntegrity: ${integrity}\n`);
    }
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsHashCommand(
  path: string,
  _options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    runtime.writeStdout(`${feedIntegrity(await readFeedFile(path, runtime))}\n`);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsBuildCommand(
  options: FeedsBuildOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    if (options.inventory === undefined || options.inventory.trim() === "") {
      throw new Error("Provide --inventory <path>.");
    }
    if (options.out === undefined || options.out.trim() === "") {
      throw new Error("Provide --out <path>.");
    }
    const inventory = await readInventoryDocument(options.inventory, options, runtime);
    const rules = await readBuildRules(options.rules, runtime);
    const document = {
      schemaVersion: 1 as const,
      id: options.id?.trim() || inventory.id,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      entries: applyBuildRules(inventory.entries, rules).toSorted(compareFeedEntries),
    };
    const serialized = JSON.stringify(document, null, 2) + "\n";
    const write = runtime.writeFile ?? writeFile;
    await write(options.out, serialized);
    const result = {
      ok: true,
      id: document.id,
      entries: document.entries.length,
      out: options.out,
      integrity: feedIntegrity(Buffer.from(serialized)),
    };
    if (options.json === true || runtime.isTTY !== true) {
      runtime.writeStdout(JSON.stringify(result, null, 2) + "\n");
    } else {
      runtime.writeStdout(`Wrote ${document.entries.length} feed entries to ${options.out}.\n`);
    }
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsDiffCommand(
  options: FeedsDiffOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    if (options.previous === undefined || options.previous.trim() === "") {
      throw new Error("Provide --previous <path>.");
    }
    if (options.current === undefined || options.current.trim() === "") {
      throw new Error("Provide --current <path>.");
    }
    const previous = await readFeedDocumentFromPath(options.previous, runtime);
    const current = await readFeedDocumentFromPath(options.current, runtime);
    const diff = diffFeedDocuments(previous, current);
    if (options.json === true || runtime.isTTY !== true) {
      runtime.writeStdout(JSON.stringify(diff, null, 2) + "\n");
    } else {
      runtime.writeStdout(formatFeedDiff(diff));
    }
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function feedsInstallCommand(
  id: string,
  options: FeedsInstallOptions,
  runtime: FeedsCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    assertFeedEntryType(options.type);
    const config = await readConfiguredFeedsConfig(runtime);
    const loaded = await loadFeedDocuments(config.sources, options, runtime);
    const entry = selectInstallEntry(flattenFeedEntries(loaded), id, options);
    applyFeedInstallPolicy(entry, config.installPolicy, runtime);
    const command = buildFeedInstallCommand(entry, { force: options.force === true });
    if (command === undefined) {
      throw new Error(`Feed entry '${id}' does not include supported install metadata.`);
    }
    if (options.dryRun === true) {
      runtime.writeStdout(`${command.label}\n`);
      return 0;
    }
    const run = runtime.runOpenClawCommand ?? runOpenClawSubcommand;
    return await run(command.argv);
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

async function readInstalledInventory(
  path: string,
  runtime: FeedsCommandRuntime,
): Promise<readonly FeedInstalledEntry[]> {
  const raw = JSON.parse((await readFeedFile(path, runtime)).toString("utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    throw new Error("Installed inventory must be an object with an entries array.");
  }
  return raw.entries.map((entry, index): FeedInstalledEntry => {
    if (!isRecord(entry)) {
      throw new Error(`Installed inventory entry ${index} must be an object.`);
    }
    if (entry.type !== "skill" && entry.type !== "plugin") {
      throw new Error(`Installed inventory entry ${index} must be a skill or plugin.`);
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new Error(`Installed inventory entry ${index} must declare an id.`);
    }
    if (typeof entry.version !== "string" || entry.version.trim() === "") {
      throw new Error(`Installed inventory entry ${index} must declare a version.`);
    }
    return { type: entry.type, id: entry.id, version: entry.version };
  });
}

function findFeedUpdates(
  entries: readonly FeedEntryResult[],
  installed: readonly FeedInstalledEntry[],
  options: FeedsUpdatesOptions,
): readonly FeedUpdateResult[] {
  const installedByKey = new Map(installed.map((entry) => [feedEntryKey(entry), entry]));
  return filterEntriesByType(entries, options.type)
    .filter((entry) => options.approvedOnly !== true || feedEntryApproved(entry))
    .flatMap((entry): FeedUpdateResult[] => {
      const installedEntry = installedByKey.get(feedEntryKey(entry));
      if (installedEntry === undefined || entry.version === undefined) {
        return [];
      }
      if (compareVersionStrings(entry.version, installedEntry.version) <= 0) {
        return [];
      }
      return [
        {
          ...entry,
          installedVersion: installedEntry.version,
          availableVersion: entry.version,
          approved: feedEntryApproved(entry),
        },
      ];
    })
    .toSorted((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

function writeUpdates(
  updates: readonly FeedUpdateResult[],
  options: FeedsUpdatesOptions,
  runtime: FeedsCommandRuntime,
): void {
  if (options.json === true || runtime.isTTY !== true) {
    runtime.writeStdout(JSON.stringify({ updates }, null, 2) + "\n");
    return;
  }
  if (updates.length === 0) {
    runtime.writeStdout("No feed updates found.\n");
    return;
  }
  runtime.writeStdout(
    updates
      .map((entry) => {
        const approval = entry.approved ? "approved" : "unapproved";
        return `${entry.sourceId}\t${entry.type}\t${entry.id}\t${entry.installedVersion} -> ${entry.availableVersion}\t${approval}`;
      })
      .join("\n") + "\n",
  );
}

function buildFeedUpdateNotices(updates: readonly FeedUpdateResult[]): readonly FeedUpdateNotice[] {
  return updates.map((entry) => {
    const approval = entry.approved ? "approved" : "unapproved";
    const installCommand = formatFeedInstallCommand(entry);
    return {
      type: entry.type,
      id: entry.id,
      sourceId: entry.sourceId,
      feedId: entry.feedId,
      installedVersion: entry.installedVersion,
      availableVersion: entry.availableVersion,
      approved: entry.approved,
      message: `${entry.type} ${entry.id} has ${approval} feed update ${entry.installedVersion} -> ${entry.availableVersion} from ${entry.sourceId}.`,
      ...(installCommand === undefined ? {} : { installCommand }),
    };
  });
}

function writeNotices(
  notices: readonly FeedUpdateNotice[],
  options: FeedsUpdatesOptions,
  runtime: FeedsCommandRuntime,
): void {
  if (options.json === true || runtime.isTTY !== true) {
    runtime.writeStdout(JSON.stringify({ notices }, null, 2) + "\n");
    return;
  }
  if (notices.length === 0) {
    runtime.writeStdout("No feed update notices found.\n");
    return;
  }
  runtime.writeStdout(
    notices
      .map((notice) => {
        const command =
          notice.installCommand === undefined ? "" : `\n  Install: ${notice.installCommand}`;
        return `${notice.sourceId}\t${notice.type}\t${notice.id}\t${notice.installedVersion} -> ${notice.availableVersion}\t${notice.approved ? "approved" : "unapproved"}${command}`;
      })
      .join("\n") + "\n",
  );
}

function feedEntryKey(entry: { readonly type: string; readonly id: string }): string {
  return `${entry.type}\0${entry.id}`;
}

function compareVersionStrings(a: string, b: string): number {
  const semverComparison = compareSemverStrings(a, b);
  if (semverComparison !== undefined) {
    return semverComparison;
  }
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return a.localeCompare(b);
}

function compareSemverStrings(a: string, b: string): number | undefined {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (parsedA === undefined || parsedB === undefined) {
    return undefined;
  }
  for (const key of ["major", "minor", "patch"] as const) {
    const delta = parsedA[key] - parsedB[key];
    if (delta !== 0) {
      return delta;
    }
  }
  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}

function parseSemver(value: string):
  | {
      readonly major: number;
      readonly minor: number;
      readonly patch: number;
      readonly prerelease: readonly string[];
    }
  | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[-0-9A-Za-z.]+)?$/u.exec(
    value.trim(),
  );
  if (match === null) {
    return undefined;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return b.length - a.length;
  }
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a[index];
    const bPart = b[index];
    if (aPart === undefined || bPart === undefined) {
      return a.length - b.length;
    }
    const delta = comparePrereleasePart(aPart, bPart);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function comparePrereleasePart(a: string, b: string): number {
  const aNumeric = /^\d+$/u.test(a);
  const bNumeric = /^\d+$/u.test(b);
  if (aNumeric && bNumeric) {
    return Number.parseInt(a, 10) - Number.parseInt(b, 10);
  }
  if (aNumeric || bNumeric) {
    return aNumeric ? -1 : 1;
  }
  return a.localeCompare(b);
}

function parseVersionParts(value: string): readonly number[] {
  return value
    .split(/[.-]/u)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

async function readInventoryDocument(
  path: string,
  options: FeedsBuildOptions,
  runtime: FeedsCommandRuntime,
): Promise<FeedDocument> {
  const value = JSON.parse((await readFeedFile(path, runtime)).toString("utf8"));
  if (isRecord(value) && value.schemaVersion === 1) {
    return parseFeedDocument(value, path);
  }
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Feed inventory must be a feed document or an object with an entries array.");
  }
  const id =
    options.id?.trim() ||
    (typeof value.id === "string" && value.id.trim() !== "" ? value.id : "curated-feed");
  return parseFeedDocument({ schemaVersion: 1, id, entries: value.entries }, path);
}

async function readFeedDocumentFromPath(
  path: string,
  runtime: FeedsCommandRuntime,
): Promise<FeedDocument> {
  return parseFeedDocument(JSON.parse((await readFeedFile(path, runtime)).toString("utf8")), path);
}

async function readBuildRules(
  path: string | undefined,
  runtime: FeedsCommandRuntime,
): Promise<FeedBuildRules> {
  if (path === undefined) {
    return {};
  }
  const value = JSON.parse((await readFeedFile(path, runtime)).toString("utf8"));
  if (!isRecord(value)) {
    throw new Error("Feed build rules must be a JSON object.");
  }
  return {
    ...(value.includeTypes === undefined
      ? {}
      : { includeTypes: parseTypeList(value.includeTypes, "includeTypes") }),
    ...(value.includeTags === undefined
      ? {}
      : { includeTags: parseStringList(value.includeTags, "includeTags") }),
    ...(value.excludeTags === undefined
      ? {}
      : { excludeTags: parseStringList(value.excludeTags, "excludeTags") }),
    ...(value.requireApproval === undefined
      ? {}
      : { requireApproval: parseBoolean(value.requireApproval, "requireApproval") }),
  };
}

function parseTypeList(value: unknown, key: string): readonly FeedEntryType[] {
  const values = parseStringList(value, key);
  for (const item of values) {
    if (item !== "skill" && item !== "plugin") {
      throw new Error(`Feed build rules ${key} values must be skill or plugin.`);
    }
  }
  return values as readonly FeedEntryType[];
}

function parseStringList(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Feed build rules ${key} must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Feed build rules ${key} must be a boolean.`);
  }
  return value;
}

function applyBuildRules(
  entries: readonly FeedEntry[],
  rules: FeedBuildRules,
): readonly FeedEntry[] {
  const includeTypes = new Set(rules.includeTypes ?? []);
  const includeTags = new Set(rules.includeTags ?? []);
  const excludeTags = new Set(rules.excludeTags ?? []);
  return entries.filter((entry) => {
    if (includeTypes.size > 0 && !includeTypes.has(entry.type)) {
      return false;
    }
    if (rules.requireApproval === true && !feedEntryApproved(entry)) {
      return false;
    }
    const tags = new Set(entry.tags ?? []);
    for (const tag of includeTags) {
      if (!tags.has(tag)) {
        return false;
      }
    }
    for (const tag of excludeTags) {
      if (tags.has(tag)) {
        return false;
      }
    }
    return true;
  });
}

function compareFeedEntries(a: FeedEntry, b: FeedEntry): number {
  return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
}

type FeedDiffEntry = {
  readonly type: FeedEntryType;
  readonly id: string;
  readonly previous?: string;
  readonly current?: string;
};

type FeedDocumentDiff = {
  readonly previousId: string;
  readonly currentId: string;
  readonly added: readonly FeedEntry[];
  readonly removed: readonly FeedEntry[];
  readonly updated: readonly FeedDiffEntry[];
  readonly approvalChanged: readonly FeedDiffEntry[];
  readonly metadataChanged: readonly FeedDiffEntry[];
  readonly hashChanged: readonly FeedDiffEntry[];
};

function diffFeedDocuments(previous: FeedDocument, current: FeedDocument): FeedDocumentDiff {
  const previousByKey = new Map(previous.entries.map((entry) => [feedEntryKey(entry), entry]));
  const currentByKey = new Map(current.entries.map((entry) => [feedEntryKey(entry), entry]));
  const added = current.entries.filter((entry) => !previousByKey.has(feedEntryKey(entry)));
  const removed = previous.entries.filter((entry) => !currentByKey.has(feedEntryKey(entry)));
  const updated: FeedDiffEntry[] = [];
  const approvalChanged: FeedDiffEntry[] = [];
  const metadataChanged: FeedDiffEntry[] = [];
  const hashChanged: FeedDiffEntry[] = [];
  for (const previousEntry of previous.entries) {
    const currentEntry = currentByKey.get(feedEntryKey(previousEntry));
    if (currentEntry === undefined) {
      continue;
    }
    const base = { type: previousEntry.type, id: previousEntry.id };
    if (previousEntry.version !== currentEntry.version) {
      updated.push({ ...base, previous: previousEntry.version, current: currentEntry.version });
    }
    const previousApproval = approvalStatus(previousEntry);
    const currentApproval = approvalStatus(currentEntry);
    if (previousApproval !== currentApproval) {
      approvalChanged.push({ ...base, previous: previousApproval, current: currentApproval });
    }
    if (previousEntry.sha256 !== currentEntry.sha256) {
      hashChanged.push({ ...base, previous: previousEntry.sha256, current: currentEntry.sha256 });
    }
    if (metadataFingerprint(previousEntry) !== metadataFingerprint(currentEntry)) {
      metadataChanged.push({ ...base });
    }
  }
  return {
    previousId: previous.id,
    currentId: current.id,
    added: added.toSorted(compareFeedEntries),
    removed: removed.toSorted(compareFeedEntries),
    updated: updated.toSorted(compareDiffEntries),
    approvalChanged: approvalChanged.toSorted(compareDiffEntries),
    metadataChanged: metadataChanged.toSorted(compareDiffEntries),
    hashChanged: hashChanged.toSorted(compareDiffEntries),
  };
}

async function readFeedFile(path: string, runtime: FeedsCommandRuntime): Promise<Buffer> {
  const read = runtime.readFile ?? readFile;
  const value = await read(path);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function feedIntegrity(raw: Buffer): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

async function loadConfiguredFeedDocuments(
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime,
): Promise<readonly LoadedFeedDocument[]> {
  return loadFeedDocuments(await readConfiguredFeedSources(runtime), options, runtime);
}

async function loadFeedDocuments(
  configuredSources: readonly FeedSourceConfig[],
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime,
): Promise<readonly LoadedFeedDocument[]> {
  const sources = configuredSources.filter((source) => source.enabled);
  const selected = selectSources(sources, options.source);
  return Promise.all(selected.map((source) => loadFeedDocument(source, runtime)));
}

async function readConfiguredFeedSources(
  runtime: FeedsCommandRuntime,
): Promise<readonly FeedSourceConfig[]> {
  return (await readConfiguredFeedsConfig(runtime)).sources;
}

async function readConfiguredFeedsConfig(runtime: FeedsCommandRuntime): Promise<ConfiguredFeeds> {
  const readSnapshot = runtime.readConfigSnapshot ?? readConfigFileSnapshot;
  const snapshot = await readSnapshot({ observe: false });
  if (!snapshot.valid) {
    const firstIssue = snapshot.issues?.[0]?.message ?? "unknown config parse error";
    throw new Error(`OpenClaw config is invalid: ${firstIssue}`);
  }
  const config = snapshot.config.plugins?.entries?.feeds?.config;
  if (config === undefined) {
    return { sources: [], installPolicy: { mode: "off", requireApproval: false } };
  }
  if (!isRecord(config)) {
    throw new Error("plugins.entries.feeds.config must be an object.");
  }
  if (config.sources === undefined) {
    return { sources: [], installPolicy: parseInstallPolicy(config.installPolicy) };
  }
  if (!Array.isArray(config.sources)) {
    throw new Error("plugins.entries.feeds.config.sources must be an array.");
  }
  return {
    sources: config.sources.map((source, index) => parseSourceConfig(source, index)),
    installPolicy: parseInstallPolicy(config.installPolicy),
  };
}

function parseInstallPolicy(value: unknown): FeedInstallPolicy {
  if (value === undefined) {
    return { mode: "off", requireApproval: false };
  }
  if (!isRecord(value)) {
    throw new Error("plugins.entries.feeds.config.installPolicy must be an object.");
  }
  if (value.requireApproval !== undefined && typeof value.requireApproval !== "boolean") {
    throw new Error("feeds installPolicy.requireApproval must be a boolean.");
  }
  const mode =
    value.mode === undefined ? (value.requireApproval === true ? "enforce" : "off") : value.mode;
  if (mode !== "off" && mode !== "warn" && mode !== "enforce") {
    throw new Error("feeds installPolicy.mode must be off, warn, or enforce.");
  }
  const requireApproval =
    typeof value.requireApproval === "boolean" ? value.requireApproval : mode !== "off";
  return { mode, requireApproval };
}

function parseSourceConfig(value: unknown, index: number): FeedSourceConfig {
  if (!isRecord(value)) {
    throw new Error(`Feed source ${index} must be an object.`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error(`Feed source ${index} must declare an id.`);
  }
  if (typeof value.url !== "string" || value.url.trim() === "") {
    throw new Error(`Feed source ${value.id} must declare a url.`);
  }
  if (value.trust !== undefined && value.trust !== "unsigned" && value.trust !== "pinned") {
    throw new Error(`Feed source ${value.id} has unsupported trust value.`);
  }
  if (value.integrity !== undefined && typeof value.integrity !== "string") {
    throw new Error(`Feed source ${value.id} integrity must be a string.`);
  }
  return {
    id: value.id,
    url: value.url,
    enabled: value.enabled !== false,
    ...(value.trust === "unsigned" || value.trust === "pinned" ? { trust: value.trust } : {}),
    ...(typeof value.integrity === "string" ? { integrity: value.integrity } : {}),
  };
}

function selectSources(
  sources: readonly FeedSourceConfig[],
  selectedId: string | undefined,
): readonly FeedSourceConfig[] {
  if (selectedId === undefined) {
    return sources;
  }
  const selected = sources.filter((source) => source.id === selectedId);
  if (selected.length === 0) {
    throw new Error(`No enabled feed source found for '${selectedId}'.`);
  }
  return selected;
}

function flattenFeedEntries(loaded: readonly LoadedFeedDocument[]): readonly FeedEntryResult[] {
  return loaded.flatMap((feed) =>
    feed.document.entries.map((entry) => ({
      ...entry,
      sourceId: feed.source.id,
      feedId: feed.document.id,
    })),
  );
}

function writeEntries(
  entries: readonly FeedEntryResult[],
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime,
): void {
  if (options.json === true || runtime.isTTY !== true) {
    runtime.writeStdout(JSON.stringify({ entries }, null, 2) + "\n");
    return;
  }
  if (entries.length === 0) {
    runtime.writeStdout("No feed entries found.\n");
    return;
  }
  runtime.writeStdout(
    entries
      .map((entry) => {
        const version = entry.version === undefined ? "" : `@${entry.version}`;
        const label = entry.name === undefined ? "" : ` - ${entry.name}`;
        const install = formatFeedInstallCommand(entry);
        const installHint = install === undefined ? "" : `\n  Install: ${install}`;
        return `${entry.sourceId}\t${entry.type}\t${entry.id}${version}${label}${installHint}`;
      })
      .join("\n") + "\n",
  );
}

function filterEntriesByType(
  entries: readonly FeedEntryResult[],
  type: string | undefined,
): readonly FeedEntryResult[] {
  if (type === undefined) {
    return entries;
  }
  assertFeedEntryType(type);
  return entries.filter((entry) => entry.type === type);
}

function assertFeedEntryType(
  type: string | undefined,
): asserts type is "skill" | "plugin" | undefined {
  if (type !== undefined && type !== "skill" && type !== "plugin") {
    throw new Error("Invalid --type value. Expected skill or plugin.");
  }
}

type FeedInstallCommand = {
  readonly argv: readonly string[];
  readonly label: string;
};

function formatFeedInstallCommand(entry: FeedEntry): string | undefined {
  return buildFeedInstallCommand(entry)?.label;
}

function buildFeedInstallCommand(
  entry: FeedEntry,
  options: { readonly force?: boolean } = {},
): FeedInstallCommand | undefined {
  const install = entry.install;
  if (!isRecord(install)) {
    return undefined;
  }
  const source = typeof install.source === "string" ? install.source : undefined;
  const spec = typeof install.spec === "string" ? install.spec.trim() : "";
  const clawhubSpec = typeof install.clawhubSpec === "string" ? install.clawhubSpec.trim() : "";
  const npmSpec = typeof install.npmSpec === "string" ? install.npmSpec.trim() : "";
  const slug = typeof install.slug === "string" ? install.slug.trim() : "";
  if (entry.type === "plugin") {
    const resolvedSpec = resolvePluginInstallSpec({ clawhubSpec, npmSpec, source, spec });
    if (resolvedSpec === undefined) {
      return undefined;
    }
    const argv = [
      "plugins",
      "install",
      resolvedSpec,
      ...(options.force === true ? ["--force"] : []),
    ];
    return { argv, label: formatOpenClawCommand(argv) };
  }
  if (entry.type === "skill") {
    const resolvedSpec = resolveSkillInstallSpec({ source, spec, slug });
    if (resolvedSpec === undefined) {
      return undefined;
    }
    const argv = [
      "skills",
      "install",
      resolvedSpec,
      ...(options.force === true ? ["--force"] : []),
    ];
    return { argv, label: formatOpenClawCommand(argv) };
  }
  return undefined;
}

function formatOpenClawCommand(argv: readonly string[]): string {
  return ["openclaw", ...argv].map(quoteCliArg).join(" ");
}

function quoteCliArg(value: string): string {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function resolvePluginInstallSpec(params: {
  readonly clawhubSpec: string;
  readonly npmSpec: string;
  readonly source: string | undefined;
  readonly spec: string;
}): string | undefined {
  if (params.clawhubSpec) {
    return normalizeClawHubSpec(params.clawhubSpec);
  }
  if (params.source === "clawhub" && params.spec) {
    return normalizeClawHubSpec(params.spec);
  }
  if (params.npmSpec) {
    return params.npmSpec;
  }
  if (
    (params.source === "npm" || params.source === "path" || params.source === "git") &&
    params.spec
  ) {
    return params.spec;
  }
  return undefined;
}

function resolveSkillInstallSpec(params: {
  readonly source: string | undefined;
  readonly spec: string;
  readonly slug: string;
}): string | undefined {
  if (params.slug) {
    return params.slug;
  }
  if (params.source === "clawhub" && params.spec) {
    return params.spec.replace(/^clawhub:/u, "");
  }
  if (
    (params.source === "git" || params.source === "path" || params.source === "local") &&
    params.spec
  ) {
    return params.spec;
  }
  return undefined;
}

function selectInstallEntry(
  entries: readonly FeedEntryResult[],
  id: string,
  options: FeedsInstallOptions,
): FeedEntryResult {
  const matches = filterEntriesByType(entries, options.type).filter(
    (entry) =>
      entry.id === id && (options.source === undefined || entry.sourceId === options.source),
  );
  if (matches.length === 0) {
    throw new Error(`No feed entry found for '${id}'.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Feed entry '${id}' matched ${matches.length} entries. Use --source or --type to choose one.`,
    );
  }
  return matches[0];
}

function applyFeedInstallPolicy(
  entry: FeedEntryResult,
  policy: FeedInstallPolicy,
  runtime: FeedsCommandRuntime,
): void {
  if (policy.mode === "off" || !policy.requireApproval || feedEntryApproved(entry)) {
    return;
  }
  const message = `Feed entry '${entry.id}' is not approved by feed metadata.`;
  if (policy.mode === "enforce") {
    throw new Error(`${message} Set approval.status to approved or update feeds installPolicy.`);
  }
  runtime.error(`Warning: ${message}`);
}

function feedEntryApproved(entry: FeedEntry): boolean {
  if (!isRecord(entry.approval)) {
    return false;
  }
  return (
    typeof entry.approval.status === "string" && entry.approval.status.toLowerCase() === "approved"
  );
}

function approvalStatus(entry: FeedEntry): string | undefined {
  if (!isRecord(entry.approval) || typeof entry.approval.status !== "string") {
    return undefined;
  }
  return entry.approval.status;
}

function metadataFingerprint(entry: FeedEntry): string {
  return stableJson({
    name: entry.name,
    description: entry.description,
    tags: entry.tags,
    sourceUrl: entry.sourceUrl,
    install: entry.install,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareDiffEntries(a: FeedDiffEntry, b: FeedDiffEntry): number {
  return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
}

function formatFeedDiff(diff: FeedDocumentDiff): string {
  const counts = [
    `added=${diff.added.length}`,
    `removed=${diff.removed.length}`,
    `updated=${diff.updated.length}`,
    `approvalChanged=${diff.approvalChanged.length}`,
    `metadataChanged=${diff.metadataChanged.length}`,
    `hashChanged=${diff.hashChanged.length}`,
  ];
  return `Feed diff ${diff.previousId} -> ${diff.currentId}: ${counts.join(" ")}\n`;
}

function normalizeClawHubSpec(value: string): string {
  return value.startsWith("clawhub:") ? value : `clawhub:${value}`;
}

function runOpenClawSubcommand(argv: readonly string[]): Promise<number> {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error("Unable to resolve the current OpenClaw CLI entrypoint.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...argv], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function formatSourceRows(sources: readonly FeedSourceConfig[]): string {
  if (sources.length === 0) {
    return "No feed sources configured.\n";
  }
  return (
    sources
      .map((source) => {
        const status = source.enabled ? "enabled" : "disabled";
        const trust = source.trust ?? "unsigned";
        return `${source.id}\t${status}\t${trust}\t${source.url}`;
      })
      .join("\n") + "\n"
  );
}
