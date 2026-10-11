/**
 * Prepares isolated Codex and Claude ACP wrapper commands for ACPX. The bridge
 * copies safe auth/config state into plugin-owned homes and redacts diagnostics.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { tryReadJson } from "@openclaw/fs-safe/json";
import { isRecord as isConfigRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlTableWithoutBigInt,
} from "smol-toml";
import {
  buildAdapterWrapperScript,
  RUN_CONFIGURED_COMMAND_SENTINEL,
} from "./adapter-wrapper-script.js";
import {
  CODEX_ACP_BIN,
  CODEX_ACP_PACKAGE,
  LEGACY_CODEX_ACP_PACKAGE,
  OPENCLAW_CODEX_CONFIG_ARG,
} from "./codex-adapter.js";
import {
  extractTrustedCodexProjectPaths,
  renderIsolatedCodexConfig,
} from "./codex-trust-config.js";
import { splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import { resolveAcpxPluginRoot } from "./config.js";
import type { ResolvedAcpxPluginConfig } from "./config.js";

const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_BIN = "claude-agent-acp";
const requireFromHere = createRequire(import.meta.url);

type PackageManifest = {
  name?: unknown;
  bin?: unknown;
  dependencies?: Record<string, unknown>;
};

function readSelfManifest(): PackageManifest {
  const manifestPath = path.join(resolveAcpxPluginRoot(import.meta.url), "package.json");
  return JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as PackageManifest;
}

function readManifestDependencyVersion(packageName: string): string {
  const version = readSelfManifest().dependencies?.[packageName];
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`Missing ${packageName} dependency version in @openclaw/acpx manifest`);
  }
  return version;
}

const CODEX_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CODEX_ACP_PACKAGE);
const CLAUDE_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CLAUDE_ACP_PACKAGE);

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function resolvePackageBinPath(
  packageJsonPath: string,
  manifest: PackageManifest,
  binName: string,
): string | undefined {
  const { bin } = manifest;
  const relativeBinPath =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object"
        ? (bin as Record<string, unknown>)[binName]
        : undefined;
  if (typeof relativeBinPath !== "string" || relativeBinPath.trim() === "") {
    return undefined;
  }
  return path.resolve(path.dirname(packageJsonPath), relativeBinPath);
}

async function resolveInstalledAcpPackageBinPath(
  packageName: string,
  binName: string,
): Promise<string | undefined> {
  try {
    const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
    const manifest = await tryReadJson<PackageManifest>(packageJsonPath);
    if (manifest?.name !== packageName) {
      return undefined;
    }
    const binPath = resolvePackageBinPath(packageJsonPath, manifest, binName);
    if (!binPath) {
      return undefined;
    }
    await fs.access(binPath);
    return binPath;
  } catch {
    return undefined;
  }
}

function buildCodexAcpWrapperScript(installedBinPath?: string): string {
  return buildAdapterWrapperScript({
    displayName: "Codex",
    packageSpec: `${CODEX_ACP_PACKAGE}@${CODEX_ACP_PACKAGE_VERSION}`,
    binName: CODEX_ACP_BIN,
    installedBinPath,
    stderrLogFileNamePrefix: "codex-acp-wrapper.stderr",
    openClawWrapperArgs: [OPENCLAW_CODEX_CONFIG_ARG],
    envSetup: `const codexHome = fileURLToPath(new URL("./codex-home/", import.meta.url));
const codexAuthPath = fileURLToPath(new URL("./codex-home/auth.json", import.meta.url));
const codexApiKey = (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || "").trim();
let shouldWriteCodexApiKeyAuth = false;
if (codexApiKey) {
  if (!existsSync(codexAuthPath)) {
    shouldWriteCodexApiKeyAuth = true;
  } else {
    try {
      const existingCodexAuth = JSON.parse(readFileSync(codexAuthPath, "utf8"));
      shouldWriteCodexApiKeyAuth =
        !existingCodexAuth ||
        typeof existingCodexAuth !== "object" ||
        typeof existingCodexAuth.OPENAI_API_KEY === "string";
    } catch {
      shouldWriteCodexApiKeyAuth = true;
    }
  }
}
if (shouldWriteCodexApiKeyAuth) {
  writeFileSync(
    codexAuthPath,
    JSON.stringify({
      OPENAI_API_KEY: codexApiKey,
      tokens: null,
      last_refresh: null,
    }) + "\\n",
    { mode: 0o600 },
  );
}
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
};`,
    envConfigSetup: `function isCodexConfigObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeCodexConfig(base, override) {
  const merged = Object.assign(Object.create(null), base);
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] =
      isCodexConfigObject(existing) && isCodexConfigObject(value)
        ? mergeCodexConfig(existing, value)
        : value;
  }
  return merged;
}

const openClawCodexConfigs = readOpenClawWrapperArgs(
  rawConfiguredArgs,
  ${JSON.stringify(OPENCLAW_CODEX_CONFIG_ARG)},
);
if (openClawCodexConfigs.length > 0) {
  let existingCodexConfig = {};
  if (typeof env.CODEX_CONFIG === "string" && env.CODEX_CONFIG.trim()) {
    try {
      const parsedCodexConfig = JSON.parse(env.CODEX_CONFIG);
      if (!parsedCodexConfig || typeof parsedCodexConfig !== "object" || Array.isArray(parsedCodexConfig)) {
        throw new Error("CODEX_CONFIG must be a JSON object");
      }
      existingCodexConfig = parsedCodexConfig;
    } catch {
      console.error("[openclaw] CODEX_CONFIG must be a valid JSON object");
      process.exitCode = 1;
      return;
    }
  }
  for (const openClawCodexConfig of openClawCodexConfigs) {
    try {
      const parsedOpenClawCodexConfig = JSON.parse(openClawCodexConfig);
      if (
        !parsedOpenClawCodexConfig ||
        typeof parsedOpenClawCodexConfig !== "object" ||
        Array.isArray(parsedOpenClawCodexConfig)
      ) {
        throw new Error("invalid OpenClaw Codex config");
      }
      existingCodexConfig = mergeCodexConfig(existingCodexConfig, parsedOpenClawCodexConfig);
    } catch {
      console.error("[openclaw] invalid generated Codex ACP startup config");
      process.exitCode = 1;
      return;
    }
  }
  env.CODEX_CONFIG = JSON.stringify(existingCodexConfig);
}`,
  });
}

function buildClaudeAcpWrapperScript(installedBinPath?: string): string {
  return buildAdapterWrapperScript({
    displayName: "Claude",
    // This package is patched in OpenClaw; fallback must not float to an unpatched newer release.
    packageSpec: `${CLAUDE_ACP_PACKAGE}@${CLAUDE_ACP_PACKAGE_VERSION}`,
    binName: CLAUDE_ACP_BIN,
    installedBinPath,
    envSetup: `const env = {
  ...process.env,
};`,
  });
}

async function readSourceCodexConfig(codexHome: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function prepareIsolatedCodexHome(params: {
  baseDir: string;
  workspaceDir: string;
}): Promise<string> {
  const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sourceConfig = await readSourceCodexConfig(sourceCodexHome);
  const trustedProjectPaths = [
    ...(sourceConfig ? extractTrustedCodexProjectPaths(sourceConfig) : []),
    params.workspaceDir,
  ];
  const codexHome = path.join(params.baseDir, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    renderIsolatedCodexConfig({
      sourceConfigToml: sourceConfig,
      projectPaths: trustedProjectPaths,
    }),
    "utf8",
  );
  return codexHome;
}

async function writeAdapterWrapper(
  baseDir: string,
  fileName: string,
  script: string,
): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  const wrapperPath = path.join(baseDir, fileName);
  await fs.writeFile(wrapperPath, script, {
    encoding: "utf8",
  });
  try {
    await fs.chmod(wrapperPath, 0o755);
  } catch {
    // The wrapper is invoked via `node wrapper.mjs`; executable mode is only a convenience.
  }
  return wrapperPath;
}

function buildWrapperCommand(wrapperPath: string, args: string[] = []): string[] {
  return [process.execPath, wrapperPath, ...args];
}

function isAcpPackageSpec(value: string, packageName: string): boolean {
  return new RegExp(`^${escapeRegExp(packageName)}(?:@.+)?$`, "i").test(value.trim());
}

function isAcpBinName(value: string, binName: string): boolean {
  const commandName = basename(value);
  return new RegExp(`^${escapeRegExp(binName)}(?:\\.exe|\\.[cm]?js)?$`, "i").test(commandName);
}

function isPackageRunnerCommand(value: string): boolean {
  return /^(?:npx|npm|pnpm|bunx)(?:\.cmd|\.exe)?$/i.test(basename(value));
}

function extractConfiguredAdapterArgs(params: {
  configuredCommand?: AcpxAgentCommand;
  packageName: string;
  binName: string;
}): string[] | undefined {
  const parts = splitCommandParts(params.configuredCommand ?? []);
  if (!parts.length) {
    return [];
  }

  const packageIndex = parts.findIndex((part) => isAcpPackageSpec(part, params.packageName));
  if (packageIndex >= 0) {
    if (!isPackageRunnerCommand(parts[0] ?? "")) {
      return undefined;
    }
    const afterPackage = parts.slice(packageIndex + 1);
    if (afterPackage[0] === "--" && isAcpBinName(afterPackage[1] ?? "", params.binName)) {
      return afterPackage.slice(2);
    }
    if (isAcpBinName(afterPackage[0] ?? "", params.binName)) {
      return afterPackage.slice(1);
    }
    return afterPackage[0] === "--" ? afterPackage.slice(1) : afterPackage;
  }

  if (isAcpBinName(parts[0] ?? "", params.binName)) {
    return parts.slice(1);
  }
  if (basename(parts[0] ?? "") === "node" && isAcpBinName(parts[1] ?? "", params.binName)) {
    return parts.slice(2);
  }

  return undefined;
}

function mergeConfigRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    const nextValue =
      isConfigRecord(existing) && isConfigRecord(value)
        ? mergeConfigRecords(existing, value)
        : value;
    Object.defineProperty(merged, key, {
      value: nextValue,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  return merged;
}

function parseLegacyCodexConfigAssignment(assignment: string): Record<string, unknown> {
  const separator = assignment.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Invalid legacy Codex ACP config override: ${assignment}`);
  }
  const rawKey = assignment.slice(0, separator).trim();
  const key = rawKey === "use_legacy_landlock" ? "features.use_legacy_landlock" : rawKey;
  const rawValue = assignment.slice(separator + 1).trim();
  try {
    return parseToml(`${key} = ${rawValue}`) as Record<string, unknown>;
  } catch {
    const literal = rawValue.replace(/^["']+|["']+$/g, "");
    return parseToml(`${key} = ${JSON.stringify(literal)}`) as Record<string, unknown>;
  }
}

type LegacyCodexArgsMigration = {
  config: Record<string, unknown>;
  forwardedArgs: string[];
  hadOverrides: boolean;
};

function migrateLegacyCodexArgs(args: string[]): LegacyCodexArgsMigration {
  let config: Record<string, unknown> = {};
  const forwardedArgs: string[] = [];
  let hadOverrides = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    let assignment: string | undefined;
    if (arg === "-c" || arg === "--config") {
      assignment = args[(index += 1)];
    } else if (arg.startsWith("--config=")) {
      assignment = arg.slice("--config=".length);
    } else if (arg.startsWith("-c=")) {
      assignment = arg.slice("-c=".length);
    } else if (arg.startsWith("-c") && arg.length > 2) {
      assignment = arg.slice(2);
    } else {
      forwardedArgs.push(arg);
      continue;
    }
    if (!assignment) {
      throw new Error(`Missing value for legacy Codex ACP option ${arg}`);
    }
    hadOverrides = true;
    config = mergeConfigRecords(config, parseLegacyCodexConfigAssignment(assignment));
  }
  return { config, forwardedArgs, hadOverrides };
}

type CodexAdapterLaunch = {
  args: string[];
  migratedConfig?: Record<string, unknown>;
};

function resolveCodexAdapterLaunch(
  configuredCommand?: AcpxAgentCommand,
): CodexAdapterLaunch | undefined {
  const legacyAdapterArgs = extractConfiguredAdapterArgs({
    configuredCommand,
    packageName: LEGACY_CODEX_ACP_PACKAGE,
    binName: CODEX_ACP_BIN,
  });
  if (legacyAdapterArgs) {
    const migration = migrateLegacyCodexArgs(legacyAdapterArgs);
    return {
      args: [
        ...(migration.hadOverrides
          ? [OPENCLAW_CODEX_CONFIG_ARG, JSON.stringify(migration.config)]
          : []),
        ...migration.forwardedArgs,
      ],
      ...(migration.hadOverrides ? { migratedConfig: migration.config } : {}),
    };
  }
  const maintainedAdapterArgs = extractConfiguredAdapterArgs({
    configuredCommand,
    packageName: CODEX_ACP_PACKAGE,
    binName: CODEX_ACP_BIN,
  });
  if (!maintainedAdapterArgs) {
    return undefined;
  }
  // The maintained adapter owns its CLI subcommands and forwarded Codex flags.
  // Only the Zed package and bare legacy forms reach the migration branch above.
  return { args: maintainedAdapterArgs };
}

async function persistMigratedCodexMcpConfig(params: {
  codexHome: string;
  migratedConfig: Record<string, unknown> | undefined;
}): Promise<void> {
  const mcpServers = params.migratedConfig?.mcp_servers;
  if (!isConfigRecord(mcpServers)) {
    return;
  }
  const configPath = path.join(params.codexHome, "config.toml");
  const current = parseToml(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  const merged = mergeConfigRecords(current, { mcp_servers: mcpServers });
  await fs.writeFile(configPath, stringifyToml(merged as TomlTableWithoutBigInt), "utf8");
}

function buildClaudeAcpWrapperCommand(
  wrapperPath: string,
  configuredCommand?: AcpxAgentCommand,
): AcpxAgentCommand {
  const configuredAdapterArgs = extractConfiguredAdapterArgs({
    configuredCommand,
    packageName: CLAUDE_ACP_PACKAGE,
    binName: CLAUDE_ACP_BIN,
  });
  if (configuredAdapterArgs) {
    return buildWrapperCommand(wrapperPath, configuredAdapterArgs);
  }
  return configuredCommand ?? buildWrapperCommand(wrapperPath);
}

/** Prepare ACPX agent commands and isolated auth homes for Codex/Claude adapters. */
export async function prepareAcpxCodexAuthConfig(params: {
  pluginConfig: ResolvedAcpxPluginConfig;
  stateDir: string;
  resolveInstalledCodexAcpBinPath?: () => Promise<string | undefined>;
  resolveInstalledClaudeAcpBinPath?: () => Promise<string | undefined>;
}): Promise<ResolvedAcpxPluginConfig> {
  const codexBaseDir = path.join(params.stateDir, "acpx");
  const configuredCodexCommand = params.pluginConfig.agents.codex;
  const configuredClaudeCommand = params.pluginConfig.agents.claude;
  const codexLaunch = resolveCodexAdapterLaunch(configuredCodexCommand);
  const codexHome = await prepareIsolatedCodexHome({
    baseDir: codexBaseDir,
    workspaceDir: params.pluginConfig.cwd,
  });
  await persistMigratedCodexMcpConfig({
    codexHome,
    migratedConfig: codexLaunch?.migratedConfig,
  });
  const installedCodexBinPath = await (params.resolveInstalledCodexAcpBinPath
    ? params.resolveInstalledCodexAcpBinPath()
    : resolveInstalledAcpPackageBinPath(CODEX_ACP_PACKAGE, CODEX_ACP_BIN));
  const installedClaudeBinPath = await (params.resolveInstalledClaudeAcpBinPath
    ? params.resolveInstalledClaudeAcpBinPath()
    : resolveInstalledAcpPackageBinPath(CLAUDE_ACP_PACKAGE, CLAUDE_ACP_BIN));
  const wrapperPath = await writeAdapterWrapper(
    codexBaseDir,
    "codex-acp-wrapper.mjs",
    buildCodexAcpWrapperScript(installedCodexBinPath),
  );
  const claudeWrapperPath = await writeAdapterWrapper(
    codexBaseDir,
    "claude-agent-acp-wrapper.mjs",
    buildClaudeAcpWrapperScript(installedClaudeBinPath),
  );

  return {
    ...params.pluginConfig,
    agents: {
      ...params.pluginConfig.agents,
      codex: buildWrapperCommand(
        wrapperPath,
        codexLaunch?.args ?? [
          RUN_CONFIGURED_COMMAND_SENTINEL,
          ...splitCommandParts(configuredCodexCommand ?? []),
        ],
      ),
      claude: buildClaudeAcpWrapperCommand(claudeWrapperPath, configuredClaudeCommand),
    },
  };
}
