/**
 * Browser CLI cookie and Web Storage commands.
 */
import type { Command } from "commander";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";
import { danger, defaultRuntime, inheritOptionFromParent } from "./core-api.js";

function resolveUrl(opts: { url?: string }): string | undefined {
  return normalizeOptionalString(opts.url);
}

function resolveTargetId(rawTargetId: unknown, command: Command): string | undefined {
  return (
    normalizeOptionalString(rawTargetId) ??
    normalizeOptionalString(inheritOptionFromParent<string>(command, "targetId"))
  );
}

/** Registers Browser cookies and storage subcommands. */
export function registerBrowserCookiesAndStorageCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const cookies = browser.command("cookies").description("Read/write cookies");

  cookies.option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP).action(async (opts, cmd) => {
    const parent = parentOpts(cmd);
    const targetId = resolveTargetId(opts.targetId, cmd);
    await runBrowserCliRequest<{ cookies?: unknown[] }>({
      parent,
      method: "GET",
      path: "/cookies",
      query: { targetId },
      errorPolicy: "inline",
      print: (result) => defaultRuntime.writeJson(result.cookies ?? []),
    });
  });

  cookies
    .command("set")
    .description("Set a cookie (requires --url or domain+path)")
    .argument("<name>", "Cookie name")
    .argument("<value>", "Cookie value")
    .option("--url <url>", "Cookie URL scope (recommended)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (name: string, value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const targetId = resolveTargetId(opts.targetId, cmd);
      const url = resolveUrl(opts);
      if (!url) {
        defaultRuntime.error(danger("Missing required --url option for cookies set"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCliRequest({
        parent,
        path: "/cookies/set",
        body: {
          targetId,
          cookie: { name, value, url },
        },
        errorPolicy: "inline",
        successMessage: `cookie set: ${name}`,
      });
    });

  cookies
    .command("clear")
    .description("Clear all cookies")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const targetId = resolveTargetId(opts.targetId, cmd);
      await runBrowserCliRequest({
        parent,
        path: "/cookies/clear",
        body: { targetId },
        errorPolicy: "inline",
        successMessage: "cookies cleared",
      });
    });

  const storage = browser.command("storage").description("Read/write localStorage/sessionStorage");

  function registerStorageKind(kind: "local" | "session") {
    const cmd = storage.command(kind).description(`${kind}Storage commands`);

    cmd
      .command("get")
      .description(`Get ${kind}Storage (all keys or one key)`)
      .argument("[key]", "Key (optional)")
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (key: string | undefined, opts, cmd2) => {
        const parent = parentOpts(cmd2);
        const targetId = resolveTargetId(opts.targetId, cmd2);
        await runBrowserCliRequest<{ values?: Record<string, string> }>({
          parent,
          method: "GET",
          path: `/storage/${kind}`,
          query: { key: readNonBlankString(key), targetId },
          errorPolicy: "inline",
          print: (result) => defaultRuntime.writeJson(result.values ?? {}),
        });
      });

    cmd
      .command("set")
      .description(`Set a ${kind}Storage key`)
      .argument("<key>", "Key")
      .argument("<value>", "Value")
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (key: string, value: string, opts, cmd2) => {
        const parent = parentOpts(cmd2);
        const targetId = resolveTargetId(opts.targetId, cmd2);
        await runBrowserCliRequest({
          parent,
          path: `/storage/${kind}/set`,
          body: { key, value, targetId },
          errorPolicy: "inline",
          successMessage: `${kind}Storage set: ${key}`,
        });
      });

    cmd
      .command("clear")
      .description(`Clear all ${kind}Storage keys`)
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (opts, cmd2) => {
        const parent = parentOpts(cmd2);
        const targetId = resolveTargetId(opts.targetId, cmd2);
        await runBrowserCliRequest({
          parent,
          path: `/storage/${kind}/clear`,
          body: { targetId },
          errorPolicy: "inline",
          successMessage: `${kind}Storage cleared`,
        });
      });
  }

  registerStorageKind("local");
  registerStorageKind("session");
}
