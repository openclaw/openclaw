import type { Command } from "commander";
import { inheritOptionFromParent } from "openclaw/plugin-sdk/cli-runtime";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import {
  filterStringRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  parseBooleanValue,
  readNonBlankString,
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

function resolveTargetId(rawTargetId: unknown, command: Command): string | undefined {
  return (
    normalizeOptionalString(rawTargetId) ??
    normalizeOptionalString(inheritOptionFromParent<string>(command, "targetId"))
  );
}

function parseFiniteNumberOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined) {
    throw new Error(`Invalid ${label}: must be a finite number`);
  }
  return parsed;
}

export function registerBrowserStateCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const cookies = browser.command("cookies").description("Read/write cookies");
  const storage = browser.command("storage").description("Read/write localStorage/sessionStorage");

  for (const kind of ["cookies", "local", "session"] as const) {
    const isCookies = kind === "cookies";
    const cmd = isCookies ? cookies : storage.command(kind).description(`${kind}Storage commands`);
    const route = isCookies ? "/cookies" : `/storage/${kind}`;
    const label = isCookies ? "cookie" : `${kind}Storage`;
    const read = async (key: string | undefined, opts: { targetId?: string }, command: Command) => {
      const parent = parentOpts(command);
      const targetId = resolveTargetId(opts.targetId, command);
      await runBrowserCliRequest<{ cookies?: unknown[]; values?: Record<string, string> }>({
        parent,
        method: "GET",
        path: route,
        query: isCookies ? { targetId } : { key: readNonBlankString(key), targetId },
        errorPolicy: "inline",
        print: (result) =>
          defaultRuntime.writeJson(isCookies ? (result.cookies ?? []) : (result.values ?? {})),
      });
    };
    if (isCookies) {
      cmd
        .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
        .action((opts, command) => read(undefined, opts, command));
    } else {
      cmd
        .command("get")
        .description(`Get ${kind}Storage (all keys or one key)`)
        .argument("[key]", "Key (optional)")
        .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
        .action(read);
    }

    const set = cmd
      .command("set")
      .description(
        isCookies ? "Set a cookie (requires --url or domain+path)" : `Set a ${kind}Storage key`,
      )
      .argument(isCookies ? "<name>" : "<key>", isCookies ? "Cookie name" : "Key")
      .argument("<value>", isCookies ? "Cookie value" : "Value");
    if (isCookies) {
      set.option("--url <url>", "Cookie URL scope (recommended)");
    }
    set
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (key: string, value: string, opts, command) => {
        const parent = parentOpts(command);
        const targetId = resolveTargetId(opts.targetId, command);
        const url = isCookies ? normalizeOptionalString(opts.url) : undefined;
        if (isCookies && !url) {
          throw new Error("Missing required --url option for cookies set");
        }
        await runBrowserCliRequest({
          parent,
          path: `${route}/set`,
          body: isCookies
            ? { targetId, cookie: { name: key, value, url } }
            : { key, value, targetId },
          errorPolicy: "inline",
          successMessage: `${label} set: ${key}`,
        });
      });

    cmd
      .command("clear")
      .description(isCookies ? "Clear all cookies" : `Clear all ${kind}Storage keys`)
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (opts, command) => {
        const parent = parentOpts(command);
        const targetId = resolveTargetId(opts.targetId, command);
        await runBrowserCliRequest({
          parent,
          path: `${route}/clear`,
          body: { targetId },
          errorPolicy: "inline",
          successMessage: `${isCookies ? "cookies" : label} cleared`,
        });
      });
  }

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
          throw new Error(`Expected ${choices}`);
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
        const headers = filterStringRecord(parsed) ?? {};
        Reflect.deleteProperty(headers, "__proto__");
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
