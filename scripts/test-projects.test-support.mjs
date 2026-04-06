import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isChannelSurfaceTestFile } from "../vitest.channel-paths.mjs";
import {
  isCommandsLightTarget,
  resolveCommandsLightIncludePattern,
} from "../vitest.commands-light-paths.mjs";
import { isAcpxExtensionRoot } from "../vitest.extension-acpx-paths.mjs";
import { isBlueBubblesExtensionRoot } from "../vitest.extension-bluebubbles-paths.mjs";
import { isDiffsExtensionRoot } from "../vitest.extension-diffs-paths.mjs";
import { isFeishuExtensionRoot } from "../vitest.extension-feishu-paths.mjs";
import { isIrcExtensionRoot } from "../vitest.extension-irc-paths.mjs";
import { isMatrixExtensionRoot } from "../vitest.extension-matrix-paths.mjs";
import { isMattermostExtensionRoot } from "../vitest.extension-mattermost-paths.mjs";
import { isMemoryExtensionRoot } from "../vitest.extension-memory-paths.mjs";
import { isMessagingExtensionRoot } from "../vitest.extension-messaging-paths.mjs";
import { isMsTeamsExtensionRoot } from "../vitest.extension-msteams-paths.mjs";
import { isProviderExtensionRoot } from "../vitest.extension-provider-paths.mjs";
import { isTelegramExtensionRoot } from "../vitest.extension-telegram-paths.mjs";
import { isVoiceCallExtensionRoot } from "../vitest.extension-voice-call-paths.mjs";
import { isWhatsAppExtensionRoot } from "../vitest.extension-whatsapp-paths.mjs";
import { isZaloExtensionRoot } from "../vitest.extension-zalo-paths.mjs";
import {
  isPluginSdkLightTarget,
  resolvePluginSdkLightIncludePattern,
} from "../vitest.plugin-sdk-paths.mjs";
import { isBoundaryTestFile, isBundledPluginDependentUnitTestFile } from "../vitest.unit-paths.mjs";
import { resolveVitestCliEntry, resolveVitestNodeArgs } from "./run-vitest.mjs";

const DEFAULT_VITEST_CONFIG = "vitest.unit.config.ts";
const AGENTS_VITEST_CONFIG = "vitest.agents.config.ts";
const ACP_VITEST_CONFIG = "vitest.acp.config.ts";
const AUTO_REPLY_VITEST_CONFIG = "vitest.auto-reply.config.ts";
const BOUNDARY_VITEST_CONFIG = "vitest.boundary.config.ts";
const BUNDLED_VITEST_CONFIG = "vitest.bundled.config.ts";
const CHANNEL_VITEST_CONFIG = "vitest.channels.config.ts";
const CLI_VITEST_CONFIG = "vitest.cli.config.ts";
const COMMANDS_LIGHT_VITEST_CONFIG = "vitest.commands-light.config.ts";
const COMMANDS_VITEST_CONFIG = "vitest.commands.config.ts";
const CONTRACTS_VITEST_CONFIG = "vitest.contracts.config.ts";
const CRON_VITEST_CONFIG = "vitest.cron.config.ts";
const DAEMON_VITEST_CONFIG = "vitest.daemon.config.ts";
const E2E_VITEST_CONFIG = "vitest.e2e.config.ts";
const EXTENSION_ACPX_VITEST_CONFIG = "vitest.extension-acpx.config.ts";
const EXTENSION_BLUEBUBBLES_VITEST_CONFIG = "vitest.extension-bluebubbles.config.ts";
const EXTENSION_CHANNELS_VITEST_CONFIG = "vitest.extension-channels.config.ts";
const EXTENSION_DIFFS_VITEST_CONFIG = "vitest.extension-diffs.config.ts";
const EXTENSION_FEISHU_VITEST_CONFIG = "vitest.extension-feishu.config.ts";
const EXTENSION_IRC_VITEST_CONFIG = "vitest.extension-irc.config.ts";
const EXTENSION_MATTERMOST_VITEST_CONFIG = "vitest.extension-mattermost.config.ts";
const EXTENSION_MATRIX_VITEST_CONFIG = "vitest.extension-matrix.config.ts";
const EXTENSION_MEMORY_VITEST_CONFIG = "vitest.extension-memory.config.ts";
const EXTENSION_MSTEAMS_VITEST_CONFIG = "vitest.extension-msteams.config.ts";
const EXTENSION_MESSAGING_VITEST_CONFIG = "vitest.extension-messaging.config.ts";
const EXTENSION_PROVIDERS_VITEST_CONFIG = "vitest.extension-providers.config.ts";
const EXTENSION_TELEGRAM_VITEST_CONFIG = "vitest.extension-telegram.config.ts";
const EXTENSION_VOICE_CALL_VITEST_CONFIG = "vitest.extension-voice-call.config.ts";
const EXTENSION_WHATSAPP_VITEST_CONFIG = "vitest.extension-whatsapp.config.ts";
const EXTENSION_ZALO_VITEST_CONFIG = "vitest.extension-zalo.config.ts";
const EXTENSIONS_VITEST_CONFIG = "vitest.extensions.config.ts";
const GATEWAY_VITEST_CONFIG = "vitest.gateway.config.ts";
const HOOKS_VITEST_CONFIG = "vitest.hooks.config.ts";
const INFRA_VITEST_CONFIG = "vitest.infra.config.ts";
const MEDIA_VITEST_CONFIG = "vitest.media.config.ts";
const MEDIA_UNDERSTANDING_VITEST_CONFIG = "vitest.media-understanding.config.ts";
const LOGGING_VITEST_CONFIG = "vitest.logging.config.ts";
const PLUGIN_SDK_LIGHT_VITEST_CONFIG = "vitest.plugin-sdk-light.config.ts";
const PLUGIN_SDK_VITEST_CONFIG = "vitest.plugin-sdk.config.ts";
const PLUGINS_VITEST_CONFIG = "vitest.plugins.config.ts";
const PROCESS_VITEST_CONFIG = "vitest.process.config.ts";
const RUNTIME_CONFIG_VITEST_CONFIG = "vitest.runtime-config.config.ts";
const SECRETS_VITEST_CONFIG = "vitest.secrets.config.ts";
const SHARED_CORE_VITEST_CONFIG = "vitest.shared-core.config.ts";
const TASKS_VITEST_CONFIG = "vitest.tasks.config.ts";
const TOOLING_VITEST_CONFIG = "vitest.tooling.config.ts";
const TUI_VITEST_CONFIG = "vitest.tui.config.ts";
const UI_VITEST_CONFIG = "vitest.ui.config.ts";
const UTILS_VITEST_CONFIG = "vitest.utils.config.ts";
const WIZARD_VITEST_CONFIG = "vitest.wizard.config.ts";
const INCLUDE_FILE_ENV_KEY = "OPENCLAW_VITEST_INCLUDE_FILE";
const CHANGED_ARGS_PATTERN = /^--changed(?:=(.+))?$/u;
const BROAD_CHANGED_RERUN_PATTERNS = [
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^test\/setup(?:\.shared|\.extensions|-openclaw-runtime)?\.ts$/u,
  /^vitest(?:\..+)?\.(?:config\.ts|paths\.mjs)$/u,
  /^scripts\/run-vitest\.mjs$/u,
  /^scripts\/test-projects(?:\.test-support)?\.mjs$/u,
];

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

function isLikelyFileTarget(arg) {
  return /(?:^|\/)[^/]+\.[A-Za-z0-9]+$/u.test(arg);
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
  if (isExistingFileTarget(arg, cwd) || isLikelyFileTarget(relative)) {
    const directory = normalizePathPattern(path.posix.dirname(relative));
    return directory === "." ? "**/*.test.ts" : `${directory}/**/*.test.ts`;
  }
  return `${relative.replace(/\/+$/u, "")}/**/*.test.ts`;
}

function listChangedPathsFromGit(baseRef, cwd) {
  return execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0);
}

function extractChangedBaseRef(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = arg.match(CHANGED_ARGS_PATTERN);
    if (!match) {
      continue;
    }
    if (match[1]) {
      return match[1];
    }
    const nextArg = args[index + 1];
    return nextArg && nextArg !== "--" && !nextArg.startsWith("-") ? nextArg : "HEAD";
  }
  return null;
}

function stripChangedArgs(args) {
  const strippedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = arg.match(CHANGED_ARGS_PATTERN);
    if (!match) {
      strippedArgs.push(arg);
      continue;
    }
    if (!match[1]) {
      const nextArg = args[index + 1];
      if (nextArg && nextArg !== "--" && !nextArg.startsWith("-")) {
        index += 1;
      }
    }
  }
  return strippedArgs;
}

function shouldKeepBroadChangedRun(changedPaths) {
  return changedPaths.some((changedPath) =>
    BROAD_CHANGED_RERUN_PATTERNS.some((pattern) => pattern.test(changedPath)),
  );
}

function isRoutableChangedTarget(changedPath) {
  return /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(changedPath);
}

export function resolveChangedTargetArgs(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
) {
  const baseRef = extractChangedBaseRef(args);
  if (!baseRef) {
    return null;
  }
  const changedPaths = listChangedPaths(baseRef, cwd);
  if (changedPaths.length === 0 || shouldKeepBroadChangedRun(changedPaths)) {
    return null;
  }
  const routablePaths = changedPaths.filter(isRoutableChangedTarget);
  return routablePaths.length > 0 ? [...new Set(routablePaths)] : null;
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
    if (isAcpxExtensionRoot(extensionRoot)) {
      return "extensionAcpx";
    }
    if (isDiffsExtensionRoot(extensionRoot)) {
      return "extensionDiffs";
    }
    if (isBlueBubblesExtensionRoot(extensionRoot)) {
      return "extensionBlueBubbles";
    }
    if (isFeishuExtensionRoot(extensionRoot)) {
      return "extensionFeishu";
    }
    if (isIrcExtensionRoot(extensionRoot)) {
      return "extensionIrc";
    }
    if (isMattermostExtensionRoot(extensionRoot)) {
      return "extensionMattermost";
    }
    if (isTelegramExtensionRoot(extensionRoot)) {
      return "extensionTelegram";
    }
    if (isVoiceCallExtensionRoot(extensionRoot)) {
      return "extensionVoiceCall";
    }
    if (isWhatsAppExtensionRoot(extensionRoot)) {
      return "extensionWhatsApp";
    }
    if (isZaloExtensionRoot(extensionRoot)) {
      return "extensionZalo";
    }
    if (isMatrixExtensionRoot(extensionRoot)) {
      return "extensionMatrix";
    }
    if (isMemoryExtensionRoot(extensionRoot)) {
      return "extensionMemory";
    }
    if (isMsTeamsExtensionRoot(extensionRoot)) {
      return "extensionMsTeams";
    }
    if (isMessagingExtensionRoot(extensionRoot)) {
      return "extensionMessaging";
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
  if (relative.startsWith("src/channels/")) {
    return "channel";
  }
  if (relative.startsWith("src/gateway/")) {
    return "gateway";
  }
  if (relative.startsWith("src/hooks/")) {
    return "hooks";
  }
  if (relative.startsWith("src/infra/")) {
    return "infra";
  }
  if (relative.startsWith("src/config/")) {
    return "runtimeConfig";
  }
  if (relative.startsWith("src/cron/")) {
    return "cron";
  }
  if (relative.startsWith("src/daemon/")) {
    return "daemon";
  }
  if (relative.startsWith("src/media-understanding/")) {
    return "mediaUnderstanding";
  }
  if (relative.startsWith("src/media/")) {
    return "media";
  }
  if (relative.startsWith("src/logging/")) {
    return "logging";
  }
  if (relative.startsWith("src/plugin-sdk/")) {
    return isPluginSdkLightTarget(relative) ? "pluginSdkLight" : "pluginSdk";
  }
  if (relative.startsWith("src/process/")) {
    return "process";
  }
  if (relative.startsWith("src/secrets/")) {
    return "secrets";
  }
  if (relative.startsWith("src/shared/")) {
    return "sharedCore";
  }
  if (relative.startsWith("src/tasks/")) {
    return "tasks";
  }
  if (relative.startsWith("src/tui/")) {
    return "tui";
  }
  if (relative.startsWith("src/acp/")) {
    return "acp";
  }
  if (relative.startsWith("src/cli/")) {
    return "cli";
  }
  if (relative.startsWith("src/commands/")) {
    return isCommandsLightTarget(relative) ? "commandLight" : "command";
  }
  if (relative.startsWith("src/auto-reply/")) {
    return "autoReply";
  }
  if (relative.startsWith("src/agents/")) {
    return "agent";
  }
  if (relative.startsWith("src/plugins/")) {
    return "plugin";
  }
  if (relative.startsWith("ui/src/ui/")) {
    return "ui";
  }
  if (relative.startsWith("src/utils/")) {
    return "utils";
  }
  if (relative.startsWith("src/wizard/")) {
    return "wizard";
  }
  return "default";
}

function resolveLightLaneIncludePatterns(kind, targetArg, cwd) {
  const relative = toRepoRelativeTarget(targetArg, cwd);
  if (kind === "pluginSdkLight") {
    const includePattern = resolvePluginSdkLightIncludePattern(relative);
    return includePattern ? [includePattern] : null;
  }
  if (kind === "commandLight") {
    const includePattern = resolveCommandsLightIncludePattern(relative);
    return includePattern ? [includePattern] : null;
  }
  return null;
}

function createVitestArgs(params) {
  return [
    "exec",
    "node",
    ...resolveVitestNodeArgs(params.env),
    resolveVitestCliEntry(),
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

export function buildVitestRunPlans(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
) {
  const { forwardedArgs, targetArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  const changedTargetArgs =
    targetArgs.length === 0 ? resolveChangedTargetArgs(args, cwd, listChangedPaths) : null;
  const activeTargetArgs = changedTargetArgs ?? targetArgs;
  const activeForwardedArgs = changedTargetArgs ? stripChangedArgs(forwardedArgs) : forwardedArgs;
  if (activeTargetArgs.length === 0) {
    return [
      {
        config: DEFAULT_VITEST_CONFIG,
        forwardedArgs: activeForwardedArgs,
        includePatterns: null,
        watchMode,
      },
    ];
  }

  const groupedTargets = new Map();
  for (const targetArg of activeTargetArgs) {
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

  const nonTargetArgs = activeForwardedArgs.filter((arg) => !activeTargetArgs.includes(arg));
  const orderedKinds = [
    "default",
    "boundary",
    "tooling",
    "contracts",
    "bundled",
    "gateway",
    "hooks",
    "infra",
    "runtimeConfig",
    "cron",
    "daemon",
    "media",
    "logging",
    "pluginSdkLight",
    "pluginSdk",
    "process",
    "secrets",
    "sharedCore",
    "tasks",
    "tui",
    "mediaUnderstanding",
    "acp",
    "cli",
    "commandLight",
    "command",
    "autoReply",
    "agent",
    "plugin",
    "ui",
    "utils",
    "wizard",
    "e2e",
    "extensionAcpx",
    "extensionDiffs",
    "extensionBlueBubbles",
    "extensionFeishu",
    "extensionIrc",
    "extensionMattermost",
    "extensionChannel",
    "extensionTelegram",
    "extensionVoiceCall",
    "extensionWhatsApp",
    "extensionZalo",
    "extensionMatrix",
    "extensionMemory",
    "extensionMsTeams",
    "extensionMessaging",
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
                : kind === "hooks"
                  ? HOOKS_VITEST_CONFIG
                  : kind === "infra"
                    ? INFRA_VITEST_CONFIG
                    : kind === "runtimeConfig"
                      ? RUNTIME_CONFIG_VITEST_CONFIG
                      : kind === "cron"
                        ? CRON_VITEST_CONFIG
                        : kind === "daemon"
                          ? DAEMON_VITEST_CONFIG
                          : kind === "media"
                            ? MEDIA_VITEST_CONFIG
                            : kind === "logging"
                              ? LOGGING_VITEST_CONFIG
                              : kind === "pluginSdkLight"
                                ? PLUGIN_SDK_LIGHT_VITEST_CONFIG
                                : kind === "pluginSdk"
                                  ? PLUGIN_SDK_VITEST_CONFIG
                                  : kind === "process"
                                    ? PROCESS_VITEST_CONFIG
                                    : kind === "secrets"
                                      ? SECRETS_VITEST_CONFIG
                                      : kind === "sharedCore"
                                        ? SHARED_CORE_VITEST_CONFIG
                                        : kind === "tasks"
                                          ? TASKS_VITEST_CONFIG
                                          : kind === "tui"
                                            ? TUI_VITEST_CONFIG
                                            : kind === "mediaUnderstanding"
                                              ? MEDIA_UNDERSTANDING_VITEST_CONFIG
                                              : kind === "acp"
                                                ? ACP_VITEST_CONFIG
                                                : kind === "cli"
                                                  ? CLI_VITEST_CONFIG
                                                  : kind === "commandLight"
                                                    ? COMMANDS_LIGHT_VITEST_CONFIG
                                                    : kind === "command"
                                                      ? COMMANDS_VITEST_CONFIG
                                                      : kind === "autoReply"
                                                        ? AUTO_REPLY_VITEST_CONFIG
                                                        : kind === "agent"
                                                          ? AGENTS_VITEST_CONFIG
                                                          : kind === "plugin"
                                                            ? PLUGINS_VITEST_CONFIG
                                                            : kind === "ui"
                                                              ? UI_VITEST_CONFIG
                                                              : kind === "utils"
                                                                ? UTILS_VITEST_CONFIG
                                                                : kind === "wizard"
                                                                  ? WIZARD_VITEST_CONFIG
                                                                  : kind === "e2e"
                                                                    ? E2E_VITEST_CONFIG
                                                                    : kind === "extensionAcpx"
                                                                      ? EXTENSION_ACPX_VITEST_CONFIG
                                                                      : kind === "extensionDiffs"
                                                                        ? EXTENSION_DIFFS_VITEST_CONFIG
                                                                        : kind ===
                                                                            "extensionBlueBubbles"
                                                                          ? EXTENSION_BLUEBUBBLES_VITEST_CONFIG
                                                                          : kind ===
                                                                              "extensionFeishu"
                                                                            ? EXTENSION_FEISHU_VITEST_CONFIG
                                                                            : kind ===
                                                                                "extensionIrc"
                                                                              ? EXTENSION_IRC_VITEST_CONFIG
                                                                              : kind ===
                                                                                  "extensionMattermost"
                                                                                ? EXTENSION_MATTERMOST_VITEST_CONFIG
                                                                                : kind ===
                                                                                    "extensionChannel"
                                                                                  ? EXTENSION_CHANNELS_VITEST_CONFIG
                                                                                  : kind ===
                                                                                      "extensionTelegram"
                                                                                    ? EXTENSION_TELEGRAM_VITEST_CONFIG
                                                                                    : kind ===
                                                                                        "extensionVoiceCall"
                                                                                      ? EXTENSION_VOICE_CALL_VITEST_CONFIG
                                                                                      : kind ===
                                                                                          "extensionWhatsApp"
                                                                                        ? EXTENSION_WHATSAPP_VITEST_CONFIG
                                                                                        : kind ===
                                                                                            "extensionZalo"
                                                                                          ? EXTENSION_ZALO_VITEST_CONFIG
                                                                                          : kind ===
                                                                                              "extensionMatrix"
                                                                                            ? EXTENSION_MATRIX_VITEST_CONFIG
                                                                                            : kind ===
                                                                                                "extensionMemory"
                                                                                              ? EXTENSION_MEMORY_VITEST_CONFIG
                                                                                              : kind ===
                                                                                                  "extensionMsTeams"
                                                                                                ? EXTENSION_MSTEAMS_VITEST_CONFIG
                                                                                                : kind ===
                                                                                                    "extensionMessaging"
                                                                                                  ? EXTENSION_MESSAGING_VITEST_CONFIG
                                                                                                  : kind ===
                                                                                                      "extensionProvider"
                                                                                                    ? EXTENSION_PROVIDERS_VITEST_CONFIG
                                                                                                    : kind ===
                                                                                                        "channel"
                                                                                                      ? CHANNEL_VITEST_CONFIG
                                                                                                      : kind ===
                                                                                                          "extension"
                                                                                                        ? EXTENSIONS_VITEST_CONFIG
                                                                                                        : DEFAULT_VITEST_CONFIG;
    const useCliTargetArgs =
      kind === "e2e" ||
      (kind === "default" &&
        grouped.every((targetArg) => isFileLikeTarget(toRepoRelativeTarget(targetArg, cwd))));
    const includePatterns = useCliTargetArgs
      ? null
      : grouped.flatMap((targetArg) => {
          const lightLanePatterns = resolveLightLaneIncludePatterns(kind, targetArg, cwd);
          return lightLanePatterns ?? [toScopedIncludePattern(targetArg, cwd)];
        });
    const scopedTargetArgs = useCliTargetArgs ? grouped : [];
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
