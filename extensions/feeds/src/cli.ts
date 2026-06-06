import type { Command } from "commander";
import { readConfigFileSnapshot } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  feedEntryMatchesQuery,
  loadFeedDocument,
  type FeedDocumentRuntime,
  type FeedEntry,
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
  readConfigSnapshot?: (options: { readonly observe?: boolean }) => Promise<FeedConfigSnapshot>;
};

export type FeedsCommandOptions = {
  readonly json?: boolean;
  readonly source?: string;
  readonly type?: string;
};

export type FeedEntryResult = FeedEntry & {
  readonly sourceId: string;
  readonly feedId: string;
};

const defaultRuntime: FeedsCommandRuntime = {
  isTTY: process.stdout.isTTY,
  writeStdout(value) {
    process.stdout.write(value);
  },
  error(value) {
    process.stderr.write(`${value}\n`);
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

async function loadConfiguredFeedDocuments(
  options: FeedsCommandOptions,
  runtime: FeedsCommandRuntime,
): Promise<readonly LoadedFeedDocument[]> {
  const sources = (await readConfiguredFeedSources(runtime)).filter((source) => source.enabled);
  const selected = selectSources(sources, options.source);
  return Promise.all(selected.map((source) => loadFeedDocument(source, runtime)));
}

async function readConfiguredFeedSources(
  runtime: FeedsCommandRuntime,
): Promise<readonly FeedSourceConfig[]> {
  const readSnapshot = runtime.readConfigSnapshot ?? readConfigFileSnapshot;
  const snapshot = await readSnapshot({ observe: false });
  if (!snapshot.valid) {
    const firstIssue = snapshot.issues?.[0]?.message ?? "unknown config parse error";
    throw new Error(`OpenClaw config is invalid: ${firstIssue}`);
  }
  const config = snapshot.config.plugins?.entries?.feeds?.config;
  if (config === undefined) {
    return [];
  }
  if (!isRecord(config)) {
    throw new Error("plugins.entries.feeds.config must be an object.");
  }
  if (config.sources === undefined) {
    return [];
  }
  if (!Array.isArray(config.sources)) {
    throw new Error("plugins.entries.feeds.config.sources must be an array.");
  }
  return config.sources.map((source, index) => parseSourceConfig(source, index));
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

function formatFeedInstallCommand(entry: FeedEntry): string | undefined {
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
    if (clawhubSpec) {
      return formatOpenClawInstallCommand("plugins", normalizeClawHubSpec(clawhubSpec));
    }
    if (source === "clawhub" && spec) {
      return formatOpenClawInstallCommand("plugins", normalizeClawHubSpec(spec));
    }
    if (npmSpec) {
      return formatOpenClawInstallCommand("plugins", npmSpec);
    }
    if ((source === "npm" || source === "path" || source === "git") && spec) {
      return formatOpenClawInstallCommand("plugins", spec);
    }
    return undefined;
  }
  if (entry.type === "skill") {
    if (slug) {
      return formatOpenClawInstallCommand("skills", slug);
    }
    if (source === "clawhub" && spec) {
      return formatOpenClawInstallCommand("skills", spec.replace(/^clawhub:/u, ""));
    }
    if ((source === "git" || source === "path" || source === "local") && spec) {
      return formatOpenClawInstallCommand("skills", spec);
    }
  }
  return undefined;
}

function formatOpenClawInstallCommand(kind: "plugins" | "skills", spec: string): string {
  return `openclaw ${kind} install ${quoteCliArg(spec)}`;
}

function quoteCliArg(value: string): string {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeClawHubSpec(value: string): string {
  return value.startsWith("clawhub:") ? value : `clawhub:${value}`;
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
