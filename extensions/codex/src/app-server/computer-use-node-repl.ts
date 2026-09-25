/** Process-local wiring for the Computer Use bridge shipped by the signed desktop app. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseToml } from "smol-toml";
import { defineCodexBuildState } from "../build-state.js";
import { resolveMacOSDesktopCodexAppPathCandidateForBundle } from "./desktop-app-paths.js";
import { normalizeCodexAppServerArgs, readCodexAppServerConfigOptions } from "./launch-args.js";

export const CODEX_COMPUTER_USE_NODE_REPL_SERVER = "node_repl";
export const CODEX_COMPUTER_USE_NODE_REPL_PROBE =
  '{ const { sky } = await import("@oai/sky"); const apps = await sky.list_apps(); nodeRepl.write(JSON.stringify({ appCount: Array.isArray(apps) ? apps.length : Object.keys(apps).length })); }';

type NativeBridgeOwnership = {
  appServerCommand: string;
  codexHome: string;
  launchArgs: readonly string[];
  command: string;
  env: Record<string, string>;
};

const bridgeOwnership = defineCodexBuildState("openclaw.codexComputerUseNodeReplOwnership", () => ({
  generatedArgs: new WeakMap<readonly string[], NativeBridgeOwnership>(),
  clients: new WeakMap<object, NativeBridgeOwnership>(),
}));

/** Binds only canonical, unchanged launch wiring to the process actually spawned. */
export function bindCodexComputerUseNodeReplClient(
  client: object,
  start: { transport?: string; command?: string; args?: string[]; env?: NodeJS.ProcessEnv },
): void {
  const owner = start.args && bridgeOwnership().generatedArgs.get(start.args);
  if (
    !owner ||
    start.transport !== "stdio" ||
    start.command !== owner.appServerCommand ||
    start.env?.CODEX_HOME !== owner.codexHome ||
    start.args?.length !== owner.launchArgs.length ||
    !owner.launchArgs.every((arg, index) => start.args?.[index] === arg)
  ) {
    return;
  }
  bridgeOwnership().clients.set(client, owner);
}

/** Launch identity survives config changes so an admitted bridge cannot become a custom route. */
export function isCodexComputerUseNodeReplClient(client: object | undefined): boolean {
  return Boolean(client && bridgeOwnership().clients.has(client));
}

/** Effective native configuration cannot replace the bridge after admission. */
export async function hasCodexComputerUseNodeReplOwnership(params: {
  client?: object;
  request: (
    method: "config/read",
    params: { includeLayers: false },
  ) => Promise<{ config?: unknown }>;
}): Promise<boolean> {
  const owner = params.client && bridgeOwnership().clients.get(params.client);
  if (!owner) {
    return false;
  }
  const response = await params.request("config/read", {
    includeLayers: false,
  });
  const servers = asOptionalRecord(asOptionalRecord(response.config)?.mcp_servers);
  const server = asOptionalRecord(servers?.[CODEX_COMPUTER_USE_NODE_REPL_SERVER]);
  const env = asOptionalRecord(server?.env);
  return Boolean(
    server &&
    server.command === owner.command &&
    Array.isArray(server.args) &&
    server.args.length === 0 &&
    server.enabled !== false &&
    (server.environment_id == null || server.environment_id === "local") &&
    server.url == null &&
    server.cwd == null &&
    (server.env_vars == null || (Array.isArray(server.env_vars) && server.env_vars.length === 0)) &&
    env &&
    Object.keys(env).length === Object.keys(owner.env).length &&
    Object.entries(owner.env).every(([key, value]) => env[key] === value),
  );
}

type ComputerUseNativeOwnershipParams = {
  appServerCommand: string;
  codexHome: string;
  args?: string[];
  codexConfigToml?: string;
  enabled?: boolean;
};

/** Refuses to certify an unrelated sanitized fixture for user-owned native wiring. */
export async function assertCodexDesktopComputerUseProbeSupported(
  params: ComputerUseNativeOwnershipParams,
): Promise<void> {
  const reason = await readComputerUseOwnershipFailure(params);
  if (reason) {
    throw new Error(
      `Selected native Computer Use cannot be updated automatically: ${reason}. Update and validate that integration explicitly.`,
    );
  }
}

/**
 * Mirrors the desktop app's node_repl MCP launch contract, without writing native
 * config or installing services. Explicit native MCP configuration remains owned
 * by its author. Call after any authorized service provisioning has completed.
 */
export async function resolveCodexComputerUseNodeReplStartArgs(
  params: ComputerUseNativeOwnershipParams & {
    serviceAppPath?: string;
    platform?: NodeJS.Platform;
  },
): Promise<string[]> {
  const args = params.args ?? ["app-server", "--listen", "stdio://"];
  if ((params.platform ?? process.platform) !== "darwin") {
    return args;
  }
  const resources = path.dirname(params.appServerCommand);
  const bundle = path.dirname(path.dirname(resources));
  if (
    path.basename(params.appServerCommand) !== "codex" ||
    path.basename(resources) !== "Resources" ||
    path.basename(path.dirname(resources)) !== "Contents" ||
    !["ChatGPT.app", "Codex.app"].includes(path.basename(bundle))
  ) {
    return args;
  }
  if (await readComputerUseOwnershipFailure(params)) {
    return args;
  }
  const bundledPlugin = path.join(resources, "plugins/openai-bundled/plugins/computer-use");
  if (await pathExists(path.join(bundledPlugin, ".mcp.json"))) {
    return args;
  }
  const skill = await fs
    .readFile(path.join(bundledPlugin, "skills/computer-use/SKILL.md"), "utf8")
    .catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return "";
      }
      throw error;
    });
  if (!skill.includes("node_repl") || !skill.includes("@oai/sky")) {
    return args;
  }
  const runtime = path.join(resources, "cua_node");
  const command = path.join(runtime, "bin/node_repl");
  const node = path.join(runtime, "bin/node");
  const modules = path.join(runtime, "lib/node_modules");
  const service =
    params.serviceAppPath ?? path.join(params.codexHome, "computer-use/Codex Computer Use.app");
  // Missing artifacts remain a readiness failure; autoInstall:false never gains
  // implicit writes or a fallback to a different desktop's service.
  if (
    !(await executableExists(command)) ||
    !(await executableExists(node)) ||
    !(await pathExists(path.join(modules, "@oai/sky/package.json"))) ||
    !(await pathExists(path.join(service, "Contents/Info.plist")))
  ) {
    return args;
  }
  const env = {
    CODEX_HOME: params.codexHome,
    CODEX_CLI_PATH: params.appServerCommand,
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    NODE_REPL_NODE_MODULE_DIRS: modules,
    NODE_REPL_NODE_PATH: node,
    NODE_REPL_TRUSTED_CODE_PATHS: [params.codexHome, modules].join(path.delimiter),
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
    SKY_CUA_SERVICE_PATH: service,
  };
  const envToml = Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",");
  // The native plugin registry relies on its managed marketplace wrapper. A
  // direct .app source override makes installed plugins appear uninstalled.
  // Authorized provisioning refreshes that wrapper before this process starts.
  const launchArgs = normalizeCodexAppServerArgs(
    args,
    `mcp_servers.${CODEX_COMPUTER_USE_NODE_REPL_SERVER}={command=${JSON.stringify(command)},args=[],startup_timeout_sec=120,env={${envToml}}}`,
  );
  bridgeOwnership().generatedArgs.set(launchArgs, {
    appServerCommand: params.appServerCommand,
    codexHome: params.codexHome,
    launchArgs: [...launchArgs],
    command,
    env,
  });
  return launchArgs;
}

async function readComputerUseOwnershipFailure(
  params: ComputerUseNativeOwnershipParams,
): Promise<string | undefined> {
  const configText =
    params.codexConfigToml ??
    (await fs
      .readFile(path.join(params.codexHome, "config.toml"), "utf8")
      .catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      }));
  const config = parseToml(configText);
  const plugin = asOptionalRecord(
    asOptionalRecord(config.plugins)?.["computer-use@openai-bundled"],
  );
  if (
    asOptionalRecord(config.features)?.plugins === false ||
    asOptionalRecord(config.features)?.computer_use === false ||
    plugin?.enabled === false
  ) {
    return "native Computer Use or plugin support is disabled";
  }
  if (!params.enabled && !plugin) {
    return "the official native Computer Use plugin is not enabled";
  }
  if (
    Object.hasOwn(asOptionalRecord(config.mcp_servers) ?? {}, CODEX_COMPUTER_USE_NODE_REPL_SERVER)
  ) {
    return "node_repl has explicit native MCP configuration";
  }
  // Native profiles and CLI overrides have higher authority than managed defaults.
  if (
    readCodexAppServerConfigOptions(params.args ?? []).some(
      (option) =>
        option.name === "-p" ||
        option.name === "--profile" ||
        /^(?:(?:mcp_servers|plugins|marketplaces)(?:\.|\s*=)|features(?:\s*=|\.(?:plugins|computer_use)\s*=))/u.test(
          (option.value ?? "").replace(/["']/gu, "").trim(),
        ),
    )
  ) {
    return "a native profile or explicit launch override owns the integration";
  }
  const marketplace = asOptionalRecord(asOptionalRecord(config.marketplaces)?.["openai-bundled"]);
  if (!marketplace) {
    return undefined;
  }
  if (marketplace.source_type !== "local" || typeof marketplace.source !== "string") {
    return "the native marketplace is not the selected desktop's local bundle";
  }
  const bundledPlugin = path.join(
    path.dirname(params.appServerCommand),
    "plugins/openai-bundled/plugins/computer-use",
  );
  const [configuredPlugin, selectedPlugin] = await Promise.all([
    fs.realpath(path.join(marketplace.source, "plugins/computer-use")).catch(() => undefined),
    fs.realpath(bundledPlugin).catch(() => undefined),
  ]);
  if (!configuredPlugin || !selectedPlugin) {
    return "the native marketplace is owned by another source";
  }
  if (configuredPlugin === selectedPlugin) {
    return undefined;
  }
  // Native-owned configuration may retain a previous immutable generation.
  // Validate that owner's receipt/path without rebinding its marketplace.
  const ownedWrapper = path.join(params.codexHome, ".tmp/bundled-marketplaces/openai-bundled");
  const pluginSuffix = path.join("Contents/Resources/plugins/openai-bundled/plugins/computer-use");
  if (
    path.resolve(marketplace.source) !== path.resolve(ownedWrapper) ||
    !configuredPlugin.endsWith(`${path.sep}${pluginSuffix}`)
  ) {
    return "the native marketplace is owned by another source";
  }
  const priorBundle = configuredPlugin.slice(0, -(pluginSuffix.length + 1));
  const priorOwner = resolveMacOSDesktopCodexAppPathCandidateForBundle(priorBundle);
  if (!priorOwner) {
    return "the native marketplace does not reference an owned desktop generation";
  }
  return undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

async function executableExists(filePath: string): Promise<boolean> {
  return fs.access(filePath, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
