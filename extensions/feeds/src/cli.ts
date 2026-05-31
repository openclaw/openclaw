import { spawn } from "node:child_process";
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
  runOpenClawCommand?: (argv: readonly string[]) => Promise<number>;
};

export type FeedsCommandOptions = {
  readonly json?: boolean;
  readonly source?: string;
  readonly type?: string;
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
