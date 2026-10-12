import type { Command } from "commander";
import { inheritOptionFromParent } from "openclaw/plugin-sdk/cli-runtime";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";

function resolveTargetId(rawTargetId: unknown, command: Command): string | undefined {
  return (
    normalizeOptionalString(rawTargetId) ??
    normalizeOptionalString(inheritOptionFromParent<string>(command, "targetId"))
  );
}

export function registerBrowserCookiesAndStorageCommands(
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
          defaultRuntime.error(danger("Missing required --url option for cookies set"));
          defaultRuntime.exit(1);
          return;
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
}
