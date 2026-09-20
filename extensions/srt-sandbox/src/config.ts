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
  /**
   * S5 P0 global network allowlist (v1 plan §6.4 P0). When non-empty under the
   * "deny" posture these domains are permitted and everything else is denied — a
   * single allowlist shared by every scope (global, not per-session; per-session
   * R3 is the open S4/P1 decision). Empty keeps the strict deny-all default.
   *
   * LINUX LIMITATION: on Linux the sandbox network boundary is bwrap
   * --unshare-net (all-or-nothing); SRT enforces domain allowlisting at a host
   * proxy, not at the kernel boundary (SRT linux-sandbox-utils.ts:466-468). The
   * kernel guarantee on Linux is deny-all; the allowlist is proxy-level.
   */
  allowedDomains: string[];
  /** Extra absolute paths added to the writable allowlist beyond the scope dirs. */
  writablePaths: string[];
  /** Buffered-command timeout in milliseconds (runShellCommand / probes). */
  commandTimeoutMs: number;
  /**
   * S4-P1 (XIN-1936): when true, each session is routed through its OWN
   * `srt --control-fd` broker process (Candidate 2), giving real per-session
   * network isolation — a private proxy + token + allowlist + (Linux) netns per
   * session. When false (default) the P0 global-allowlist in-process path is
   * used unchanged. Only meaningful under the "deny" posture.
   */
  perSessionNetwork: boolean;
  /**
   * Optional upstream proxy the per-session broker tunnels through. Baked into
   * the broker at spawn; NOT hot-swappable (SRT captures parentProxy by value at
   * proxy creation, sandbox-manager.ts:1979-1982). Only consulted when
   * perSessionNetwork is true.
   */
  parentProxy?: { http?: string; https?: string; noProxy?: string };
  /**
   * S6 Windows options. Each scope maps to a low-privilege account + WFP
   * sublayer + loopback port range (per-scope isolation). `srtWinPath` overrides
   * the vendored per-arch `srt-win.exe`; `sandboxUsers` is the account pool a
   * scope adopts (default a single managed account); `proxyPortBase` is the base
   * loopback PERMIT port. Only consulted on win32.
   */
  windows?: {
    srtWinPath?: string;
    sandboxUsers?: string[];
    proxyPortBase?: number;
  };
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
  allowedDomains: z
    .array(nonEmptyTrimmedString("allowedDomains entries must be non-empty strings"), {
      error: "allowedDomains must be an array of non-empty domain strings",
    })
    .optional(),
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
  perSessionNetwork: z.boolean({ error: "perSessionNetwork must be a boolean" }).optional(),
  parentProxy: z
    .strictObject({
      http: z.string().url({ error: "parentProxy.http must be a URL" }).optional(),
      https: z.string().url({ error: "parentProxy.https must be a URL" }).optional(),
      noProxy: nonEmptyTrimmedString("parentProxy.noProxy must be a non-empty string").optional(),
    })
    .optional(),
  windows: z
    .strictObject({
      srtWinPath: nonEmptyTrimmedString("windows.srtWinPath must be a non-empty string").optional(),
      sandboxUsers: z
        .array(nonEmptyTrimmedString("windows.sandboxUsers entries must be non-empty strings"), {
          error: "windows.sandboxUsers must be an array of non-empty account names",
        })
        .optional(),
      proxyPortBase: z
        .number({ error: "windows.proxyPortBase must be a number" })
        .int({ error: "windows.proxyPortBase must be an integer" })
        .min(1024, { error: "windows.proxyPortBase must be >= 1024" })
        .max(60000, { error: "windows.proxyPortBase must be <= 60000" })
        .optional(),
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

/** Trim + dedupe the P0 global network allowlist, preserving declaration order. */
function normalizeDomains(value: string[] | undefined): string[] {
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const entry of value ?? []) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    domains.push(normalized);
  }
  return domains;
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
      allowedDomains: [],
      writablePaths: [],
      commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      perSessionNetwork: false,
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
    allowedDomains: normalizeDomains(cfg.allowedDomains),
    writablePaths: normalizeWritablePaths(cfg.writablePaths),
    commandTimeoutMs:
      typeof cfg.commandTimeoutSeconds === "number"
        ? Math.floor(cfg.commandTimeoutSeconds * 1000)
        : DEFAULT_COMMAND_TIMEOUT_MS,
    perSessionNetwork: cfg.perSessionNetwork ?? false,
    parentProxy: cfg.parentProxy,
    windows: cfg.windows,
  };
}
