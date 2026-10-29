import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserActRequest } from "../../browser/client-actions.types.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliCommand,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";
import { runBrowserAction, readActionsPayload, parseBrowserInputArray } from "./shared.js";

export function registerBrowserBatchCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("batch")
    .description("Run a batch of browser actions in one call (default: stop on first error)")
    .option("--actions <json>", "JSON array of act requests")
    .option("--actions-file <path>", "Read JSON array from a file (- for stdin)")
    .option("--continue", "Continue through all actions instead of stopping on first error")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      if (opts.actions !== undefined && opts.actionsFile !== undefined) {
        throw new Error("Specify only one of --actions or --actions-file");
      }
      if (!opts.actions && !opts.actionsFile) {
        throw new Error("Provide --actions, --actions-file, or --actions-file -");
      }
      await runBrowserCliCommand(async () => {
        const payload = await readActionsPayload({
          actions: opts.actions,
          actionsFile: opts.actionsFile,
        });
        const actions = parseBrowserInputArray(payload, "actions");
        if (!actions.length) {
          throw new Error("actions must contain at least one entry");
        }
        const targetId = normalizeOptionalString(opts.targetId);
        const request = {
          kind: "batch",
          actions,
          ...(targetId ? { targetId } : {}),
          ...(opts.continue ? { stopOnError: false } : {}),
        } as BrowserActRequest;
        await runBrowserAction({
          parent,
          body: request,
          successMessage: `batch ran ${actions.length} action(s)`,
        });
      });
    });
}
