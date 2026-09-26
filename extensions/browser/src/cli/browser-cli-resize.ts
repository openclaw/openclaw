/**
 * Shared Browser CLI resize runner used by resize and set viewport commands.
 */
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ACT_MAX_VIEWPORT_DIMENSION } from "../browser/act-policy.js";
import { runBrowserCliRequest, type BrowserParentOpts } from "./browser-cli-shared.js";

/** Parses a bounded viewport dimension for both Browser resize commands. */
export function parseBrowserViewportDimension(value: unknown, label: string): number | undefined {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed !== undefined && parsed <= ACT_MAX_VIEWPORT_DIMENSION) {
    return parsed;
  }
  const reason =
    parsed === undefined
      ? "must be a positive integer"
      : `maximum is ${ACT_MAX_VIEWPORT_DIMENSION}`;
  defaultRuntime.error(danger(`Invalid ${label}: ${reason}`));
  defaultRuntime.exit(1);
  return undefined;
}

/** Sends dimensions validated by the CLI parser and writes the resize result. */
export async function runBrowserResizeWithOutput(params: {
  parent: BrowserParentOpts;
  profile?: string;
  width: number;
  height: number;
  targetId?: string;
  successMessage: string;
  errorPolicy?: "runtime" | "inline";
}): Promise<void> {
  await runBrowserCliRequest({
    parent: params.parent,
    profile: params.profile,
    path: "/act",
    body: {
      kind: "resize",
      width: params.width,
      height: params.height,
      targetId: normalizeOptionalString(params.targetId),
    },
    successMessage: params.successMessage,
    errorPolicy: params.errorPolicy,
  });
}
