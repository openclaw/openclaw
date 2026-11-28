import { fileURLToPath } from "node:url";
import { resolveRuntimeDependencyEntrypointUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  hasNonEmptyString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import parseArgs from "yargs-parser";
import type {
  ChromeMcpOptionsInput,
  NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import { BrowserProfileUnavailableError } from "./errors.js";

const DEFAULT_CHROME_MCP_FEATURE_ARGS = [
  "--no-usage-statistics",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
];
const CHROME_MCP_USAGE_STATISTICS_FLAG_RE = /^--(?:no-)?usage-?statistics(?:=.*)?$/i;

export function normalizeChromeMcpOptions(
  input?: ChromeMcpOptionsInput,
): NormalizedChromeMcpProfileOptions {
  if (typeof input === "object" && input && "command" in input && "args" in input) {
    return input;
  }
  const options = input ?? {};
  const configuredCommand = normalizeOptionalString(options.mcpCommand);
  // Explicit npx has always selected OpenClaw's pinned server, including its package prefix.
  const customCommand = configuredCommand === "npx" ? undefined : configuredCommand;
  const extraArgs = Array.isArray(options.mcpArgs) ? options.mcpArgs.filter(hasNonEmptyString) : [];
  // Match Chrome MCP's Yargs grammar, including short groups and camel-case
  // aliases. Policy and direct CDP operations must use the endpoint it launches.
  const { argv, error } = parseArgs.detailed(extraArgs, {
    alias: { browserUrl: "u", wsEndpoint: "w" },
    string: ["browserUrl", "wsEndpoint", "userDataDir"],
    boolean: ["autoConnect"],
    configuration: { "strip-aliased": true, "strip-dashed": true },
  });
  const endpoint: unknown = argv.wsEndpoint ?? argv.browserUrl;
  if (
    error ||
    (argv.browserUrl !== undefined && argv.wsEndpoint !== undefined) ||
    (endpoint !== undefined && (typeof endpoint !== "string" || !URL.canParse(endpoint))) ||
    (argv.autoConnect !== undefined && typeof argv.autoConnect !== "boolean")
  ) {
    throw new BrowserProfileUnavailableError(
      "Chrome MCP endpoint arguments must select one valid browserUrl or wsEndpoint URL. Remove duplicate, conflicting, or empty endpoint arguments from mcpArgs.",
    );
  }
  if (
    typeof endpoint === "string" &&
    !(argv.wsEndpoint !== undefined ? /^wss?:$/ : /^https?:$/).test(new URL(endpoint).protocol)
  ) {
    throw new BrowserProfileUnavailableError(
      "Chrome MCP endpoint arguments require http(s) for browserUrl or ws(s) for wsEndpoint.",
    );
  }
  const overridesConnection = endpoint !== undefined || argv.autoConnect !== undefined;
  const browserUrl = overridesConnection
    ? typeof endpoint === "string"
      ? endpoint
      : undefined
    : normalizeOptionalString(options.cdpUrl);
  const userDataDir = normalizeOptionalString(options.userDataDir);
  const connectionArgs = overridesConnection
    ? []
    : browserUrl
      ? [/^wss?:\/\//i.test(browserUrl) ? "--wsEndpoint" : "--browserUrl", browserUrl]
      : ["--autoConnect"];
  const defaultFeatureArgs = extraArgs.some((arg) => CHROME_MCP_USAGE_STATISTICS_FLAG_RE.test(arg))
    ? DEFAULT_CHROME_MCP_FEATURE_ARGS.filter((arg) => arg !== "--no-usage-statistics")
    : DEFAULT_CHROME_MCP_FEATURE_ARGS;
  const commonArgs = [...connectionArgs, ...defaultFeatureArgs];
  const trailingArgs = [
    ...(!overridesConnection && !browserUrl && userDataDir && argv.userDataDir === undefined
      ? ["--userDataDir", userDataDir]
      : []),
    ...extraArgs,
  ];
  if (customCommand !== undefined) {
    return {
      command: customCommand,
      env: undefined,
      userDataDir,
      browserUrl,
      // Stable custom launchers may still need the opt-in flag; the pinned server enables it by default.
      args: [...commonArgs, "--experimental-page-id-routing", ...trailingArgs],
    };
  }
  return {
    // The pinned server runs on the Gateway's own runtime, Node or Bun.
    command: process.execPath,
    // Its update check shells out to npm, which Bun-only installs lack.
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
    userDataDir,
    browserUrl,
    args: [
      fileURLToPath(resolveRuntimeDependencyEntrypointUrl("chromeDevtoolsMcp", import.meta.url)),
      "--experimentalVision",
      ...commonArgs,
      ...trailingArgs,
    ],
  };
}

export function buildChromeMcpSessionCacheKey(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): string {
  return JSON.stringify([
    profileName,
    options.userDataDir ?? "",
    options.browserUrl ?? "",
    options.command,
    options.args,
  ]);
}
