import type { Command } from "commander";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ACT_MAX_VIEWPORT_DIMENSION } from "../browser/act-policy.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";

function parseBrowserViewportDimension(value: unknown, label: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed !== undefined && parsed <= ACT_MAX_VIEWPORT_DIMENSION) {
    return parsed;
  }
  const reason =
    parsed === undefined
      ? "must be a positive integer"
      : `maximum is ${ACT_MAX_VIEWPORT_DIMENSION}`;
  throw new Error(`Invalid ${label}: ${reason}`);
}

export function registerBrowserResizeCommand(
  command: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
  alias = false,
) {
  command
    .argument("<width>", "Viewport width")
    .argument("<height>", "Viewport height")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (widthRaw: string, heightRaw: string, opts, cmd) => {
      const width = parseBrowserViewportDimension(widthRaw, "width");
      const height = parseBrowserViewportDimension(heightRaw, "height");
      await runBrowserCliRequest({
        parent: parentOpts(cmd),
        path: "/act",
        body: { kind: "resize", width, height, targetId: normalizeOptionalString(opts.targetId) },
        successMessage: `${alias ? "viewport set:" : "resized to"} ${width}x${height}`,
        errorPolicy: alias ? "runtime" : "inline",
      });
    });
}
