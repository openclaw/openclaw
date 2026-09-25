/**
 * Browser CLI observation commands for console, PDF, and response bodies.
 */
import type { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { shortenHomePath } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  BROWSER_TAB_REFERENCE_HELP,
  parseBrowserPositiveIntegerOption,
  runBrowserCliRequest,
  withBrowserActionTimeoutSlack,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";

const BROWSER_CONSOLE_LEVELS = ["error", "warn", "info"] as const;

function parseBrowserConsoleLevel(value: string): (typeof BROWSER_CONSOLE_LEVELS)[number] {
  const level = BROWSER_CONSOLE_LEVELS.find((candidate) => candidate === value);
  if (!level) {
    throw new Error(
      `--level must be ${BROWSER_CONSOLE_LEVELS.slice(0, -1).join(", ")}, or ${BROWSER_CONSOLE_LEVELS.at(-1)}.`,
    );
  }
  return level;
}

/** Registers Browser commands that observe current page state without direct input. */
export function registerBrowserActionObserveCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("console")
    .description("Get recent console messages")
    .option(
      "--level <level>",
      `Filter by level (${BROWSER_CONSOLE_LEVELS.join(", ")})`,
      parseBrowserConsoleLevel,
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      await runBrowserCliRequest<{ messages: unknown[] }>({
        parent: parentOpts(cmd),
        method: "GET",
        path: "/console",
        query: {
          level: normalizeOptionalString(opts.level),
          targetId: normalizeOptionalString(opts.targetId),
        },
        print: (result) => defaultRuntime.writeJson(result.messages),
      });
    });

  browser
    .command("pdf")
    .description("Save page as PDF")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      await runBrowserCliRequest<{ path: string }>({
        parent: parentOpts(cmd),
        path: "/pdf",
        body: { targetId: normalizeOptionalString(opts.targetId) },
        successMessage: (result) => `PDF: ${shortenHomePath(result.path)}`,
      });
    });

  browser
    .command("responsebody")
    .description("Wait for a network response and return its body")
    .argument("<url>", "URL (exact, substring, or glob like **/api)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the complete response body (default: 20000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .option("--max-chars <n>", "Max body chars to return (default: 200000)", (v: string) =>
      parseBrowserPositiveIntegerOption(v, "--max-chars"),
    )
    .action(async (url: string, opts, cmd) => {
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
      const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : undefined;
      await runBrowserCliRequest<{
        response: { body: string; truncated?: boolean };
      }>({
        parent: parentOpts(cmd),
        path: "/response/body",
        body: {
          url,
          targetId: normalizeOptionalString(opts.targetId),
          timeoutMs,
          maxChars,
        },
        timeoutMs: withBrowserActionTimeoutSlack(timeoutMs),
        print: (result) => {
          defaultRuntime.log(result.response.body);
          if (result.response.truncated === true) {
            defaultRuntime.error(
              "Warning: response body is a truncated prefix. Use --json to inspect response metadata.",
            );
          }
        },
      });
    });
}
