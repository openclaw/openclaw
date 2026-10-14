import type { Command } from "commander";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliCommand,
  parseBrowserNonNegativeIntegerOption,
  parseBrowserPositiveIntegerOption,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";
import { runBrowserAction, readFields } from "./shared.js";

function parseBrowserWaitLoadState(value: unknown) {
  const load = normalizeOptionalString(value);
  switch (load) {
    case undefined:
      return undefined;
    case "load":
    case "domcontentloaded":
    case "networkidle":
      return load;
    default:
      throw new Error(`Invalid --load value: ${load}`);
  }
}

export function registerBrowserFormWaitEvalCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("fill")
    .description("Fill a form with JSON field descriptors")
    .option("--fields <json>", "JSON array of field objects")
    .option("--fields-file <path>", "Read JSON array from a file")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCliCommand(async () => {
        const fields = await readFields({
          fields: opts.fields,
          fieldsFile: opts.fieldsFile,
        });
        await runBrowserAction({
          parent,
          body: {
            kind: "fill",
            fields,
            targetId: normalizeOptionalString(opts.targetId),
          },
          successMessage: `filled ${fields.length} field(s)`,
        });
      });
    });

  browser
    .command("wait")
    .description("Wait for time, selector, URL, load state, or JS conditions")
    .argument("[selector]", "CSS selector to wait for (visible)")
    .option("--time <ms>", "Wait for N milliseconds", (v: string) =>
      parseBrowserNonNegativeIntegerOption(v, "--time"),
    )
    .option("--text <value>", "Wait for text to appear")
    .option("--text-gone <value>", "Wait for text to disappear")
    .option("--url <pattern>", "Wait for URL (supports globs like **/dash)")
    .option("--load <load|domcontentloaded|networkidle>", "Wait for load state")
    .option("--fn <js>", "Wait for JS condition (passed to waitForFunction)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for each condition (default: 20000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (selector: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCliCommand(async () => {
        const load = parseBrowserWaitLoadState(opts.load);
        await runBrowserAction({
          parent,
          body: {
            kind: "wait",
            timeMs: opts.time,
            text: normalizeOptionalString(opts.text),
            textGone: normalizeOptionalString(opts.textGone),
            selector: normalizeOptionalString(selector),
            url: normalizeOptionalString(opts.url),
            loadState: load,
            fn: normalizeOptionalString(opts.fn),
            targetId: normalizeOptionalString(opts.targetId),
            timeoutMs: opts.timeoutMs,
          },
          successMessage: "wait complete",
        });
      });
    });

  browser
    .command("evaluate")
    .description("Evaluate JavaScript against the page or a ref")
    .option(
      "--fn <code>",
      "Function source, expression, or statement body, e.g. const text = el.textContent; return text;",
    )
    .option("--ref <id>", "Ref from snapshot")
    .option(
      "--timeout-ms <ms>",
      "How long to allow the evaluate function to run (default: 20000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      if (!opts.fn) {
        defaultRuntime.error(danger("Missing --fn"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCliCommand(async () => {
        await runBrowserAction({
          parent,
          body: {
            kind: "evaluate",
            fn: opts.fn,
            ref: normalizeOptionalString(opts.ref),
            targetId: normalizeOptionalString(opts.targetId),
            timeoutMs: opts.timeoutMs,
          },
        });
      });
    });
}
