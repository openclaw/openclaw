/**
 * `openclaw browser extension` CLI: locate the unpacked Chrome extension and
 * print the pairing string that connects it to this install's relay.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import {
  danger,
  defaultRuntime,
  getRuntimeConfig,
  info,
  resolveBrowserConfig,
  runCommandWithRuntime,
  theme,
} from "./core-api.js";

/** Absolute path to the bundled unpacked Chrome extension directory. */
function resolveChromeExtensionDir(): string {
  // extensions/browser/dist/cli/ -> extensions/browser/chrome-extension
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "chrome-extension");
}

function firstExtensionProfile(): { name: string; relayPort: number } | null {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  for (const [name, profile] of Object.entries(resolved.profiles)) {
    if (profile.driver === "extension") {
      return { name, relayPort: profile.cdpPort ?? resolved.extensionRelayDefaultPort };
    }
  }
  return null;
}

function buildPairingString(): { pairing: string; relayPort: number } | { error: string } {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const token = resolved.extensionRelayToken;
  if (!token) {
    return {
      error:
        "No gateway auth configured yet. Start the gateway once (it generates gateway.auth.token) and retry.",
    };
  }
  const profile = firstExtensionProfile();
  const relayPort = profile?.relayPort ?? resolved.extensionRelayDefaultPort;
  return {
    pairing: `ws://127.0.0.1:${relayPort}/extension#${token}`,
    relayPort,
  };
}

/** Register `openclaw browser extension {path,pair}`. */
export function registerBrowserExtensionCommands(
  browser: Command,
  _parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const extension = browser
    .command("extension")
    .description("Chrome extension: print the load path and pairing string");

  extension
    .command("path")
    .description("Print the unpacked Chrome extension directory (Load unpacked)")
    .action(() => {
      defaultRuntime.log(resolveChromeExtensionDir());
    });

  extension
    .command("pair")
    .description("Print the pairing string to paste into the OpenClaw extension popup")
    .option("--json", "Print the pairing string as JSON")
    .action(async (opts) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const result = buildPairingString();
          if ("error" in result) {
            defaultRuntime.error(danger(result.error));
            defaultRuntime.exit(1);
            return;
          }
          if (opts.json === true) {
            defaultRuntime.log(
              JSON.stringify({ pairingString: result.pairing, relayPort: result.relayPort }),
            );
            return;
          }
          defaultRuntime.log(
            [
              info("1. Load the extension: chrome://extensions → Developer mode → Load unpacked →"),
              `   ${resolveChromeExtensionDir()}`,
              info("2. Open the OpenClaw popup and paste this pairing string:"),
              "",
              theme.heading(result.pairing),
              "",
              info("The token is derived from gateway auth; keep it private."),
            ].join("\n"),
          );
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });
}
