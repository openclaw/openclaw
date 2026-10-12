import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { registerBrowserResizeCommand } from "../browser-cli-resize.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";

export function registerBrowserNavigationCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("navigate")
    .description("Navigate the current tab to a URL")
    .argument("<url>", "URL to navigate to")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (url: string, opts, cmd) => {
      await runBrowserCliRequest<{ url?: string }>({
        parent: parentOpts(cmd),
        path: "/navigate",
        body: { url, targetId: normalizeOptionalString(opts.targetId) },
        errorPolicy: "inline",
        successMessage: (result) => `navigated to ${result.url ?? url}`,
      });
    });

  registerBrowserResizeCommand(
    browser.command("resize").description("Resize the viewport"),
    parentOpts,
  );
}
