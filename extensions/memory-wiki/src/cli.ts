import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-host-core";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation } from "./apply.js";
import {
  importChatGptConversations,
  rollbackChatGptImportRun,
  type ChatGptImportResult,
  type ChatGptRollbackResult,
} from "./chatgpt-import.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  resolveMemoryWikiAgentConfig,
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type MemoryWikiConfigResolver,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { lintMemoryWikiVault } from "./lint.js";
import {
  probeObsidianCli,
  OBSIDIAN_ACTIONS,
  assertOfficialObsidianCliSupported,
  runObsidianAction,
} from "./obsidian.js";
import { formatOkfImportSummary, importMemoryWikiOkfBundle } from "./okf.js";
import { renderWikiMutationSummary, renderWikiSearchResults } from "./presentation.js";
import {
  getMemoryWikiPage,
  searchMemoryWiki,
  WIKI_SEARCH_MODES,
  type WikiSearchMode,
} from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import type { MemoryWikiImportedSourceSyncResult } from "./source-sync.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  type MemoryWikiDoctorReport,
  type MemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";
import { initializeMemoryWikiVault } from "./vault.js";

const WIKI_GATEWAY_TIMEOUT_MS = "30000";
const GATEWAY_TERMINAL_STRING_MAX_CHARS = 2_000;
const GATEWAY_RESPONSE_MAX_ARRAY_ITEMS = 10_000;
const GATEWAY_RESPONSE_MAX_STRING_CHARS = 10_000;
const GATEWAY_RESPONSE_MAX_CODE_CHARS = 256;
const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  String.raw`(?:\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_]|\x9B[0-?]*[ -/]*[@-~])`,
  "g",
);
const TERMINAL_CONTROL_CHARACTER_PATTERN = new RegExp(String.raw`[\x00-\x1F\x7F-\x9F]+`, "g");
const UNICODE_FORMAT_CONTROL_PATTERN = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

type WikiJsonOptions = {
  json?: boolean;
};

type WikiIngestCommandOptions = WikiJsonOptions & {
  title?: string;
};

type WikiSearchCommandOptions = WikiJsonOptions & {
  maxResults?: number;
  backend?: ResolvedMemoryWikiConfig["search"]["backend"];
  corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
  mode?: WikiSearchMode;
};

type WikiGetCommandOptions = WikiJsonOptions & {
  from?: number;
  lines?: number;
  backend?: ResolvedMemoryWikiConfig["search"]["backend"];
  corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
};

type WikiApplySynthesisCommandOptions = Omit<WikiApplyMetadataCommandOptions, "clearConfidence"> & {
  body?: string;
  bodyFile?: string;
};

type WikiApplyMetadataCommandOptions = WikiJsonOptions & {
  sourceId?: string[];
  contradiction?: string[];
  question?: string[];
  confidence?: number;
  clearConfidence?: boolean;
  status?: string;
};

type WikiChatGptImportCommandOptions = WikiJsonOptions & {
  dryRun?: boolean;
  export?: string;
};

type WikiCommandOptions = {
  agent?: string;
};

type MemoryWikiCliRegistration = {
  config: ResolvedMemoryWikiConfig;
  resolveConfig?: MemoryWikiConfigResolver;
  getAppConfig?: () => OpenClawConfig | undefined;
};

function sanitizeGatewayStringForTerminal(value: string): string {
  const truncated =
    value.length > GATEWAY_TERMINAL_STRING_MAX_CHARS
      ? truncateUtf16Safe(value, GATEWAY_TERMINAL_STRING_MAX_CHARS)
      : value;
  const sanitized = truncated
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, " ")
    .replace(UNICODE_FORMAT_CONTROL_PATTERN, "");
  return value.length > GATEWAY_TERMINAL_STRING_MAX_CHARS
    ? `${sanitized}... [truncated]`
    : sanitized;
}

function escapeGatewayJsonForTerminal(json: string): string {
  return json.replace(UNICODE_FORMAT_CONTROL_PATTERN, (char) => {
    const codePoint = char.codePointAt(0);
    return typeof codePoint === "number" ? `\\u${codePoint.toString(16).padStart(4, "0")}` : "";
  });
}

function writeOutput(output: string) {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

function shouldRouteBridgeRuntimeThroughGateway(config: ResolvedMemoryWikiConfig): boolean {
  return (
    config.vaultMode === "bridge" && config.bridge.enabled && config.bridge.readMemoryArtifacts
  );
}

function isBoundedGatewayString(
  value: unknown,
  maxChars = GATEWAY_RESPONSE_MAX_STRING_CHARS,
): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

function isStringArray(
  value: unknown,
  maxChars = GATEWAY_RESPONSE_MAX_STRING_CHARS,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= GATEWAY_RESPONSE_MAX_ARRAY_ITEMS &&
    value.every((item) => isBoundedGatewayString(item, maxChars))
  );
}

function hasNumberFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "number");
}

function isWarningList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= GATEWAY_RESPONSE_MAX_ARRAY_ITEMS &&
    value.every(
      (item) =>
        isRecord(item) &&
        isBoundedGatewayString(item.code, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
        isBoundedGatewayString(item.message),
    )
  );
}

function isMemoryWikiStatus(value: unknown): value is MemoryWikiStatus {
  if (!isRecord(value)) {
    return false;
  }
  const bridge = value.bridge;
  const obsidianCli = value.obsidianCli;
  const unsafeLocal = value.unsafeLocal;
  const pageCounts = value.pageCounts;
  const sourceCounts = value.sourceCounts;
  return (
    isBoundedGatewayString(value.vaultScope, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
    (isBoundedGatewayString(value.agentId, GATEWAY_RESPONSE_MAX_CODE_CHARS) ||
      value.agentId === null) &&
    isBoundedGatewayString(value.vaultMode, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
    isBoundedGatewayString(value.renderMode, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
    isBoundedGatewayString(value.vaultPath) &&
    typeof value.vaultExists === "boolean" &&
    (typeof value.bridgePublicArtifactCount === "number" ||
      value.bridgePublicArtifactCount === null) &&
    isRecord(bridge) &&
    typeof bridge.enabled === "boolean" &&
    isRecord(obsidianCli) &&
    typeof obsidianCli.enabled === "boolean" &&
    typeof obsidianCli.requested === "boolean" &&
    typeof obsidianCli.available === "boolean" &&
    (isBoundedGatewayString(obsidianCli.command) || obsidianCli.command === null) &&
    isRecord(unsafeLocal) &&
    typeof unsafeLocal.allowPrivateMemoryCoreAccess === "boolean" &&
    typeof unsafeLocal.pathCount === "number" &&
    isRecord(pageCounts) &&
    hasNumberFields(pageCounts, ["source", "entity", "concept", "synthesis", "report"]) &&
    isRecord(sourceCounts) &&
    hasNumberFields(sourceCounts, ["native", "bridge", "bridgeEvents", "unsafeLocal", "other"]) &&
    isWarningList(value.warnings)
  );
}

function isMemoryWikiDoctorReport(value: unknown): value is MemoryWikiDoctorReport {
  return (
    isRecord(value) &&
    typeof value.healthy === "boolean" &&
    typeof value.warningCount === "number" &&
    isMemoryWikiStatus(value.status) &&
    isWarningList(value.fixes)
  );
}

function isMemoryWikiImportResult(value: unknown): value is MemoryWikiImportedSourceSyncResult {
  return (
    isRecord(value) &&
    hasNumberFields(value, [
      "importedCount",
      "updatedCount",
      "skippedCount",
      "removedCount",
      "artifactCount",
      "workspaces",
    ]) &&
    isStringArray(value.pagePaths) &&
    typeof value.indexesRefreshed === "boolean" &&
    isStringArray(value.indexUpdatedFiles) &&
    isBoundedGatewayString(value.indexRefreshReason, GATEWAY_RESPONSE_MAX_CODE_CHARS)
  );
}

async function callWikiGateway(method: "wiki.status", agentId?: string): Promise<MemoryWikiStatus>;
async function callWikiGateway(
  method: "wiki.doctor",
  agentId?: string,
): Promise<MemoryWikiDoctorReport>;
async function callWikiGateway(
  method: "wiki.bridge.import",
  agentId?: string,
): Promise<MemoryWikiImportedSourceSyncResult>;
async function callWikiGateway(
  method: "wiki.status" | "wiki.doctor" | "wiki.bridge.import",
  agentId?: string,
) {
  const result = await callGatewayFromCli(
    method,
    { timeout: WIKI_GATEWAY_TIMEOUT_MS },
    agentId ? { agentId } : undefined,
    { progress: false },
  );
  if (
    (method === "wiki.status" && isMemoryWikiStatus(result)) ||
    (method === "wiki.doctor" && isMemoryWikiDoctorReport(result)) ||
    (method === "wiki.bridge.import" && isMemoryWikiImportResult(result))
  ) {
    return result;
  }
  throw new Error(`Invalid Gateway response for ${method}.`);
}

function normalizeCliStringList(values?: string[]): string[] | undefined {
  const uniqueValues = uniqueStrings(normalizeStringEntries(values ?? []));
  return uniqueValues.length > 0 ? uniqueValues : undefined;
}

function resolveCliMutationMetadata(opts: WikiApplyMetadataCommandOptions) {
  const sourceIds = normalizeCliStringList(opts.sourceId);
  const contradictions = normalizeCliStringList(opts.contradiction);
  const questions = normalizeCliStringList(opts.question);
  return {
    ...(sourceIds ? { sourceIds } : {}),
    ...(contradictions ? { contradictions } : {}),
    ...(questions ? { questions } : {}),
    ...(opts.status?.trim() ? { status: opts.status.trim() } : {}),
  };
}

function collectCliValues(value: string, acc: string[] = []) {
  acc.push(value);
  return acc;
}

function parseWikiSearchEnumOption<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw invalidCliArgument(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(", ")}`);
}

function failWikiCli(message: string): never {
  // Surface the operator-facing reason on stderr. Throw a commander parse-exit so
  // run-main sets exitCode without the generic "The CLI command failed." title.
  console.error(message);
  throw Object.assign(new Error(message), {
    name: "InvalidArgumentError",
    code: "commander.invalidArgument",
    exitCode: 1,
  });
}

async function resolveWikiApplyBody(params: { body?: string; bodyFile?: string }): Promise<string> {
  if (params.body?.trim()) {
    return params.body;
  }
  if (params.bodyFile?.trim()) {
    const bytes = await fs.readFile(params.bodyFile);
    // Reject before mutation: blank files would wipe an existing synthesis, and
    // replacement decoding would turn Latin-1 bytes into U+FFFD in the vault.
    if (!isUtf8(bytes)) {
      failWikiCli(
        `wiki apply synthesis --body-file must be valid UTF-8: ${params.bodyFile}. Save the file as UTF-8, then retry.`,
      );
    }
    const text = bytes.toString("utf8");
    if (!text.trim()) {
      failWikiCli(
        `wiki apply synthesis --body-file is empty: ${params.bodyFile}. Supply nonempty UTF-8 text (or use --body), then retry.`,
      );
    }
    return text;
  }
  failWikiCli("wiki apply synthesis requires --body or --body-file.");
}

function formatJsonOrText<T>(
  result: T,
  json: boolean | undefined,
  render: (result: T) => string,
): string {
  return json ? JSON.stringify(result, null, 2) : render(result);
}

function formatGatewayJsonOrText<T>(
  result: T,
  json: boolean | undefined,
  render: (result: T) => string,
): string {
  return json
    ? escapeGatewayJsonForTerminal(JSON.stringify(result, null, 2))
    : sanitizeGatewayStringForTerminal(render(result));
}

function printWikiResult<T>(
  result: T,
  json: boolean | undefined,
  render: (result: T) => string,
): T {
  writeOutput(formatJsonOrText(result, json, render));
  return result;
}

function addWikiSearchConfigOptions<T extends Command>(command: T): T {
  return command
    .option(
      "--backend <backend>",
      `Search backend (${WIKI_SEARCH_BACKENDS.join(", ")})`,
      (value: string) => parseWikiSearchEnumOption(value, WIKI_SEARCH_BACKENDS, "backend"),
    )
    .option(
      "--corpus <corpus>",
      `Search corpus (${WIKI_SEARCH_CORPORA.join(", ")})`,
      (value: string) => parseWikiSearchEnumOption(value, WIKI_SEARCH_CORPORA, "corpus"),
    );
}

function invalidCliArgument(message: string): Error & { code: string; exitCode: number } {
  // Commander recognizes parser failures by code; keep the import type-only for bundled plugin deps.
  return Object.assign(new Error(message), {
    name: "InvalidArgumentError",
    code: "commander.invalidArgument",
    exitCode: 1,
  });
}

function parseWikiConfidenceOption(value: string): number {
  const trimmed = value.trim();
  const confidence = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw invalidCliArgument("--confidence must be a number between 0 and 1.");
  }
  return confidence;
}

function parseWikiPositiveIntegerOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw invalidCliArgument(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function addWikiApplyMutationOptions<T extends Command>(command: T): T {
  return command
    .option("--source-id <id>", "Source id", collectCliValues)
    .option("--contradiction <text>", "Contradiction note", collectCliValues)
    .option("--question <text>", "Open question", collectCliValues)
    .option("--confidence <n>", "Confidence score between 0 and 1", parseWikiConfidenceOption)
    .option("--status <status>", "Page status");
}

async function runWikiStatus(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
  json?: boolean;
  doctor?: boolean;
}) {
  const routeThroughGateway = shouldRouteBridgeRuntimeThroughGateway(params.config);
  let localStatus: MemoryWikiStatus | undefined;
  if (!routeThroughGateway) {
    await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
    localStatus = await resolveMemoryWikiStatus(params.config, { appConfig: params.appConfig });
  }
  const format = routeThroughGateway ? formatGatewayJsonOrText : formatJsonOrText;
  if (params.doctor) {
    const report = localStatus
      ? buildMemoryWikiDoctorReport(localStatus)
      : await callWikiGateway("wiki.doctor", params.agentId);
    if (!report.healthy) {
      process.exitCode = 1;
    }
    writeOutput(format(report, params.json, renderMemoryWikiDoctor));
    return report;
  }
  const status = localStatus ?? (await callWikiGateway("wiki.status", params.agentId));
  writeOutput(format(status, params.json, renderMemoryWikiStatus));
  return status;
}

async function runWikiBridgeImport(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
  json?: boolean;
}) {
  const render = (value: MemoryWikiImportedSourceSyncResult) =>
    `Bridge import synced ${value.artifactCount} artifacts across ${value.workspaces} workspaces (${value.importedCount} new, ${value.updatedCount} updated, ${value.skippedCount} unchanged, ${value.removedCount} removed). Indexes ${value.indexesRefreshed ? `refreshed (${value.indexUpdatedFiles.length} files)` : `not refreshed (${value.indexRefreshReason})`}.`;
  if (shouldRouteBridgeRuntimeThroughGateway(params.config)) {
    const result = await callWikiGateway("wiki.bridge.import", params.agentId);
    writeOutput(formatGatewayJsonOrText(result, params.json, render));
    return result;
  }
  return printWikiResult(
    await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig }),
    params.json,
    render,
  );
}

function formatChatGptImportSummary(result: ChatGptImportResult): string {
  if (result.dryRun) {
    return `ChatGPT import dry run scanned ${result.conversationCount} conversations (${result.createdCount} new, ${result.updatedCount} updated, ${result.skippedCount} unchanged).`;
  }
  const runSuffix = result.runId ? ` Run id: ${result.runId}.` : "";
  return `ChatGPT import applied ${result.conversationCount} conversations (${result.createdCount} new, ${result.updatedCount} updated, ${result.skippedCount} unchanged). Refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.${runSuffix}`;
}

function formatChatGptRollbackSummary(result: ChatGptRollbackResult): string {
  const preservedNote =
    result.preservedPaths.length > 0
      ? ` Preserved ${result.preservedPaths.length} page${result.preservedPaths.length === 1 ? "" : "s"} edited after import: ${result.preservedPaths.map((entry) => entry.recoveryPath).join(", ")}.`
      : "";
  if (result.alreadyRolledBack) {
    return `ChatGPT import run ${result.runId} was already rolled back.${preservedNote}`;
  }
  return `Rolled back ChatGPT import run ${result.runId} (${result.removedCount} removed, ${result.restoredCount} restored).${preservedNote} Refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.`;
}

export function registerWikiCli(program: Command, registration: MemoryWikiCliRegistration) {
  const resolveConfig: MemoryWikiConfigResolver =
    registration.resolveConfig ??
    ((agentId, currentAppConfig) =>
      resolveMemoryWikiAgentConfig({
        config: registration.config,
        appConfig: currentAppConfig,
        ...(agentId ? { agentId } : {}),
      }));
  let commandContext:
    | { agentId?: string; appConfig?: OpenClawConfig; config: ResolvedMemoryWikiConfig }
    | undefined;
  const requireCommandContext = () => {
    if (!commandContext) {
      throw new Error("Memory Wiki CLI agent context was not resolved.");
    }
    return commandContext;
  };
  const wiki = program
    .command("wiki")
    .description("Inspect and initialize the memory wiki vault")
    .option("--agent <id>", "Agent id for agent-scoped wiki vaults");
  wiki.hook("preAction", (_thisCommand, actionCommand) => {
    const needsAgent = actionCommand.options.some((option) => option.long === "--agent");
    const requestedAgentId =
      actionCommand.opts<WikiCommandOptions>().agent?.trim() ||
      wiki.opts<WikiCommandOptions>().agent?.trim() ||
      undefined;
    const currentAppConfig = registration.getAppConfig?.();
    let agentId = requestedAgentId;
    if (
      needsAgent &&
      !agentId &&
      (registration.config.vault.scope === "agent" || currentAppConfig)
    ) {
      try {
        agentId = resolveDefaultAgentId(currentAppConfig ?? {});
      } catch {
        throw new Error(
          "No default memory-wiki agent is configured. Pass --agent <id>, or add an agent with `openclaw agents add`.",
        );
      }
    }
    const config = needsAgent ? resolveConfig(agentId, currentAppConfig) : registration.config;
    agentId = config.agentId ?? agentId;
    commandContext = {
      config,
      ...(currentAppConfig ? { appConfig: currentAppConfig } : {}),
      ...(agentId ? { agentId } : {}),
    };
  });

  const vaultCommand = (parent: Command, name: string, description: string) =>
    parent
      .command(name)
      .description(description)
      .option("--agent <id>", "Agent id (default: configured default agent)");

  for (const [name, description] of [
    ["status", "Show wiki vault status"],
    ["doctor", "Audit wiki vault setup and report actionable fixes"],
  ] as const) {
    vaultCommand(wiki, name, description)
      .option("--json", "Print JSON")
      .action(async (opts: WikiJsonOptions) => {
        await runWikiStatus({
          ...requireCommandContext(),
          json: opts.json,
          doctor: name === "doctor",
        });
      });
  }

  vaultCommand(wiki, "init", "Initialize the wiki vault layout")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      printWikiResult(
        await initializeMemoryWikiVault(config),
        opts.json,
        (value) =>
          `Initialized wiki vault at ${value.rootDir} (${value.createdDirectories.length} dirs, ${value.createdFiles.length} files).`,
      );
    });

  vaultCommand(wiki, "compile", "Refresh generated wiki indexes")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { appConfig, config } = requireCommandContext();
      await syncMemoryWikiImportedSources({ config, appConfig });
      printWikiResult(
        await compileMemoryWikiVault(config),
        opts.json,
        (value) =>
          `Compiled wiki vault at ${value.vaultRoot} (${value.pages.length} pages, ${value.updatedFiles.length} indexes updated).`,
      );
    });

  vaultCommand(wiki, "lint", "Lint the wiki vault and write a report")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { appConfig, config } = requireCommandContext();
      await syncMemoryWikiImportedSources({ config, appConfig });
      printWikiResult(
        await lintMemoryWikiVault(config),
        opts.json,
        (value) =>
          `Linted wiki vault at ${value.vaultRoot} (${value.issueCount} issues, report: ${value.reportPath}).`,
      );
    });

  vaultCommand(wiki, "ingest", "Ingest a local file into the wiki sources folder")
    .argument("<path>", "Local file path to ingest")
    .option("--title <title>", "Override the source title")
    .option("--json", "Print JSON")
    .action(async (inputPath: string, opts: WikiIngestCommandOptions) => {
      const { config } = requireCommandContext();
      printWikiResult(
        await ingestMemoryWikiSource({ config, inputPath, title: opts.title }),
        opts.json,
        (value) =>
          `Ingested ${value.sourcePath} into ${value.pagePath}. Refreshed ${value.indexUpdatedFiles.length} index file${value.indexUpdatedFiles.length === 1 ? "" : "s"}.`,
      );
    });

  const okf = wiki.command("okf").description("Import Open Knowledge Format bundles");
  vaultCommand(okf, "import", "Import an unpacked OKF bundle into wiki concept pages")
    .argument("<path>", "OKF bundle directory")
    .option("--json", "Print JSON")
    .action(async (bundlePath: string, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      printWikiResult(
        await importMemoryWikiOkfBundle({ config, bundlePath }),
        opts.json,
        formatOkfImportSummary,
      );
    });

  addWikiSearchConfigOptions(
    vaultCommand(wiki, "search", "Search wiki pages and, when configured, the active memory corpus")
      .argument("<query>", "Search query")
      .option("--max-results <n>", "Maximum results", (value: string) =>
        parseWikiPositiveIntegerOption(value, "--max-results"),
      )
      .option("--mode <mode>", `Search mode (${WIKI_SEARCH_MODES.join(", ")})`),
  )
    .option("--json", "Print JSON")
    .action(async (query: string, opts: WikiSearchCommandOptions) => {
      const { agentId, appConfig, config } = requireCommandContext();
      if (opts.mode && !(WIKI_SEARCH_MODES as readonly string[]).includes(opts.mode)) {
        throw new Error(`wiki search --mode must be one of: ${WIKI_SEARCH_MODES.join(", ")}.`);
      }
      await syncMemoryWikiImportedSources({ config, appConfig });
      const results = await searchMemoryWiki({
        config,
        appConfig,
        ...(agentId ? { agentId } : {}),
        query,
        maxResults: opts.maxResults,
        searchBackend: opts.backend,
        searchCorpus: opts.corpus,
        mode: opts.mode,
      });
      writeOutput(formatJsonOrText(results, opts.json, renderWikiSearchResults));
    });

  addWikiSearchConfigOptions(
    vaultCommand(
      wiki,
      "get",
      "Read a wiki page by id or relative path, with optional active-memory fallback",
    )
      .argument("<lookup>", "Relative path or page id")
      .option("--from <n>", "Start line", (value: string) =>
        parseWikiPositiveIntegerOption(value, "--from"),
      )
      .option("--lines <n>", "Number of lines", (value: string) =>
        parseWikiPositiveIntegerOption(value, "--lines"),
      ),
  )
    .option("--json", "Print JSON")
    .action(async (lookup: string, opts: WikiGetCommandOptions) => {
      const { agentId, appConfig, config } = requireCommandContext();
      await syncMemoryWikiImportedSources({ config, appConfig });
      const result = await getMemoryWikiPage({
        config,
        appConfig,
        ...(agentId ? { agentId } : {}),
        lookup,
        fromLine: opts.from,
        lineCount: opts.lines,
        searchBackend: opts.backend,
        searchCorpus: opts.corpus,
      });
      const summary = opts.json
        ? JSON.stringify(result, null, 2)
        : (result?.content ?? `Wiki page not found: ${lookup}`);
      writeOutput(summary);
    });

  const apply = wiki.command("apply").description("Apply narrow wiki mutations");
  addWikiApplyMutationOptions(
    vaultCommand(
      apply,
      "synthesis",
      "Create or refresh a synthesis page with managed summary content",
    )
      .argument("<title>", "Synthesis title")
      .option("--body <text>", "Summary body text")
      .option("--body-file <path>", "Read summary body text from a file"),
  )
    .option("--json", "Print JSON")
    .action(async (title: string, opts: WikiApplySynthesisCommandOptions) => {
      const { appConfig, config } = requireCommandContext();
      const metadata = resolveCliMutationMetadata(opts);
      const sourceIds = metadata.sourceIds;
      if (!sourceIds) {
        throw new Error("wiki apply synthesis requires at least one --source-id.");
      }
      const body = await resolveWikiApplyBody({ body: opts.body, bodyFile: opts.bodyFile });
      await syncMemoryWikiImportedSources({ config, appConfig });
      const result = await applyMemoryWikiMutation({
        config,
        mutation: {
          op: "create_synthesis",
          title,
          body,
          ...metadata,
          sourceIds,
          ...(typeof opts.confidence === "number" ? { confidence: opts.confidence } : {}),
        },
      });
      writeOutput(formatJsonOrText(result, opts.json, renderWikiMutationSummary));
    });
  addWikiApplyMutationOptions(
    vaultCommand(apply, "metadata", "Update metadata on an existing page").argument(
      "<lookup>",
      "Relative path or page id",
    ),
  )
    .option("--clear-confidence", "Remove any stored confidence value")
    .option("--json", "Print JSON")
    .action(async (lookup: string, opts: WikiApplyMetadataCommandOptions) => {
      const { appConfig, config } = requireCommandContext();
      await syncMemoryWikiImportedSources({ config, appConfig });
      const result = await applyMemoryWikiMutation({
        config,
        mutation: {
          op: "update_metadata",
          lookup,
          ...resolveCliMutationMetadata(opts),
          ...(opts.clearConfidence
            ? { confidence: null }
            : typeof opts.confidence === "number"
              ? { confidence: opts.confidence }
              : {}),
        },
      });
      writeOutput(formatJsonOrText(result, opts.json, renderWikiMutationSummary));
    });

  const bridge = wiki
    .command("bridge")
    .description("Import public memory artifacts into the wiki vault");
  vaultCommand(bridge, "import", "Sync bridge-backed memory artifacts into wiki source pages")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { agentId, appConfig, config } = requireCommandContext();
      await runWikiBridgeImport({ config, appConfig, agentId, json: opts.json });
    });

  const unsafeLocal = wiki
    .command("unsafe-local")
    .description("Import explicitly configured private local paths into wiki source pages");
  unsafeLocal
    .command("import")
    .description("Sync unsafe-local configured paths into wiki source pages")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { appConfig, config } = requireCommandContext();
      if (config.vault.scope === "agent") {
        throw new Error("Unsafe-local import does not support memory-wiki vault.scope=agent.");
      }
      printWikiResult(
        await syncMemoryWikiImportedSources({ config, appConfig }),
        opts.json,
        (value) =>
          `Unsafe-local import synced ${value.artifactCount} artifacts (${value.importedCount} new, ${value.updatedCount} updated, ${value.skippedCount} unchanged, ${value.removedCount} removed). Indexes ${value.indexesRefreshed ? `refreshed (${value.indexUpdatedFiles.length} files)` : `not refreshed (${value.indexRefreshReason})`}.`,
      );
    });

  const chatgpt = wiki
    .command("chatgpt")
    .description("Import ChatGPT export history into wiki source pages");
  chatgpt
    .command("import")
    .description("Import a ChatGPT export into draft wiki source pages")
    .requiredOption("--export <path>", "ChatGPT export directory or conversations.json path")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--dry-run", "Preview changes without writing", false)
    .option("--json", "Print JSON")
    .action(async (opts: WikiChatGptImportCommandOptions) => {
      const { config } = requireCommandContext();
      printWikiResult(
        await importChatGptConversations({
          config,
          exportPath: opts.export!,
          dryRun: opts.dryRun,
        }),
        opts.json,
        formatChatGptImportSummary,
      );
    });
  vaultCommand(chatgpt, "rollback", "Roll back a previously applied ChatGPT import run")
    .argument("<run-id>", "Import run id")
    .option("--json", "Print JSON")
    .action(async (runId: string, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      printWikiResult(
        await rollbackChatGptImportRun({ config, runId }),
        opts.json,
        formatChatGptRollbackSummary,
      );
    });

  const obsidian = wiki.command("obsidian").description("Run official Obsidian CLI helpers");
  obsidian
    .command("status")
    .description("Check the Obsidian CLI")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      requireCommandContext();
      printWikiResult(await probeObsidianCli(), opts.json, (value) =>
        value.available
          ? `Obsidian CLI available at ${value.command}`
          : "Obsidian CLI is not available on PATH.",
      );
    });
  for (const action of OBSIDIAN_ACTIONS) {
    const command = obsidian.command(action.command).description(action.description);
    if (action.argument) {
      command.argument(`<${action.argument.name}>`, action.argument.description);
    }
    command.option("--json", "Print JSON");
    const run = async (value: string | undefined, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      assertOfficialObsidianCliSupported(config);
      printWikiResult(
        await runObsidianAction({ config, action, value }),
        opts.json,
        (result) => result.stdout.trim() || action.success,
      );
    };
    if (action.argument) {
      command.action((value: string, opts: WikiJsonOptions) => run(value, opts));
    } else {
      command.action((opts: WikiJsonOptions) => run(undefined, opts));
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
