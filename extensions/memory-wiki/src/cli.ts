import fs from "node:fs/promises";
import type { Command } from "commander";
import type { OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  resolveMemoryWikiConfig,
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type MemoryWikiPluginConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { lintMemoryWikiVault } from "./lint.js";
import {
  probeObsidianCli,
  runObsidianCommand,
  runObsidianDaily,
  runObsidianOpen,
  runObsidianSearch,
} from "./obsidian.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";
import { initializeMemoryWikiVault } from "./vault.js";

type WikiStatusCommandOptions = {
  json?: boolean;
};

type WikiDoctorCommandOptions = {
  json?: boolean;
};

type WikiInitCommandOptions = {
  json?: boolean;
};

type WikiCompileCommandOptions = {
  json?: boolean;
};

type WikiLintCommandOptions = {
  json?: boolean;
};

type WikiIngestCommandOptions = {
  json?: boolean;
  title?: string;
};

type WikiSearchCommandOptions = {
  json?: boolean;
  maxResults?: number;
  backend?: ResolvedMemoryWikiConfig["search"]["backend"];
  corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
};

type WikiGetCommandOptions = {
  json?: boolean;
  from?: number;
  lines?: number;
  backend?: ResolvedMemoryWikiConfig["search"]["backend"];
  corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
};

type WikiApplySynthesisCommandOptions = {
  json?: boolean;
  body?: string;
  bodyFile?: string;
  sourceId?: string[];
  contradiction?: string[];
  question?: string[];
  confidence?: number;
  status?: string;
};

type WikiApplyMetadataCommandOptions = {
  json?: boolean;
  sourceId?: string[];
  contradiction?: string[];
  question?: string[];
  confidence?: number;
  clearConfidence?: boolean;
  status?: string;
};

type WikiBridgeImportCommandOptions = {
  json?: boolean;
};

type WikiUnsafeLocalImportCommandOptions = {
  json?: boolean;
};

type WikiObsidianSearchCommandOptions = {
  json?: boolean;
};

type WikiObsidianOpenCommandOptions = {
  json?: boolean;
};

type WikiObsidianCommandCommandOptions = {
  json?: boolean;
};

type WikiObsidianDailyCommandOptions = {
  json?: boolean;
};

function isResolvedMemoryWikiConfig(
  config: MemoryWikiPluginConfig | ResolvedMemoryWikiConfig | undefined,
): config is ResolvedMemoryWikiConfig {
  return Boolean(
    config &&
    "vaultMode" in config &&
    "vault" in config &&
    "bridge" in config &&
    "obsidian" in config &&
    "unsafeLocal" in config,
  );
}

function writeOutput(output: string, writer: Pick<NodeJS.WriteStream, "write"> = process.stdout) {
  writer.write(output.endsWith("\n") ? output : `${output}\n`);
}

function normalizeCliStringList(values?: string[]): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  return normalized.length > 0 ? normalized : undefined;
}

function parseWikiSearchEnumOption<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(", ")}`);
}

async function resolveWikiApplyBody(params: { body?: string; bodyFile?: string }): Promise<string> {
  if (params.body?.trim()) {
    return params.body;
  }
  if (params.bodyFile?.trim()) {
    return await fs.readFile(params.bodyFile, "utf8");
  }
  throw new Error("wiki apply synthesis requires --body or --body-file.");
}

export async function runWikiStatus(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const status = await resolveMemoryWikiStatus(params.config);
  writeOutput(
    params.json ? JSON.stringify(status, null, 2) : renderMemoryWikiStatus(status),
    params.stdout,
  );
  return status;
}

export async function runWikiDoctor(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const report = buildMemoryWikiDoctorReport(await resolveMemoryWikiStatus(params.config));
  if (!report.healthy) {
    process.exitCode = 1;
  }
  writeOutput(
    params.json ? JSON.stringify(report, null, 2) : renderMemoryWikiDoctor(report),
    params.stdout,
  );
  return report;
}

export async function runWikiInit(params: {
  config: ResolvedMemoryWikiConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await initializeMemoryWikiVault(params.config);
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Initialized wiki vault at ${result.rootDir} (${result.createdDirectories.length} dirs, ${result.createdFiles.length} files).`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiCompile(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const result = await compileMemoryWikiVault(params.config);
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Compiled wiki vault at ${result.vaultRoot} (${result.pages.length} pages, ${result.updatedFiles.length} indexes updated).`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiLint(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const result = await lintMemoryWikiVault(params.config);
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Linted wiki vault at ${result.vaultRoot} (${result.issueCount} issues, report: ${result.reportPath}).`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiIngest(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await ingestMemoryWikiSource({
    config: params.config,
    inputPath: params.inputPath,
    title: params.title,
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Ingested ${result.sourcePath} into ${result.pagePath}. Refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiSearch(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  query: string;
  maxResults?: number;
  searchBackend?: ResolvedMemoryWikiConfig["search"]["backend"];
  searchCorpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const results = await searchMemoryWiki({
    config: params.config,
    appConfig: params.appConfig,
    query: params.query,
    maxResults: params.maxResults,
    searchBackend: params.searchBackend,
    searchCorpus: params.searchCorpus,
  });
  const summary = params.json
    ? JSON.stringify(results, null, 2)
    : results.length === 0
      ? "No wiki or memory results."
      : results
          .map(
            (result, index) =>
              `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}\nSnippet: ${result.snippet}`,
          )
          .join("\n\n");
  writeOutput(summary, params.stdout);
  return results;
}

export async function runWikiGet(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  searchBackend?: ResolvedMemoryWikiConfig["search"]["backend"];
  searchCorpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const result = await getMemoryWikiPage({
    config: params.config,
    appConfig: params.appConfig,
    lookup: params.lookup,
    fromLine: params.fromLine,
    lineCount: params.lineCount,
    searchBackend: params.searchBackend,
    searchCorpus: params.searchCorpus,
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : (result?.content ?? `Wiki page not found: ${params.lookup}`);
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiApplySynthesis(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  title: string;
  body?: string;
  bodyFile?: string;
  sourceIds?: string[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number;
  status?: string;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const sourceIds = normalizeCliStringList(params.sourceIds);
  if (!sourceIds) {
    throw new Error("wiki apply synthesis requires at least one --source-id.");
  }
  const body = await resolveWikiApplyBody({ body: params.body, bodyFile: params.bodyFile });
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const result = await applyMemoryWikiMutation({
    config: params.config,
    mutation: {
      op: "create_synthesis",
      title: params.title,
      body,
      sourceIds,
      ...(normalizeCliStringList(params.contradictions)
        ? { contradictions: normalizeCliStringList(params.contradictions) }
        : {}),
      ...(normalizeCliStringList(params.questions)
        ? { questions: normalizeCliStringList(params.questions) }
        : {}),
      ...(typeof params.confidence === "number" ? { confidence: params.confidence } : {}),
      ...(params.status?.trim() ? { status: params.status.trim() } : {}),
    },
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `${result.changed ? "Updated" : "No changes for"} ${result.pagePath} via ${result.operation}. ${result.compile.updatedFiles.length > 0 ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.` : "Indexes unchanged."}`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiApplyMetadata(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  lookup: string;
  sourceIds?: string[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number;
  clearConfidence?: boolean;
  status?: string;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  const result = await applyMemoryWikiMutation({
    config: params.config,
    mutation: {
      op: "update_metadata",
      lookup: params.lookup,
      ...(normalizeCliStringList(params.sourceIds)
        ? { sourceIds: normalizeCliStringList(params.sourceIds) }
        : {}),
      ...(normalizeCliStringList(params.contradictions)
        ? { contradictions: normalizeCliStringList(params.contradictions) }
        : {}),
      ...(normalizeCliStringList(params.questions)
        ? { questions: normalizeCliStringList(params.questions) }
        : {}),
      ...(params.clearConfidence
        ? { confidence: null }
        : typeof params.confidence === "number"
          ? { confidence: params.confidence }
          : {}),
      ...(params.status?.trim() ? { status: params.status.trim() } : {}),
    },
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `${result.changed ? "Updated" : "No changes for"} ${result.pagePath} via ${result.operation}. ${result.compile.updatedFiles.length > 0 ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.` : "Indexes unchanged."}`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiBridgeImport(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await syncMemoryWikiImportedSources({
    config: params.config,
    appConfig: params.appConfig,
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Bridge import synced ${result.artifactCount} artifacts across ${result.workspaces} workspaces (${result.importedCount} new, ${result.updatedCount} updated, ${result.skippedCount} unchanged, ${result.removedCount} removed). Indexes ${result.indexesRefreshed ? `refreshed (${result.indexUpdatedFiles.length} files)` : `not refreshed (${result.indexRefreshReason})`}.`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiUnsafeLocalImport(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await syncMemoryWikiImportedSources({
    config: params.config,
    appConfig: params.appConfig,
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Unsafe-local import synced ${result.artifactCount} artifacts (${result.importedCount} new, ${result.updatedCount} updated, ${result.skippedCount} unchanged, ${result.removedCount} removed). Indexes ${result.indexesRefreshed ? `refreshed (${result.indexUpdatedFiles.length} files)` : `not refreshed (${result.indexRefreshReason})`}.`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiObsidianStatus(params: {
  config: ResolvedMemoryWikiConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await probeObsidianCli();
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : result.available
      ? `Obsidian CLI available at ${result.command}`
      : "Obsidian CLI is not available on PATH.";
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiObsidianSearch(params: {
  config: ResolvedMemoryWikiConfig;
  query: string;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await runObsidianSearch({ config: params.config, query: params.query });
  const summary = params.json ? JSON.stringify(result, null, 2) : result.stdout.trim();
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiObsidianOpenCli(params: {
  config: ResolvedMemoryWikiConfig;
  vaultPath: string;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await runObsidianOpen({ config: params.config, vaultPath: params.vaultPath });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : result.stdout.trim() || "Opened in Obsidian.";
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiObsidianCommandCli(params: {
  config: ResolvedMemoryWikiConfig;
  id: string;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await runObsidianCommand({ config: params.config, id: params.id });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : result.stdout.trim() || "Command sent to Obsidian.";
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiObsidianDailyCli(params: {
  config: ResolvedMemoryWikiConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await runObsidianDaily({ config: params.config });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : result.stdout.trim() || "Opened today's daily note.";
  writeOutput(summary, params.stdout);
  return result;
}

export function registerWikiCli(
  program: Command,
  pluginConfig?: MemoryWikiPluginConfig | ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  const config = isResolvedMemoryWikiConfig(pluginConfig)
    ? pluginConfig
    : resolveMemoryWikiConfig(pluginConfig);
  const wiki = program.command("wiki").description("Inspect and initialize the memory wiki vault");

  wiki
    .command("status")
    .description("Show wiki vault status")
    .option("--json", "Print JSON")
    .action(async (opts: WikiStatusCommandOptions) => {
      await runWikiStatus({ config, appConfig, json: opts.json });
    });

  wiki
    .command("doctor")
    .description("Audit wiki vault setup and report actionable fixes")
    .option("--json", "Print JSON")
    .action(async (opts: WikiDoctorCommandOptions) => {
      await runWikiDoctor({ config, appConfig, json: opts.json });
    });

  wiki
    .command("init")
    .description("Initialize the wiki vault layout")
    .option("--json", "Print JSON")
    .action(async (opts: WikiInitCommandOptions) => {
      await runWikiInit({ config, json: opts.json });
    });

  wiki
    .command("compile")
    .description("Refresh generated wiki indexes")
    .option("--json", "Print JSON")
    .action(async (opts: WikiCompileCommandOptions) => {
      await runWikiCompile({ config, appConfig, json: opts.json });
    });

  wiki
    .command("lint")
    .description("Lint the wiki vault and write a report")
    .option("--json", "Print JSON")
    .action(async (opts: WikiLintCommandOptions) => {
      await runWikiLint({ config, appConfig, json: opts.json });
    });

  wiki
    .command("ingest")
    .description("Ingest a local file into the wiki sources folder")
    .argument("<path>", "Local file path to ingest")
    .option("--title <title>", "Override the source title")
    .option("--json", "Print JSON")
    .action(async (inputPath: string, opts: WikiIngestCommandOptions) => {
      await runWikiIngest({ config, inputPath, title: opts.title, json: opts.json });
    });

  wiki
    .command("search")
    .description("Search wiki pages and, when configured, the active memory corpus")
    .argument("<query>", "Search query")
    .option("--max-results <n>", "Maximum results", (value: string) => Number(value))
    .option(
      "--backend <backend>",
      `Search backend (${WIKI_SEARCH_BACKENDS.join(", ")})`,
      (value: string) => parseWikiSearchEnumOption(value, WIKI_SEARCH_BACKENDS, "backend"),
    )
    .option(
      "--corpus <corpus>",
      `Search corpus (${WIKI_SEARCH_CORPORA.join(", ")})`,
      (value: string) => parseWikiSearchEnumOption(value, WIKI_SEARCH_CORPORA, "corpus"),
    )
    .option("--json", "Print JSON")
    .action(async (query: string, opts: WikiSearchCommandOptions) => {
      await runWikiSearch({
        config,
        appConfig,
        query,
        maxResults: opts.maxResults,
        searchBackend: opts.backend,
        searchCorpus: opts.corpus,
        json: opts.json,
      });
    });

  wiki
    .command("get")
    .description("Read a wiki page by id or relative path, with optional active-memory fallback")
    .argument("<lookup>", "Relative path or page id")
    .option("--from <n>", "Start line", (value: string) => Number(value))
    .option("--lines <n>", "Number of lines", (value: string) => Number(value))
    .option(
      "--backend <backend>",
      `Search backend (${WIKI_SEARCH_BACKENDS.join(", ")})`,
      (value: string) => parseWikiSearchEnumOption(value, WIKI_SEARCH_BACKENDS, "backend"),
    )
    .option(
      "--corpus <corpus>",
      `Search corpus (${WIKI_SEARCH_CORPORA.join(", ")})`,
      (value: string) => parseWikiSearchEnumOption(value, WIKI_SEARCH_CORPORA, "corpus"),
    )
    .option("--json", "Print JSON")
    .action(async (lookup: string, opts: WikiGetCommandOptions) => {
      await runWikiGet({
        config,
        appConfig,
        lookup,
        fromLine: opts.from,
        lineCount: opts.lines,
        searchBackend: opts.backend,
        searchCorpus: opts.corpus,
        json: opts.json,
      });
    });

  const apply = wiki.command("apply").description("Apply narrow wiki mutations");
  apply
    .command("synthesis")
    .description("Create or refresh a synthesis page with managed summary content")
    .argument("<title>", "Synthesis title")
    .option("--body <text>", "Summary body text")
    .option("--body-file <path>", "Read summary body text from a file")
    .option("--source-id <id>", "Source id", (value: string, acc: string[] = []) => {
      acc.push(value);
      return acc;
    })
    .option("--contradiction <text>", "Contradiction note", (value: string, acc: string[] = []) => {
      acc.push(value);
      return acc;
    })
    .option("--question <text>", "Open question", (value: string, acc: string[] = []) => {
      acc.push(value);
      return acc;
    })
    .option("--confidence <n>", "Confidence score between 0 and 1", (value: string) =>
      Number(value),
    )
    .option("--status <status>", "Page status")
    .option("--json", "Print JSON")
    .action(async (title: string, opts: WikiApplySynthesisCommandOptions) => {
      await runWikiApplySynthesis({
        config,
        appConfig,
        title,
        body: opts.body,
        bodyFile: opts.bodyFile,
        sourceIds: opts.sourceId,
        contradictions: opts.contradiction,
        questions: opts.question,
        confidence: opts.confidence,
        status: opts.status,
        json: opts.json,
      });
    });
  apply
    .command("metadata")
    .description("Update metadata on an existing page")
    .argument("<lookup>", "Relative path or page id")
    .option("--source-id <id>", "Source id", (value: string, acc: string[] = []) => {
      acc.push(value);
      return acc;
    })
    .option("--contradiction <text>", "Contradiction note", (value: string, acc: string[] = []) => {
      acc.push(value);
      return acc;
    })
    .option("--question <text>", "Open question", (value: string, acc: string[] = []) => {
      acc.push(value);
      return acc;
    })
    .option("--confidence <n>", "Confidence score between 0 and 1", (value: string) =>
      Number(value),
    )
    .option("--clear-confidence", "Remove any stored confidence value")
    .option("--status <status>", "Page status")
    .option("--json", "Print JSON")
    .action(async (lookup: string, opts: WikiApplyMetadataCommandOptions) => {
      await runWikiApplyMetadata({
        config,
        appConfig,
        lookup,
        sourceIds: opts.sourceId,
        contradictions: opts.contradiction,
        questions: opts.question,
        confidence: opts.confidence,
        clearConfidence: opts.clearConfidence,
        status: opts.status,
        json: opts.json,
      });
    });

  const bridge = wiki
    .command("bridge")
    .description("Import public memory-core artifacts into the wiki vault");
  bridge
    .command("import")
    .description("Sync bridge-backed memory-core artifacts into wiki source pages")
    .option("--json", "Print JSON")
    .action(async (opts: WikiBridgeImportCommandOptions) => {
      await runWikiBridgeImport({ config, appConfig, json: opts.json });
    });

  const unsafeLocal = wiki
    .command("unsafe-local")
    .description("Import explicitly configured private local paths into wiki source pages");
  unsafeLocal
    .command("import")
    .description("Sync unsafe-local configured paths into wiki source pages")
    .option("--json", "Print JSON")
    .action(async (opts: WikiUnsafeLocalImportCommandOptions) => {
      await runWikiUnsafeLocalImport({ config, appConfig, json: opts.json });
    });

  const obsidian = wiki.command("obsidian").description("Run official Obsidian CLI helpers");
  obsidian
    .command("status")
    .description("Probe the Obsidian CLI")
    .option("--json", "Print JSON")
    .action(async (opts: WikiStatusCommandOptions) => {
      await runWikiObsidianStatus({ config, json: opts.json });
    });
  obsidian
    .command("search")
    .description("Search the current Obsidian vault")
    .argument("<query>", "Search query")
    .option("--json", "Print JSON")
    .action(async (query: string, opts: WikiObsidianSearchCommandOptions) => {
      await runWikiObsidianSearch({ config, query, json: opts.json });
    });
  obsidian
    .command("open")
    .description("Open a file in Obsidian by vault-relative path")
    .argument("<path>", "Vault-relative path")
    .option("--json", "Print JSON")
    .action(async (vaultPath: string, opts: WikiObsidianOpenCommandOptions) => {
      await runWikiObsidianOpenCli({ config, vaultPath, json: opts.json });
    });
  obsidian
    .command("command")
    .description("Execute an Obsidian command palette command by id")
    .argument("<id>", "Obsidian command id")
    .option("--json", "Print JSON")
    .action(async (id: string, opts: WikiObsidianCommandCommandOptions) => {
      await runWikiObsidianCommandCli({ config, id, json: opts.json });
    });
  obsidian
    .command("daily")
    .description("Open today's daily note in Obsidian")
    .option("--json", "Print JSON")
    .action(async (opts: WikiObsidianDailyCommandOptions) => {
      await runWikiObsidianDailyCli({ config, json: opts.json });
    });
}
