import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Sdk from "@github/copilot-sdk";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import copilotPluginPackage from "../package.json" with { type: "json" };

const COPILOT_SDK_SPEC = `@github/copilot-sdk@${copilotPluginPackage.dependencies["@github/copilot-sdk"]}`;

let cached: Promise<typeof Sdk> | undefined;

export async function loadCopilotSdk(
  options: { primaryImport?: () => Promise<typeof Sdk> } = {},
): Promise<typeof Sdk> {
  if (!cached) {
    cached = doLoad(options.primaryImport).catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

async function doLoad(
  primaryImport: () => Promise<typeof Sdk> = () => import("@github/copilot-sdk"),
): Promise<typeof Sdk> {
  let primaryErr: unknown;
  try {
    return await primaryImport();
  } catch (err) {
    primaryErr = err;
  }

  const fallbackDir = path.join(resolveStateDir(), "npm-runtime", "copilot");
  const fallbackPath = path.join(fallbackDir, "node_modules", "@github", "copilot-sdk");
  if (!existsSync(fallbackPath)) {
    throw createMissingSdkError(primaryErr, undefined, fallbackPath);
  }

  try {
    // Node ESM rejects directory imports, so resolve the installed package entry.
    const requireFromFallback = createRequire(path.join(fallbackDir, "package.json"));
    const entry = requireFromFallback.resolve("@github/copilot-sdk");
    return (await import(pathToFileURL(entry).href)) as typeof Sdk;
  } catch (fallbackErr) {
    throw createMissingSdkError(primaryErr, fallbackErr, fallbackPath);
  }
}

function createMissingSdkError(
  primaryErr: unknown,
  fallbackErr: unknown,
  fallbackPath: string,
): Error {
  const lines = [
    "[copilot] @github/copilot-sdk is not installed.",
    "",
    "The external @openclaw/copilot plugin depends on @github/copilot-sdk",
    "including its platform-specific Copilot runtime package.",
    "Reinstall the plugin once with:",
    "",
    "  openclaw plugins install @openclaw/copilot",
    "",
    "For source checkouts or offline repair, install the SDK directly:",
    "",
    `  npm install ${COPILOT_SDK_SPEC}`,
    "",
    `The legacy fallback location is still checked at\n  ${fallbackPath}`,
    "",
    "Primary resolution error:",
    `  ${summarizeError(primaryErr)}`,
  ];
  if (fallbackErr !== undefined) {
    lines.push("", "Fallback resolution error:", `  ${summarizeError(fallbackErr)}`);
  }
  const err = new Error(lines.join("\n"));
  (err as Error & { code?: string }).code = "COPILOT_SDK_MISSING";
  return err;
}

function summarizeError(value: unknown): string {
  if (value === undefined || value === null) {
    return "(none)";
  }
  if (value instanceof Error) {
    return value.message || String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
