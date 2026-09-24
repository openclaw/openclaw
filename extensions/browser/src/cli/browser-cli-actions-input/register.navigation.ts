/**
 * Browser CLI navigation and viewport commands.
 */
import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  parseBrowserViewportDimension,
  runBrowserResizeWithOutput,
} from "../browser-cli-resize.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";

/** Registers Browser navigate and resize commands. */
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

  browser
    .command("resize")
    .description("Resize the viewport")
    .argument("<width>", "Viewport width")
    .argument("<height>", "Viewport height")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (width: string, height: string, opts, cmd) => {
      const normalizedWidth = parseBrowserViewportDimension(width, "width");
      const normalizedHeight = parseBrowserViewportDimension(height, "height");
      if (normalizedWidth === undefined || normalizedHeight === undefined) {
        return;
      }
      await runBrowserResizeWithOutput({
        parent: parentOpts(cmd),
        width: normalizedWidth,
        height: normalizedHeight,
        targetId: opts.targetId,
        successMessage: `resized to ${normalizedWidth}x${normalizedHeight}`,
        errorPolicy: "inline",
      });
    });
}
