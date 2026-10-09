import type { Command } from "commander";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { registerBrowserResizeCommand } from "./browser-cli-resize.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  callBrowserRequest,
  printBrowserJsonResult,
  runBrowserCliCommand as runBrowserCommand,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";
import { registerBrowserCookiesAndStorageCommands } from "./browser-cli-state.cookies-storage.js";

function parseFiniteNumberOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined) {
    defaultRuntime.error(danger(`Invalid ${label}: must be a finite number`));
    defaultRuntime.exit(1);
    return undefined;
  }
  return parsed;
}

export function registerBrowserStateCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  registerBrowserCookiesAndStorageCommands(browser, parentOpts);

  const set = browser.command("set").description("Browser environment settings");

  registerBrowserResizeCommand(
    set.command("viewport").description("Set viewport size (alias for resize)"),
    parentOpts,
    true,
  );

  const registerParsedSetting = (kind: "offline" | "media") => {
    const offline = kind === "offline";
    const choices = offline ? "on|off" : "dark|light|no-preference|none";
    set
      .command(kind)
      .description(offline ? "Toggle offline mode" : "Emulate prefers-color-scheme")
      .argument(`<${choices}>`, choices.replaceAll("|", "/"))
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (value: string, opts, cmd) => {
        const parent = parentOpts(cmd);
        const parsed = offline ? parseBooleanValue(value) : normalizeOptionalLowercaseString(value);
        if (
          parsed === undefined ||
          (typeof parsed === "string" && !choices.split("|").includes(parsed))
        ) {
          defaultRuntime.error(danger(`Expected ${choices}`));
          defaultRuntime.exit(1);
          return;
        }
        await runBrowserCliRequest({
          parent,
          path: `/set/${kind}`,
          body: {
            [offline ? "offline" : "colorScheme"]: parsed,
            targetId: normalizeOptionalString(opts.targetId),
          },
          successMessage: `${offline ? "offline" : "media colorScheme"}: ${parsed}`,
        });
      });
  };
  registerParsedSetting("offline");

  set
    .command("headers")
    .description("Set extra HTTP headers (JSON object)")
    .argument("[headersJson]", "JSON object of headers (alternative to --headers-json)")
    .option("--headers-json <json>", "JSON object of headers")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (headersJson: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        const headersJsonValue =
          normalizeOptionalString(opts.headersJson) ?? normalizeOptionalString(headersJson);
        if (!headersJsonValue) {
          throw new Error("Missing headers JSON (pass --headers-json or positional JSON argument)");
        }
        const parsed = JSON.parse(headersJsonValue) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Headers JSON must be a JSON object");
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") {
            headers[k] = v;
          }
        }
        const profile = parent?.browserProfile;
        const result = await callBrowserRequest(parent, {
          method: "POST",
          path: "/set/headers",
          query: profile ? { profile } : undefined,
          body: {
            headers,
            targetId: normalizeOptionalString(opts.targetId),
          },
        });
        if (printBrowserJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log("headers set");
      });
    });

  set
    .command("credentials")
    .description("Set HTTP basic auth credentials")
    .option("--clear", "Clear credentials", false)
    .argument("[username]", "Username")
    .argument("[password]", "Password")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (username: string | undefined, password: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCliRequest({
        parent,
        path: "/set/credentials",
        body: {
          username: normalizeOptionalString(username),
          password,
          clear: Boolean(opts.clear),
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: opts.clear ? "credentials cleared" : "credentials set",
      });
    });

  set
    .command("geo")
    .description("Set geolocation (and grant permission)")
    .option("--clear", "Clear geolocation + permissions", false)
    .argument("[latitude]", "Latitude")
    .argument("[longitude]", "Longitude")
    .option("--accuracy <m>", "Accuracy in meters")
    .option("--origin <origin>", "Origin to grant permissions for")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(
      async (latitudeRaw: string | undefined, longitudeRaw: string | undefined, opts, cmd) => {
        const parent = parentOpts(cmd);
        const latitude = parseFiniteNumberOption(latitudeRaw, "latitude");
        const longitude = parseFiniteNumberOption(longitudeRaw, "longitude");
        const accuracy = parseFiniteNumberOption(opts.accuracy, "--accuracy");
        if (
          (latitudeRaw !== undefined && latitude === undefined) ||
          (longitudeRaw !== undefined && longitude === undefined) ||
          (opts.accuracy !== undefined && accuracy === undefined)
        ) {
          return;
        }
        await runBrowserCliRequest({
          parent,
          path: "/set/geolocation",
          body: {
            latitude,
            longitude,
            accuracy,
            origin: normalizeOptionalString(opts.origin),
            clear: Boolean(opts.clear),
            targetId: normalizeOptionalString(opts.targetId),
          },
          successMessage: opts.clear ? "geolocation cleared" : "geolocation set",
        });
      },
    );

  registerParsedSetting("media");

  for (const [command, description, parameter, argumentHelp] of [
    ["timezone", "Override timezone (CDP)", "timezoneId", "Timezone ID (e.g. America/New_York)"],
    ["locale", "Override locale (CDP)", "locale", "Locale (e.g. en-US)"],
    [
      "device",
      'Apply a Playwright device descriptor (e.g. "iPhone 14")',
      "name",
      "Device name (Playwright devices)",
    ],
  ] as const) {
    set
      .command(command)
      .description(description)
      .argument(`<${parameter}>`, argumentHelp)
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (value: string, opts, cmd) => {
        await runBrowserCliRequest({
          parent: parentOpts(cmd),
          path: `/set/${command}`,
          body: {
            [parameter]: value,
            targetId: normalizeOptionalString(opts.targetId),
          },
          successMessage: `${command}: ${value}`,
        });
      });
  }
}
