// SRT sandbox plugin configuration parsing and normalization.
//
// Mirrors the extension config idiom used by the OpenShell backend
// (extensions/openshell/src/config.ts): a strict zod schema wrapped in
// buildPluginConfigSchema() for the plugin registry, plus a resolver that
// applies defaults and throws a user-facing error on invalid input.
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";

/** Network posture for sandboxed commands. S1 defaults to deny-all. */
export type SrtNetworkMode = "deny" | "allow";

/** Fully-resolved SRT plugin config consumed by the backend factory. */
export type ResolvedSrtPluginConfig = {
  /** POSIX shell used to run the wrapped command. */
  binShell: string;
  /** Network posture applied to every sandboxed command. */
  network: SrtNetworkMode;
  /** Extra absolute paths added to the writable allowlist beyond the scope dirs. */
  writablePaths: string[];
  /** Buffered-command timeout in milliseconds (runShellCommand / probes). */
  commandTimeoutMs: number;
};

const DEFAULT_BIN_SHELL = "/bin/bash";
const DEFAULT_NETWORK: SrtNetworkMode = "deny";
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const absolutePath = (fieldName: string) =>
  nonEmptyTrimmedString(`${fieldName} must be a non-empty string`).refine(
    (value) => value.startsWith("/"),
    { error: `${fieldName} entries must be absolute paths` },
  );

const SrtPluginConfigSchema = z.strictObject({
  binShell: absolutePath("binShell").optional(),
  network: z.enum(["deny", "allow"], { error: "network must be one of deny, allow" }).optional(),
  writablePaths: z
    .array(absolutePath("writablePaths"), {
      error: "writablePaths must be an array of absolute path strings",
    })
    .optional(),
  commandTimeoutSeconds: z
    .number({
      error: `commandTimeoutSeconds must be a number between 1 and ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .min(1, { error: "commandTimeoutSeconds must be a number >= 1" })
    .max(MAX_TIMER_TIMEOUT_SECONDS, {
      error: `commandTimeoutSeconds must be a number <= ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .optional(),
});

function normalizeWritablePaths(value: string[] | undefined): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of value ?? []) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

/** Build the plugin registry config schema (validation only). */
export function createSrtPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(SrtPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = SrtPluginConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        error: {
          issues: mapPluginConfigIssues(parsed.error.issues),
        },
      };
    },
  });
}

/** Resolve raw plugin config into the backend's normalized shape. */
export function resolveSrtPluginConfig(value: unknown): ResolvedSrtPluginConfig {
  if (value === undefined) {
    return {
      binShell: DEFAULT_BIN_SHELL,
      network: DEFAULT_NETWORK,
      writablePaths: [],
      commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    };
  }
  const parsed = SrtPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid srt-sandbox plugin config: ${message}`);
  }
  const cfg = parsed.data;
  return {
    binShell: cfg.binShell ?? DEFAULT_BIN_SHELL,
    network: cfg.network ?? DEFAULT_NETWORK,
    writablePaths: normalizeWritablePaths(cfg.writablePaths),
    commandTimeoutMs:
      typeof cfg.commandTimeoutSeconds === "number"
        ? Math.floor(cfg.commandTimeoutSeconds * 1000)
        : DEFAULT_COMMAND_TIMEOUT_MS,
  };
}
