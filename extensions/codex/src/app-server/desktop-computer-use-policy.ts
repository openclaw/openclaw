/** Rejects explicitly owned Computer Use integrations before disposable candidate qualification. */
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseToml } from "smol-toml";
import {
  resolveMacOSDesktopCodexAppPathCandidateForBundle,
  resolveMacOSDesktopCodexAppBundlePath,
} from "./desktop-app-paths.js";
import { readCodexAppServerConfigOptions } from "./launch-args.js";

type ComputerUseNativeOwnershipParams = {
  appServerCommand: string;
  codexHome: string;
  args?: string[];
  enabled?: boolean;
  candidatePluginName?: string;
};

/** Native plugin configuration keeps its own layered precedence; no CLI MCP overrides are injected. */
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

async function readComputerUseOwnershipFailure(
  params: ComputerUseNativeOwnershipParams,
): Promise<string | undefined> {
  const configText = await fs
    .readFile(path.join(params.codexHome, "config.toml"), "utf8")
    .catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return "";
      }
      throw error;
    });
  const config = parseToml(configText);
  const plugins = asOptionalRecord(config.plugins);
  const plugin = asOptionalRecord(plugins?.["computer-use@openai-bundled"]);
  const candidatePlugin = asOptionalRecord(
    plugins?.[`${params.candidatePluginName ?? "computer-use"}@openai-bundled`],
  );
  if (
    asOptionalRecord(config.features)?.plugins === false ||
    asOptionalRecord(config.features)?.computer_use === false ||
    plugin?.enabled === false ||
    candidatePlugin?.enabled === false
  ) {
    return "native Computer Use or plugin support is disabled";
  }
  if (!params.enabled && !plugin && !candidatePlugin) {
    return "the official native Computer Use plugin is not enabled";
  }
  if (
    ["computer-use", "node_repl", "cua_repl"].some((name) =>
      Object.hasOwn(asOptionalRecord(config.mcp_servers) ?? {}, name),
    ) ||
    [plugin, candidatePlugin].some(
      (entry) => Object.keys(asOptionalRecord(entry?.mcp_servers) ?? {}).length > 0,
    )
  ) {
    return "Computer Use has explicit native MCP configuration";
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
  const bundle = resolveMacOSDesktopCodexAppBundlePath(params.appServerCommand);
  if (!bundle) {
    return "the selected runtime has no official desktop bundle";
  }
  const bundledPlugin = path.join(
    bundle,
    "Contents/Resources/plugins/openai-bundled/plugins/computer-use",
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

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
