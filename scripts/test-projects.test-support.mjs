import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isChannelSurfaceTestFile } from "../vitest.channel-paths.mjs";
import { isProviderExtensionRoot } from "../vitest.extension-provider-paths.mjs";
import { isBoundaryTestFile, isBundledPluginDependentUnitTestFile } from "../vitest.unit-paths.mjs";

const DEFAULT_VITEST_CONFIG = "vitest.unit.config.ts";
const AGENTS_VITEST_CONFIG = "vitest.agents.config.ts";
const ACP_VITEST_CONFIG = "vitest.acp.config.ts";
const AUTO_REPLY_VITEST_CONFIG = "vitest.auto-reply.config.ts";
const BOUNDARY_VITEST_CONFIG = "vitest.boundary.config.ts";
const BUNDLED_VITEST_CONFIG = "vitest.bundled.config.ts";
const CHANNEL_VITEST_CONFIG = "vitest.channels.config.ts";
const COMMANDS_VITEST_CONFIG = "vitest.commands.config.ts";
const CONTRACTS_VITEST_CONFIG = "vitest.contracts.config.ts";
const E2E_VITEST_CONFIG = "vitest.e2e.config.ts";
const EXTENSION_CHANNELS_VITEST_CONFIG = "vitest.extension-channels.config.ts";
const EXTENSION_PROVIDERS_VITEST_CONFIG = "vitest.extension-providers.config.ts";
const EXTENSIONS_VITEST_CONFIG = "vitest.extensions.config.ts";
const GATEWAY_VITEST_CONFIG = "vitest.gateway.config.ts";
const INFRA_VITEST_CONFIG = "vitest.infra.config.ts";
const TOOLING_VITEST_CONFIG = "vitest.tooling.config.ts";
const UI_VITEST_CONFIG = "vitest.ui.config.ts";
const INCLUDE_FILE_ENV_KEY = "OPENCLAW_VITEST_INCLUDE_FILE";

function normalizePathPattern(value) {
  return value.replaceAll("\\", "/");
}

function isExistingPathTarget(arg, cwd) {
  return fs.existsSync(path.resolve(cwd, arg));
}

function isExistingFileTarget(arg, cwd) {
  try {
    return fs.statSync(path.resolve(cwd, arg)).isFile();
  } catch {
    return false;
  }
}

function isGlobTarget(arg) {
  return /[*?[\]{}]/u.test(arg);
}

function isFileLikeTarget(arg) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg);
}

function isPathLikeTargetArg(arg, cwd) {
  if (!arg || arg === "--" || arg.startsWith("-")) {
    return false;
  }
  return isExistingPathTarget(arg, cwd) || isGlobTarget(arg) || isFileLikeTarget(arg);
}

function toRepoRelativeTarget(arg, cwd) {
  if (isGlobTarget(arg)) {
    return normalizePathPattern(arg.replace(/^\.\//u, ""));
  }
  const absolute = path.resolve(cwd, arg);
  return normalizePathPattern(path.relative(cwd, absolute));
}

function toScopedIncludePattern(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  if (isGlobTarget(relative) || isFileLikeTarget(relative)) {
    return relative;
  }
  if (isExistingFileTarget(arg, cwd)) {
    const directory = normalizePathPattern(path.posix.dirname(relative));
    return directory === "." ? "**/*.test.ts" : `${directory}/**/*.test.ts`;
  }
  return `${relative.replace(/\/+$/u, "")}/**/*.test.ts`;
}

function classifyTarget(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  if (relative.endsWith(".e2e.test.ts")) {
    return "e2e";
  }
  if (relative.startsWith("extensions/")) {
    const extensionRoot = relative.split("/").slice(0, 2).join("/");
    if (isChannelSurfaceTestFile(relative)) {
      return "extensionChannel";
    }
    return isProviderExtensionRoot(extensionRoot) ? "extensionProvider" : "extension";
  }
  if (isChannelSurfaceTestFile(relative)) {
    return "channel";
  }
  if (isBoundaryTestFile(relative)) {
    return "boundary";
  }
  if (
    relative.startsWith("test/") ||
    relative.startsWith("src/scripts/") ||
    relative.startsWith("src/plugins/contracts/") ||
    relative.startsWith("src/channels/plugins/contracts/") ||
    relative === "src/config/doc-baseline.integration.test.ts" ||
    relative === "src/config/schema.base.generated.test.ts" ||
    relative === "src/config/schema.help.quality.test.ts"
  ) {
    return relative.startsWith("src/plugins/contracts/") ||
      relative.startsWith("src/channels/plugins/contracts/")
      ? "contracts"
      : "tooling";
  }
  if (isBundledPluginDependentUnitTestFile(relative)) {
    return "bundled";
  }
  if (relative.startsWith("src/gateway/")) {
    return "gateway";
  }
  if (relative.startsWith("src/infra/")) {
    return "infra";
  }
  if (relative.startsWith("src/acp/")) {
    return "acp";
  }
  if (relative.startsWith("src/commands/")) {
    return "command";
  }
  if (relative.startsWith("src/auto-reply/")) {
    return "autoReply";
  }
  if (relative.startsWith("src/agents/")) {
    return "agent";
  }
  if (relative.startsWith("ui/src/ui/")) {
    return "ui";
  }
  return "default";
}

function createVitestArgs(params) {
  return [
    "exec",
    "vitest",
    ...(params.watchMode ? [] : ["run"]),
    "--config",
    params.config,
    ...params.forwardedArgs,
  ];
}

export function parseTestProjectsArgs(args, cwd = process.cwd()) {
  const forwardedArgs = [];
  const targetArgs = [];
  let watchMode = false;

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--watch") {
      watchMode = true;
      continue;
    }
    if (isPathLikeTargetArg(arg, cwd)) {
      targetArgs.push(arg);
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, targetArgs, watchMode };
}

export function buildVitestRunPlans(args, cwd = process.cwd()) {
  const { forwardedArgs, targetArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  if (targetArgs.length === 0) {
    return [
      {
        config: DEFAULT_VITEST_CONFIG,
        forwardedArgs,
        includePatterns: null,
        watchMode,
      },
    ];
  }

  const groupedTargets = new Map();
  for (const targetArg of targetArgs) {
    const kind = classifyTarget(targetArg, cwd);
    const current = groupedTargets.get(kind) ?? [];
    current.push(targetArg);
    groupedTargets.set(kind, current);
  }

  if (watchMode && groupedTargets.size > 1) {
    throw new Error(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  }

  const nonTargetArgs = forwardedArgs.filter((arg) => !targetArgs.includes(arg));
  const orderedKinds = [
    "default",
    "boundary",
    "tooling",
    "contracts",
    "bundled",
    "gateway",
    "infra",
    "acp",
    "command",
    "autoReply",
    "agent",
    "ui",
    "e2e",
    "extensionChannel",
    "extensionProvider",
    "channel",
    "extension",
  ];
  const plans = [];
  for (const kind of orderedKinds) {
    const grouped = groupedTargets.get(kind);
    if (!grouped || grouped.length === 0) {
      continue;
    }
    const config =
      kind === "boundary"
        ? BOUNDARY_VITEST_CONFIG
        : kind === "tooling"
          ? TOOLING_VITEST_CONFIG
          : kind === "contracts"
            ? CONTRACTS_VITEST_CONFIG
            : kind === "bundled"
              ? BUNDLED_VITEST_CONFIG
              : kind === "gateway"
                ? GATEWAY_VITEST_CONFIG
                : kind === "infra"
                  ? INFRA_VITEST_CONFIG
                  : kind === "acp"
                    ? ACP_VITEST_CONFIG
                    : kind === "command"
                      ? COMMANDS_VITEST_CONFIG
                      : kind === "autoReply"
                        ? AUTO_REPLY_VITEST_CONFIG
                        : kind === "agent"
                          ? AGENTS_VITEST_CONFIG
                          : kind === "ui"
                            ? UI_VITEST_CONFIG
                            : kind === "e2e"
                              ? E2E_VITEST_CONFIG
                              : kind === "extensionChannel"
                                ? EXTENSION_CHANNELS_VITEST_CONFIG
                                : kind === "extensionProvider"
                                  ? EXTENSION_PROVIDERS_VITEST_CONFIG
                                  : kind === "channel"
                                    ? CHANNEL_VITEST_CONFIG
                                    : kind === "extension"
                                      ? EXTENSIONS_VITEST_CONFIG
                                      : DEFAULT_VITEST_CONFIG;
    const includePatterns =
      kind === "default" || kind === "e2e"
        ? null
        : grouped.map((targetArg) => toScopedIncludePattern(targetArg, cwd));
    const scopedTargetArgs = kind === "default" || kind === "e2e" ? grouped : [];
    plans.push({
      config,
      forwardedArgs: [...nonTargetArgs, ...scopedTargetArgs],
      includePatterns,
      watchMode,
    });
  }
  return plans;
}

export function createVitestRunSpecs(args, params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const plans = buildVitestRunPlans(args, cwd);
  return plans.map((plan, index) => {
    const includeFilePath = plan.includePatterns
      ? path.join(
          params.tempDir ?? os.tmpdir(),
          `openclaw-vitest-include-${process.pid}-${Date.now()}-${index}.json`,
        )
      : null;
    return {
      config: plan.config,
      env: includeFilePath
        ? {
            ...(params.baseEnv ?? process.env),
            [INCLUDE_FILE_ENV_KEY]: includeFilePath,
          }
        : (params.baseEnv ?? process.env),
      includeFilePath,
      includePatterns: plan.includePatterns,
      pnpmArgs: createVitestArgs(plan),
      watchMode: plan.watchMode,
    };
  });
}

export function writeVitestIncludeFile(filePath, includePatterns) {
  fs.writeFileSync(filePath, `${JSON.stringify(includePatterns, null, 2)}\n`);
}

export function buildVitestArgs(args, cwd = process.cwd()) {
  const [plan] = buildVitestRunPlans(args, cwd);
  if (!plan) {
    return createVitestArgs({
      config: DEFAULT_VITEST_CONFIG,
      forwardedArgs: [],
      watchMode: false,
    });
  }
  return createVitestArgs(plan);
}
