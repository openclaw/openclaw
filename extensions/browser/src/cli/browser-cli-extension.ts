/**
 * `openclaw browser extension` CLI: register the Store and development extension
 * native bootstrap host, and retain advanced manual pairing.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command } from "commander";
import {
  resolveBrowserConfig,
  resolveFirstExtensionProfileName,
  resolveProfile,
} from "../browser/config.js";
import {
  FOUNDATION_CHROME_WEB_STORE_URL,
  NativeHostSetupContextError,
  normalizeExtensionInstallWaitMs,
  repairChromeExtensionNativeHosts,
  removeChromeStoreInstallRequests,
  resolveChromeExtensionLoadPath,
  resolveNativeHostPath,
  uninstallChromeExtensionNativeHosts,
} from "../browser/extension-install.js";
import { buildBrowserExtensionPairing } from "../browser/extension-pairing.js";
import {
  BROWSER_RELAY_AUTH_LABEL,
  BROWSER_RELAY_AUTH_VERSION,
  relayKeyIdFromHex,
} from "../browser/extension-relay/auth-v2-crypto.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
} from "../browser/extension-relay/auth-v2.js";
import { ensureExtensionRelayToken } from "../browser/extension-relay/relay-auth.js";
import {
  observeBrowserExtensionSetup,
  runBrowserExtensionSetup,
} from "../browser/extension-setup.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import {
  danger,
  defaultRuntime,
  getRuntimeConfig,
  info,
  runCommandWithRuntime,
  theme,
} from "./core-api.js";

/** Absolute path to the bundled unpacked Chrome extension directory. */
function resolveChromeExtensionDir(pluginRoot?: string): string {
  if (pluginRoot) {
    return path.join(pluginRoot, "chrome-extension");
  }
  // extensions/browser/dist/cli/ -> extensions/browser/chrome-extension
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "chrome-extension");
}

function resolveBrowserPluginRoot(pluginRoot?: string): string {
  return pluginRoot ?? path.resolve(resolveChromeExtensionDir(), "..");
}

async function buildPairingString(options: {
  gatewayUrl?: string;
  localGateway: boolean;
}): Promise<{
  pairing: string;
  relayPort: number;
  remote: boolean;
}> {
  const cfg = getRuntimeConfig();
  if (options.localGateway && options.gatewayUrl !== undefined) {
    throw new Error("--local-gateway cannot be combined with --gateway-url");
  }
  if (options.localGateway && cfg.gateway?.mode === "remote") {
    throw new Error("--local-gateway requires a local Gateway configuration");
  }
  const result = await buildBrowserExtensionPairing({
    cfg,
    gatewayUrl: options.gatewayUrl,
    localTransport: options.localGateway ? "gateway" : undefined,
  });
  return {
    pairing: result.pairingString,
    relayPort: result.relayPort,
    remote: result.topology === "direct-remote",
  };
}

type BrowserRelayCdpEndpoint = {
  browserUrl: string;
  wsEndpoint: string;
  auth: {
    label: typeof BROWSER_RELAY_AUTH_LABEL;
    version: typeof BROWSER_RELAY_AUTH_VERSION;
    keyId: string;
    challengeUrl: string;
    completeUrl: string;
    role: "cdp";
    transport: "connection";
    method: "SEQUENCE";
    resource: "/json/version -> /cdp";
    flow: "cdp";
  };
  headers?: { Authorization: string };
};

/** Resolve safe v2 metadata, with an explicit gated legacy credential escape hatch. */
async function buildCdpEndpoint(options: {
  legacyBearer: boolean;
}): Promise<BrowserRelayCdpEndpoint> {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const token = await ensureExtensionRelayToken();
  const profileName = resolveFirstExtensionProfileName(resolved);
  const profile = profileName ? resolveProfile(resolved, profileName) : null;
  const relayPort = profile?.cdpPort ?? resolved.extensionRelayDefaultPort;
  const browserUrl = `http://127.0.0.1:${relayPort}`;
  const metadata = {
    browserUrl,
    wsEndpoint: `ws://127.0.0.1:${relayPort}/cdp`,
    auth: {
      label: BROWSER_RELAY_AUTH_LABEL,
      version: BROWSER_RELAY_AUTH_VERSION,
      keyId: relayKeyIdFromHex(token),
      challengeUrl: new URL(BROWSER_RELAY_AUTH_CHALLENGE_PATH, browserUrl).toString(),
      completeUrl: new URL(BROWSER_RELAY_AUTH_COMPLETE_PATH, browserUrl).toString(),
      role: "cdp" as const,
      transport: "connection" as const,
      method: "SEQUENCE" as const,
      resource: "/json/version -> /cdp" as const,
      flow: "cdp" as const,
    },
  };
  if (!options.legacyBearer) {
    return metadata;
  }
  if (!resolved.extensionRelay.allowLegacyAuth) {
    throw new Error(
      "Legacy browser relay auth is disabled; remove --legacy-bearer and use Browser Relay Authentication v2.",
    );
  }
  return {
    ...metadata,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/** Register `openclaw browser extension` lifecycle and compatibility commands. */
export function registerBrowserExtensionCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
  pluginRoot?: string,
) {
  const extension = browser
    .command("extension")
    .description("Install and inspect the OpenClaw Chrome extension bootstrap");

  extension
    .command("native-host", { hidden: true })
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async () => {
      // The entry owns binary framing and origin validation. Never print CLI diagnostics here.
      try {
        const entry = await resolveNativeHostPath(resolveBrowserPluginRoot(pluginRoot));
        await import(pathToFileURL(entry).href);
      } catch {
        process.exitCode = 1;
      }
    });

  extension
    .command("setup")
    .description("Inspect, prepare, or verify automatic Chrome setup on this host")
    .option("--action <action>", "inspect, install, or verify", "inspect")
    .option("--native-host-executable <path>", "Local self-contained Windows bootstrap executable")
    .option("--browser-profile <name>", "Local extension profile")
    .option("--wait-ms <ms>", "Bounded Chrome discovery wait", "1000")
    .option("--json", "Print the redacted setup result")
    .action(async (opts, command) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          if (opts.action !== "inspect" && opts.action !== "install" && opts.action !== "verify") {
            throw new Error("--action must be inspect, install, or verify");
          }
          const result = await runBrowserExtensionSetup({
            action: opts.action,
            nativeHostExecutable: opts.nativeHostExecutable,
            bundledDir: resolveChromeExtensionDir(pluginRoot),
            pluginRoot: resolveBrowserPluginRoot(pluginRoot),
            cfg: getRuntimeConfig(),
            profile: opts.browserProfile ?? parentOpts(command).browserProfile,
            waitMs: normalizeExtensionInstallWaitMs(opts.waitMs),
          });
          if (opts.json || parentOpts(command).json) {
            defaultRuntime.writeJson(result);
          } else {
            defaultRuntime.log(
              `${result.target.hostname} · ${result.target.profile}: ${result.phase} (${result.reason}); next: ${result.nextAction}`,
            );
          }
        },
        (error: unknown) => {
          defaultRuntime.error(
            error instanceof NativeHostSetupContextError
              ? error.message
              : "Chrome setup could not finish. Check the action, local profile, and native host installation. If automatic Windows selection is unverified, repair the intended existing profile with --browser-profile <name> --action install.",
          );
          defaultRuntime.exit(1);
        },
      );
    });

  extension
    .command("path")
    .description("Print the unpacked Chrome extension directory (Load unpacked)")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        defaultRuntime.log(
          await resolveChromeExtensionLoadPath(resolveChromeExtensionDir(pluginRoot)),
        );
      });
    });

  extension
    .command("install")
    .description("Set up the Chrome extension and request supported Store installation")
    .option(
      "--browser-profile <name>",
      "Local extension profile; repair preserves an owned selector",
    )
    .option("--native-host-executable <path>", "Local self-contained Windows bootstrap executable")
    .option(
      "--no-store",
      "Prepare native bootstrap and development files without requesting Store installation",
    )
    .option("--json", "Print a machine-readable status report")
    .option(
      "--wait-ms <ms>",
      "How long to wait after pre-registration for Chrome to verify the extension",
      String(30_000),
    )
    .action(async (opts, command) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const json = opts.json === true || parentOpts(command).json === true;
          const waitMs = normalizeExtensionInstallWaitMs(opts.waitMs);
          const bundledDir = resolveChromeExtensionDir(pluginRoot);
          if (!json) {
            defaultRuntime.log(info("Preparing the OpenClaw Chrome extension…"));
          }
          const status = await observeBrowserExtensionSetup({
            action: "install",
            nativeHostExecutable: opts.nativeHostExecutable,
            bundledDir,
            pluginRoot: resolveBrowserPluginRoot(pluginRoot),
            waitMs,
            requestStoreInstall: opts.store !== false,
            profile: opts.browserProfile ?? parentOpts(command).browserProfile,
            onProgress: json ? undefined : (message) => defaultRuntime.log(info(message)),
          });
          if (json) {
            defaultRuntime.writeJson(status);
          } else {
            for (const issue of status.issues) {
              defaultRuntime.error(theme.warn(issue));
            }
            defaultRuntime.log(
              status.manualSetupRequired
                ? theme.warn(
                    status.platformSupport === "manual_required"
                      ? "Automatic native bootstrap is not supported on this platform; use Settings for manual pairing."
                      : status.storeInstallRequests.some((entry) => entry.state === "requested")
                        ? `Store installation requested. Enable OpenClaw in chrome://extensions and approve Chrome's prompt. If it has not appeared, restart Chrome when convenient or add it from ${FOUNDATION_CHROME_WEB_STORE_URL}. Run extension status to check setup again.`
                        : `Setup needs attention. Add OpenClaw from ${FOUNDATION_CHROME_WEB_STORE_URL} after native registration succeeds. For development, load the printed unpacked path. If the extension attempted setup before the native host existed, restart Chrome once.`,
                  )
                : info(
                    `Native host and extension identity verified for ${status.discovered.length + status.storeDiscovered.length} profile registration(s). Check the extension popup for Connected before using browser automation.`,
                  ),
            );
          }
          if (status.manualSetupRequired) {
            defaultRuntime.exit(1);
          }
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });

  extension
    .command("repair")
    .description("Inspect or repair existing native hosts without browser profile discovery")
    .option(
      "--from <entrypoint>",
      "Repair only registrations referencing this exact absolute entrypoint",
    )
    .option("--dry-run", "Inspect registered targets without changing files", false)
    .option("--json", "Print a machine-readable repair report")
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await repairChromeExtensionNativeHosts({
          bundledDir: resolveChromeExtensionDir(pluginRoot),
          pluginRoot: resolveBrowserPluginRoot(pluginRoot),
          fromNativeHostPath: opts.from,
          dryRun: opts.dryRun === true,
        });
        if (opts.json === true || parentOpts(command).json === true) {
          defaultRuntime.writeJson(result);
        } else {
          for (const message of [...result.changes, ...result.warnings]) {
            defaultRuntime.log(message);
          }
          defaultRuntime.log(
            `Registered native entries: ${result.retainedNativeHostPaths.join(", ") || "none"}`,
          );
        }
        if (result.manualRequired || !result.retentionSafe || result.warnings.length > 0) {
          defaultRuntime.exit(1);
        }
      });
    });

  extension
    .command("status")
    .description("Inspect extension copies, Chrome IDs, and native-host registrations")
    .option("--native-host-executable <path>", "Local self-contained Windows bootstrap executable")
    .option("--browser-profile <name>", "Local extension profile")
    .option("--json", "Print a machine-readable status report")
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const json = opts.json === true || parentOpts(command).json === true;
        const status = await observeBrowserExtensionSetup({
          action: "inspect",
          profile: opts.browserProfile ?? parentOpts(command).browserProfile,
          nativeHostExecutable: opts.nativeHostExecutable,
          pluginRoot: resolveBrowserPluginRoot(pluginRoot),
          bundledDir: resolveChromeExtensionDir(pluginRoot),
        });
        if (json) {
          defaultRuntime.writeJson(status);
          return;
        }
        defaultRuntime.log(
          [
            `Extension copy: ${status.installedCopy.owned ? "installed" : "bundled fallback"}`,
            `Store request:  ${status.storeInstallRequests.length > 0 ? status.storeInstallRequests.map((entry) => `${entry.browser}: ${entry.state ?? "unknown"}`).join(", ") : "use the Chrome Web Store"}`,
            `Store:          ${status.storeDiscovered.length > 0 ? status.storeDiscovered.map((entry) => `${entry.extensionId} (${entry.browser}/${entry.profile}; ${entry.enabled ? "enabled" : entry.awaitingApproval ? "awaiting approval" : "disabled"})`).join(", ") : "not detected"}`,
            `Development:    ${status.discovered.length > 0 ? status.discovered.map((entry) => `${entry.extensionId} (${entry.browser}/${entry.profile})`).join(", ") : "none detected"}`,
            `Load unpacked:  ${status.installedCopy.owned ? status.installedCopy.path : status.bundledPath}`,
            `Native hosts:   ${status.registrations.filter((entry) => entry.state === "owned").length} owned`,
            `Setup:          ${status.manualSetupRequired ? "manual action required" : "automatic bootstrap ready"}`,
          ].join("\n"),
        );
      });
    });

  extension
    .command("uninstall-store")
    .description(
      "Remove OpenClaw-owned Store install requests; Chrome may remove the extension on restart",
    )
    .option("--json", "Print a machine-readable removal report")
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        if (process.platform === "win32") {
          throw new Error(
            "Windows Store removal belongs to uninstall-host --remove-store; no standalone Store writer is available.",
          );
        }
        const result = await removeChromeStoreInstallRequests();
        if (opts.json === true || parentOpts(command).json === true) {
          defaultRuntime.writeJson(result);
        } else {
          defaultRuntime.log(
            info(
              `Removed ${result.removed.length} owned Store install request(s). Chrome may remove externally installed copies on its next start. Native hosts are unchanged.`,
            ),
          );
          for (const refused of result.refused) {
            defaultRuntime.error(theme.warn(`Refused foreign Store registration: ${refused}`));
          }
        }
        if (result.refused.length > 0) {
          defaultRuntime.exit(1);
        }
      });
    });

  extension
    .command("uninstall-host")
    .description("Remove only OpenClaw-owned Chrome native-host registrations")
    .option("--native-host-executable <path>", "Local self-contained Windows bootstrap executable")
    .option("--browser-profile <name>", "Local extension profile")
    .option("--remove-store", "Remove owned Windows Store requests before native registration")
    .option("--json", "Print a machine-readable removal report")
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const json = opts.json === true || parentOpts(command).json === true;
        const result = await uninstallChromeExtensionNativeHosts({
          pluginRoot: resolveBrowserPluginRoot(pluginRoot),
          nativeHostExecutable: opts.nativeHostExecutable,
          browserProfile: opts.browserProfile ?? parentOpts(command).browserProfile,
          removeStore: opts.removeStore === true,
        });
        if (json) {
          defaultRuntime.writeJson(result);
          if (result.refused.length) {
            defaultRuntime.exit(1);
          }
          return;
        }
        defaultRuntime.log(
          result.manualRequired
            ? theme.warn("Windows native-host removal is manual; no registry key was changed.")
            : info(`Removed ${result.removed.length} owned native-host artifact(s).`),
        );
        for (const refused of result.refused) {
          defaultRuntime.error(theme.warn(`Refused registration removal: ${refused}`));
        }
        if (result.refused.length) {
          defaultRuntime.exit(1);
        }
      });
    });

  extension
    .command("pair")
    .description("Print an advanced manual pairing string")
    .option("--json", "Print the pairing string as JSON")
    .option("--local-gateway", "Pair through this host’s local Gateway for desktop native helpers")
    .option(
      "--gateway-url <url>",
      "Print a remote pairing string for a Chrome on another machine (e.g. wss://gateway.example.com)",
    )
    .action(async (opts, command) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const json = opts.json === true || parentOpts(command).json === true;
          const result = await buildPairingString({
            gatewayUrl: opts.gatewayUrl,
            localGateway: opts.localGateway === true,
          });
          if (json) {
            defaultRuntime.writeJson({
              pairingString: result.pairing,
              relayPort: result.relayPort,
              remote: result.remote,
            });
            return;
          }
          const setupLine = result.remote
            ? info(
                "Remote pairing: load and pair the extension on the machine running Chrome; it connects to this gateway over wss://.",
              )
            : info(
                "Run this on the machine that hosts the browser (gateway host or browser node).",
              );
          defaultRuntime.log(
            [
              setupLine,
              info("1. Load the extension: chrome://extensions → Developer mode → Load unpacked →"),
              `   ${resolveChromeExtensionDir(pluginRoot)}`,
              info("2. Open the OpenClaw popup and paste this pairing string:"),
              "",
              theme.heading(result.pairing),
              "",
              info("The relay key is a host-local secret; keep it private."),
            ].join("\n"),
          );
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });

  extension
    .command("cdp")
    .description("Print non-secret Browser Relay Authentication v2 CDP metadata")
    .option("--json", "Print the endpoint as JSON")
    .option(
      "--legacy-bearer",
      "Print the legacy Bearer header while browser.extensionRelay.allowLegacyAuth is enabled",
    )
    .action(async (opts, command) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const json = opts.json === true || parentOpts(command).json === true;
          const legacyBearer = opts.legacyBearer === true;
          const endpoint = await buildCdpEndpoint({ legacyBearer });
          if (legacyBearer) {
            defaultRuntime.error(
              theme.warn(
                "Warning: --legacy-bearer reveals the relay key in an authorization header. Migrate this client to Browser Relay Authentication v2.",
              ),
            );
          }
          if (json) {
            defaultRuntime.writeJson(endpoint);
            return;
          }
          const lines = [
            info("Relay CDP endpoint (pair the extension first):"),
            `browserUrl: ${endpoint.browserUrl}`,
            `wsEndpoint: ${endpoint.wsEndpoint}`,
            `auth:       ${endpoint.auth.label} v${endpoint.auth.version}`,
            `keyId:      ${endpoint.auth.keyId}`,
            `challenge:  POST ${endpoint.auth.challengeUrl}`,
            `complete:   POST ${endpoint.auth.completeUrl}`,
            `sequence:   ${endpoint.auth.resource}`,
          ];
          if (endpoint.headers) {
            lines.push(`legacy:     Authorization: ${endpoint.headers.Authorization}`);
          } else {
            lines.push("", info("No relay key or authorization header is printed."));
          }
          defaultRuntime.log(lines.join("\n"));
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });
}
