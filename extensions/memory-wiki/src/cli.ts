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
  runObsidianCommand,
  runObsidianDaily,
  runObsidianOpen,
  runObsidianSearch,
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

function validateWikiGatewayResult(
  method: "wiki.status" | "wiki.doctor" | "wiki.bridge.import",
  value: unknown,
): MemoryWikiStatus | MemoryWikiDoctorReport | MemoryWikiImportedSourceSyncResult {
  if (method === "wiki.status" && isMemoryWikiStatus(value)) {
    return value;
  }
  if (method === "wiki.doctor" && isMemoryWikiDoctorReport(value)) {
    return value;
  }
  if (method === "wiki.bridge.import" && isMemoryWikiImportResult(value)) {
    return value;
  }
  throw new Error(`Invalid Gateway response for ${method}.`);
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
  return validateWikiGatewayResult(method, result);
}

function normalizeCliStringList(values?: string[]): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const uniqueValues = uniqueStrings(normalizeStringEntries(values));
  return uniqueValues.length > 0 ? uniqueValues : undefined;
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

async function runWikiCommandWithSummary<T>(params: {
  json?: boolean;
  run: () => Promise<T>;
  render: (result: T) => string;
}): Promise<T> {
  const result = await params.run();
  writeOutput(formatJsonOrText(result, params.json, params.render));
  return result;
}

async function runSyncedWikiCommandWithSummary<T>(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  json?: boolean;
  run: () => Promise<T>;
  render: (result: T) => string;
}): Promise<T> {
  await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
  return runWikiCommandWithSummary(params);
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
  const error = new Error(message) as Error & { code: string; exitCode: number };
  error.name = "InvalidArgumentError";
  // Commander recognizes parser failures by code; keep the import type-only for bundled plugin deps.
  error.code = "commander.invalidArgument";
  error.exitCode = 1;
  return error;
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
}) {
  const routeThroughGateway = shouldRouteBridgeRuntimeThroughGateway(params.config);
  const status = routeThroughGateway
    ? await callWikiGateway("wiki.status", params.agentId)
    : await (async () => {
        await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
        return await resolveMemoryWikiStatus(params.config, {
          appConfig: params.appConfig,
        });
      })();
  writeOutput(
    routeThroughGateway
      ? formatGatewayJsonOrText(status, params.json, renderMemoryWikiStatus)
      : formatJsonOrText(status, params.json, renderMemoryWikiStatus),
  );
  return status;
}

async function runWikiDoctor(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
  json?: boolean;
}) {
  const routeThroughGateway = shouldRouteBridgeRuntimeThroughGateway(params.config);
  const report = routeThroughGateway
    ? await callWikiGateway("wiki.doctor", params.agentId)
    : await (async () => {
        await syncMemoryWikiImportedSources({ config: params.config, appConfig: params.appConfig });
        return buildMemoryWikiDoctorReport(
          await resolveMemoryWikiStatus(params.config, {
            appConfig: params.appConfig,
          }),
        );
      })();
  if (!report.healthy) {
    process.exitCode = 1;
  }
  writeOutput(
    routeThroughGateway
      ? formatGatewayJsonOrText(report, params.json, renderMemoryWikiDoctor)
      : formatJsonOrText(report, params.json, renderMemoryWikiDoctor),
  );
  return report;
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
  return runWikiCommandWithSummary({
    json: params.json,
    run: () =>
      syncMemoryWikiImportedSources({
        config: params.config,
        appConfig: params.appConfig,
      }),
    render,
  });
}

function assertOfficialObsidianCliSupported(config: ResolvedMemoryWikiConfig) {
  if (config.vault.scope === "agent") {
    throw new Error("Official Obsidian CLI actions do not support memory-wiki vault.scope=agent.");
  }
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

  wiki
    .command("status")
    .description("Show wiki vault status")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { agentId, appConfig, config } = requireCommandContext();
      await runWikiStatus({ config, appConfig, agentId, json: opts.json });
    });

  wiki
    .command("doctor")
    .description("Audit wiki vault setup and report actionable fixes")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { agentId, appConfig, config } = requireCommandContext();
      await runWikiDoctor({ config, appConfig, agentId, json: opts.json });
    });

  wiki
    .command("init")
    .description("Initialize the wiki vault layout")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () => initializeMemoryWikiVault(config),
        render: (value) =>
          `Initialized wiki vault at ${value.rootDir} (${value.createdDirectories.length} dirs, ${value.createdFiles.length} files).`,
      });
    });

  wiki
    .command("compile")
    .description("Refresh generated wiki indexes")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { appConfig, config } = requireCommandContext();
      await runSyncedWikiCommandWithSummary({
        config,
        appConfig,
        json: opts.json,
        run: () => compileMemoryWikiVault(config),
        render: (value) =>
          `Compiled wiki vault at ${value.vaultRoot} (${value.pages.length} pages, ${value.updatedFiles.length} indexes updated).`,
      });
    });

  wiki
    .command("lint")
    .description("Lint the wiki vault and write a report")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { appConfig, config } = requireCommandContext();
      await runSyncedWikiCommandWithSummary({
        config,
        appConfig,
        json: opts.json,
        run: () => lintMemoryWikiVault(config),
        render: (value) =>
          `Linted wiki vault at ${value.vaultRoot} (${value.issueCount} issues, report: ${value.reportPath}).`,
      });
    });

  wiki
    .command("ingest")
    .description("Ingest a local file into the wiki sources folder")
    .argument("<path>", "Local file path to ingest")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--title <title>", "Override the source title")
    .option("--json", "Print JSON")
    .action(async (inputPath: string, opts: WikiIngestCommandOptions) => {
      const { config } = requireCommandContext();
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () =>
          ingestMemoryWikiSource({
            config,
            inputPath,
            title: opts.title,
          }),
        render: (value) =>
          `Ingested ${value.sourcePath} into ${value.pagePath}. Refreshed ${value.indexUpdatedFiles.length} index file${value.indexUpdatedFiles.length === 1 ? "" : "s"}.`,
      });
    });

  const okf = wiki.command("okf").description("Import Open Knowledge Format bundles");
  okf
    .command("import")
    .description("Import an unpacked OKF bundle into wiki concept pages")
    .argument("<path>", "OKF bundle directory")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Print JSON")
    .action(async (bundlePath: string, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () =>
          importMemoryWikiOkfBundle({
            config,
            bundlePath,
          }),
        render: formatOkfImportSummary,
      });
    });

  addWikiSearchConfigOptions(
    wiki
      .command("search")
      .description("Search wiki pages and, when configured, the active memory corpus")
      .argument("<query>", "Search query")
      .option("--agent <id>", "Agent id (default: configured default agent)")
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
    wiki
      .command("get")
      .description("Read a wiki page by id or relative path, with optional active-memory fallback")
      .argument("<lookup>", "Relative path or page id")
      .option("--agent <id>", "Agent id (default: configured default agent)")
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
    apply
      .command("synthesis")
      .description("Create or refresh a synthesis page with managed summary content")
      .argument("<title>", "Synthesis title")
      .option("--agent <id>", "Agent id (default: configured default agent)")
      .option("--body <text>", "Summary body text")
      .option("--body-file <path>", "Read summary body text from a file"),
  )
    .option("--json", "Print JSON")
    .action(async (title: string, opts: WikiApplySynthesisCommandOptions) => {
      const { appConfig, config } = requireCommandContext();
      const sourceIds = normalizeCliStringList(opts.sourceId);
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
          sourceIds,
          ...(normalizeCliStringList(opts.contradiction)
            ? { contradictions: normalizeCliStringList(opts.contradiction) }
            : {}),
          ...(normalizeCliStringList(opts.question)
            ? { questions: normalizeCliStringList(opts.question) }
            : {}),
          ...(typeof opts.confidence === "number" ? { confidence: opts.confidence } : {}),
          ...(opts.status?.trim() ? { status: opts.status.trim() } : {}),
        },
      });
      writeOutput(formatJsonOrText(result, opts.json, renderWikiMutationSummary));
    });
  addWikiApplyMutationOptions(
    apply
      .command("metadata")
      .description("Update metadata on an existing page")
      .argument("<lookup>", "Relative path or page id")
      .option("--agent <id>", "Agent id (default: configured default agent)"),
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
          ...(normalizeCliStringList(opts.sourceId)
            ? { sourceIds: normalizeCliStringList(opts.sourceId) }
            : {}),
          ...(normalizeCliStringList(opts.contradiction)
            ? { contradictions: normalizeCliStringList(opts.contradiction) }
            : {}),
          ...(normalizeCliStringList(opts.question)
            ? { questions: normalizeCliStringList(opts.question) }
            : {}),
          ...(opts.clearConfidence
            ? { confidence: null }
            : typeof opts.confidence === "number"
              ? { confidence: opts.confidence }
              : {}),
          ...(opts.status?.trim() ? { status: opts.status.trim() } : {}),
        },
      });
      writeOutput(formatJsonOrText(result, opts.json, renderWikiMutationSummary));
    });

  const bridge = wiki
    .command("bridge")
    .description("Import public memory artifacts into the wiki vault");
  bridge
    .command("import")
    .description("Sync bridge-backed memory artifacts into wiki source pages")
    .option("--agent <id>", "Agent id (default: configured default agent)")
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
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () =>
          syncMemoryWikiImportedSources({
            config,
            appConfig,
          }),
        render: (value) =>
          `Unsafe-local import synced ${value.artifactCount} artifacts (${value.importedCount} new, ${value.updatedCount} updated, ${value.skippedCount} unchanged, ${value.removedCount} removed). Indexes ${value.indexesRefreshed ? `refreshed (${value.indexUpdatedFiles.length} files)` : `not refreshed (${value.indexRefreshReason})`}.`,
      });
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
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () =>
          importChatGptConversations({
            config,
            exportPath: opts.export!,
            dryRun: opts.dryRun,
          }),
        render: formatChatGptImportSummary,
      });
    });
  chatgpt
    .command("rollback")
    .description("Roll back a previously applied ChatGPT import run")
    .argument("<run-id>", "Import run id")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Print JSON")
    .action(async (runId: string, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () =>
          rollbackChatGptImportRun({
            config,
            runId,
          }),
        render: formatChatGptRollbackSummary,
      });
    });

  const obsidian = wiki.command("obsidian").description("Run official Obsidian CLI helpers");
  obsidian
    .command("status")
    .description("Probe the Obsidian CLI")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      requireCommandContext();
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () => probeObsidianCli(),
        render: (value) =>
          value.available
            ? `Obsidian CLI available at ${value.command}`
            : "Obsidian CLI is not available on PATH.",
      });
    });
  obsidian
    .command("search")
    .description("Search the current Obsidian vault")
    .argument("<query>", "Search query")
    .option("--json", "Print JSON")
    .action(async (query: string, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      assertOfficialObsidianCliSupported(config);
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () => runObsidianSearch({ config, query }),
        render: (value) => value.stdout.trim(),
      });
    });
  obsidian
    .command("open")
    .description("Open a file in Obsidian by vault-relative path")
    .argument("<path>", "Vault-relative path")
    .option("--json", "Print JSON")
    .action(async (vaultPath: string, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      assertOfficialObsidianCliSupported(config);
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () => runObsidianOpen({ config, vaultPath }),
        render: (value) => value.stdout.trim() || "Opened in Obsidian.",
      });
    });
  obsidian
    .command("command")
    .description("Execute an Obsidian command palette command by id")
    .argument("<id>", "Obsidian command id")
    .option("--json", "Print JSON")
    .action(async (id: string, opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      assertOfficialObsidianCliSupported(config);
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () => runObsidianCommand({ config, id }),
        render: (value) => value.stdout.trim() || "Command sent to Obsidian.",
      });
    });
  obsidian
    .command("daily")
    .description("Open today's daily note in Obsidian")
    .option("--json", "Print JSON")
    .action(async (opts: WikiJsonOptions) => {
      const { config } = requireCommandContext();
      assertOfficialObsidianCliSupported(config);
      await runWikiCommandWithSummary({
        json: opts.json,
        run: () => runObsidianDaily({ config }),
        render: (value) => value.stdout.trim() || "Opened today's daily note.",
      });
    });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
