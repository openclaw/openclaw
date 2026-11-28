/**
 * Builds stable Codex plugin/app inventory cache keys from app-server startup,
 * auth, account, and version inputs without storing secret material.
 */
import { createRequire } from "node:module";
import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-registration";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import {
  buildCodexAppInventoryCacheKey,
  type CodexAppInventoryCacheKeyInput,
} from "./app-inventory-cache.js";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
  resolveCodexAppServerUserHomeDir,
} from "./auth-start-options.js";
import type { CodexAppServerRuntimeIdentity } from "./client.js";
import type {
  CodexAppServerRuntimeOptions,
  CodexAppServerStartOptions,
} from "./config-contracts.js";

const require = createRequire(import.meta.url);
const CODEX_PLUGIN_VERSION = readPluginPackageVersion({ require });

type CodexPluginAppCacheKeyParams = Omit<
  CodexAppInventoryCacheKeyInput,
  "codexHome" | "endpoint"
> & {
  appServer: Pick<CodexAppServerRuntimeOptions, "start">;
  agentDir?: string;
  runtimeIdentity?: CodexAppServerRuntimeIdentity;
  desktopGenerationFingerprint?: string;
};

export function buildCodexPluginAppCacheKey(params: CodexPluginAppCacheKeyParams): string {
  return buildCodexAppInventoryCacheKey(
    {
      codexHome:
        params.runtimeIdentity?.codexHome ??
        resolveCodexPluginAppCacheCodexHome(params.appServer, params.agentDir),
      endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
      authProfileId: params.authProfileId,
      accountId: params.accountId,
      envApiKeyFingerprint: params.envApiKeyFingerprint,
      appServerVersion: params.appServerVersion ?? params.runtimeIdentity?.serverVersion,
      runtimeIdentity: params.desktopGenerationFingerprint
        ? {
            ...params.runtimeIdentity,
            desktopGeneration: params.desktopGenerationFingerprint,
          }
        : params.runtimeIdentity,
    },
    OPENCLAW_VERSION,
    CODEX_PLUGIN_VERSION,
  );
}

type CodexConnectionFingerprintOptions = Pick<
  CodexAppServerRuntimeOptions,
  "start" | "connectionClass" | "remoteWorkspaceRoot"
>;

function normalizeLocalRuntimeIdentity(
  runtimeIdentity?: CodexAppServerRuntimeIdentity,
): Omit<CodexAppServerRuntimeIdentity, "serverVersion" | "userAgent"> | null {
  if (!runtimeIdentity) {
    return null;
  }
  const { serverVersion: _serverVersion, userAgent: _userAgent, ...durable } = runtimeIdentity;
  return Object.keys(durable).length > 0 ? durable : null;
}

/** Builds a durable thread-binding fingerprint for one initialized app-server runtime. */
export function buildCodexAppServerRuntimeFingerprint(params: {
  appServer: CodexConnectionFingerprintOptions;
  appServerVersion?: string;
  runtimeIdentity?: CodexAppServerRuntimeIdentity;
}): string {
  const local = params.appServer.connectionClass === "local-loopback";
  return JSON.stringify({
    endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
    connectionClass: params.appServer.connectionClass,
    remoteWorkspaceRoot: params.appServer.remoteWorkspaceRoot ?? null,
    ...(local
      ? {
          // Local restarts after a Codex CLI upgrade keep the same CODEX_HOME and rollout store.
          // Excluding version/userAgent preserves local thread custody instead of rotating threads.
          runtimeIdentity: normalizeLocalRuntimeIdentity(params.runtimeIdentity),
        }
      : {
          appServerVersion:
            params.appServerVersion ?? params.runtimeIdentity?.serverVersion ?? null,
          runtimeIdentity: params.runtimeIdentity ?? null,
        }),
  });
}

/**
 * Normalizes a persisted local-loopback runtime fingerprint by stripping transient
 * version/userAgent fields while preserving endpoint, connectionClass, codexHome, and OS.
 * Returns undefined for supervised connection, remote, or non-structured fingerprints.
 */
export function normalizeCodexAppServerLocalRuntimeFingerprint(
  fingerprint: string,
): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fingerprint);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("endpoint" in parsed) ||
      !("connectionClass" in parsed) ||
      !("runtimeIdentity" in parsed) ||
      "codexHome" in parsed ||
      "homeScope" in parsed ||
      "cwd" in parsed
    ) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (record.connectionClass !== "local-loopback") {
      return undefined;
    }
    const rawIdentity = record.runtimeIdentity;
    if (rawIdentity !== null && (typeof rawIdentity !== "object" || Array.isArray(rawIdentity))) {
      return undefined;
    }
    let normalizedIdentity: Record<string, unknown> | null = null;
    if (rawIdentity) {
      const {
        serverVersion: _serverVersion,
        userAgent: _userAgent,
        ...durable
      } = rawIdentity as Record<string, unknown>;
      normalizedIdentity = Object.keys(durable).length > 0 ? durable : null;
    }
    return JSON.stringify({
      endpoint: record.endpoint,
      connectionClass: record.connectionClass,
      remoteWorkspaceRoot: record.remoteWorkspaceRoot ?? null,
      runtimeIdentity: normalizedIdentity,
    });
  } catch {
    return undefined;
  }
}

/**
 * Strips transient OpenClaw and Codex version strings from a structured app cache
 * key so local-loopback thread bindings keep custody across routine upgrades while
 * still rotating on home, endpoint, account, auth, or desktop-generation changes.
 */
export function normalizeCodexPluginAppCacheKeyForLocalBinding(
  appCacheKey: string,
): string | undefined {
  try {
    const parsed: unknown = JSON.parse(appCacheKey);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("endpoint" in parsed) ||
      !("codexHome" in parsed)
    ) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    let normalizedIdentity: Record<string, unknown> | null = null;
    if (
      record.runtimeIdentity &&
      typeof record.runtimeIdentity === "object" &&
      !Array.isArray(record.runtimeIdentity)
    ) {
      const entries = Object.entries(record.runtimeIdentity as Record<string, unknown>)
        .filter(([key]) => key !== "serverVersion" && key !== "userAgent")
        .toSorted(([left], [right]) => left.localeCompare(right));
      normalizedIdentity = entries.length > 0 ? Object.fromEntries(entries) : null;
    }
    return JSON.stringify({
      codexHome: record.codexHome ?? null,
      endpoint: record.endpoint ?? null,
      runtimeIdentity: normalizedIdentity,
      authProfileId: record.authProfileId ?? null,
      accountId: record.accountId ?? null,
      envApiKeyFingerprint: record.envApiKeyFingerprint ?? null,
    });
  } catch {
    return undefined;
  }
}

function readNonEmptyRecordString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Reconstructs candidate pre-upgrade local app cache keys by splicing transient
 * version strings from a legacy local runtime fingerprint into the current durable
 * app cache key. Any change in codexHome, endpoint, auth, account, or desktop
 * generation still mismatches the persisted hash.
 */
export function buildLegacyLocalCodexPluginAppCacheKeys(params: {
  currentAppCacheKey: string;
  legacyRuntimeFingerprint: string;
}): string[] {
  try {
    const parsedRuntime: unknown = JSON.parse(params.legacyRuntimeFingerprint);
    const parsedCurrent: unknown = JSON.parse(params.currentAppCacheKey);
    if (
      !parsedRuntime ||
      typeof parsedRuntime !== "object" ||
      Array.isArray(parsedRuntime) ||
      !parsedCurrent ||
      typeof parsedCurrent !== "object" ||
      Array.isArray(parsedCurrent)
    ) {
      return [];
    }
    const runtime = parsedRuntime as Record<string, unknown>;
    const current = parsedCurrent as Record<string, unknown>;
    if (
      runtime.connectionClass !== "local-loopback" ||
      !("runtimeIdentity" in runtime) ||
      "codexHome" in runtime ||
      "homeScope" in runtime ||
      "cwd" in runtime ||
      !("endpoint" in current) ||
      !("codexHome" in current) ||
      typeof current.openClawVersion !== "string" ||
      typeof current.codexPluginVersion !== "string"
    ) {
      return [];
    }
    const legacyRuntimeIdentity =
      runtime.runtimeIdentity &&
      typeof runtime.runtimeIdentity === "object" &&
      !Array.isArray(runtime.runtimeIdentity)
        ? (runtime.runtimeIdentity as Record<string, unknown>)
        : undefined;
    const legacyServerVersion = readNonEmptyRecordString(legacyRuntimeIdentity?.serverVersion);
    const legacyUserAgent = readNonEmptyRecordString(legacyRuntimeIdentity?.userAgent);
    const legacyAppServerVersion =
      readNonEmptyRecordString(runtime.appServerVersion) ?? legacyServerVersion;
    if (!legacyAppServerVersion && !legacyServerVersion && !legacyUserAgent) {
      return [];
    }
    const durableIdentity: Record<string, string | undefined> = {};
    if (
      current.runtimeIdentity &&
      typeof current.runtimeIdentity === "object" &&
      !Array.isArray(current.runtimeIdentity)
    ) {
      for (const [key, value] of Object.entries(
        current.runtimeIdentity as Record<string, unknown>,
      )) {
        if (key !== "serverVersion" && key !== "userAgent" && typeof value === "string") {
          durableIdentity[key] = value;
        }
      }
    }
    if (legacyServerVersion) {
      durableIdentity.serverVersion = legacyServerVersion;
    }
    if (legacyUserAgent) {
      durableIdentity.userAgent = legacyUserAgent;
    }
    const versionPairs: Array<[string, string]> = [
      [current.openClawVersion, current.codexPluginVersion],
    ];
    const openClawVersionMatch = legacyUserAgent?.match(/\(openclaw;\s*([^);\s]+)\)/i);
    const legacyOpenClawVersion = openClawVersionMatch?.[1]?.trim();
    if (
      legacyOpenClawVersion &&
      (legacyOpenClawVersion !== current.openClawVersion ||
        legacyOpenClawVersion !== current.codexPluginVersion)
    ) {
      versionPairs.push([legacyOpenClawVersion, legacyOpenClawVersion]);
    }
    const input = {
      codexHome: readNonEmptyRecordString(current.codexHome),
      endpoint: readNonEmptyRecordString(current.endpoint),
      runtimeIdentity: Object.keys(durableIdentity).length > 0 ? durableIdentity : undefined,
      authProfileId: readNonEmptyRecordString(current.authProfileId),
      accountId: readNonEmptyRecordString(current.accountId),
      envApiKeyFingerprint: readNonEmptyRecordString(current.envApiKeyFingerprint),
      appServerVersion: legacyAppServerVersion,
    };
    return [
      ...new Set(
        versionPairs.map(([ocVersion, pluginVersion]) =>
          buildCodexAppInventoryCacheKey(input, ocVersion, pluginVersion),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

/** Fingerprints the configured connection that owns a supervised source thread. */
export function buildCodexAppServerConnectionFingerprint(
  appServer: CodexConnectionFingerprintOptions,
  agentDir?: string,
): string {
  return JSON.stringify({
    endpoint: resolveCodexPluginAppCacheEndpoint(appServer),
    connectionClass: appServer.connectionClass,
    remoteWorkspaceRoot: appServer.remoteWorkspaceRoot ?? null,
    homeScope: appServer.start.homeScope ?? null,
    codexHome: resolveCodexAppServerConnectionHome(appServer.start, agentDir),
    cwd: appServer.start.cwd ?? null,
  });
}

function resolveCodexAppServerConnectionHome(
  start: CodexAppServerStartOptions,
  agentDir?: string,
): string | null {
  const configured = start.codexHome ?? start.env?.CODEX_HOME?.trim();
  if (configured) {
    return configured;
  }
  if (start.transport === "unix" && (!start.url || start.url === "unix://")) {
    return resolveCodexAppServerUserHomeDir(start.env ?? process.env);
  }
  if (start.transport !== "stdio") {
    return null;
  }
  if (start.homeScope === "user") {
    return resolveCodexAppServerUserHomeDir(process.env);
  }
  return agentDir ? resolveCodexAppServerLocalHomeDir(start, agentDir) : null;
}

/** Serializes app-server endpoint identity, including credential fingerprints. */
function resolveCodexPluginAppCacheEndpoint(
  appServer: Pick<CodexAppServerRuntimeOptions, "start">,
): string {
  return JSON.stringify({
    transport: appServer.start.transport,
    command: appServer.start.command,
    args: appServer.start.args,
    url: appServer.start.url ?? null,
    credentialFingerprint: fingerprintCodexPluginAppCacheCredentials(appServer.start),
  });
}

/** Resolves the CODEX_HOME value that scopes local app-server inventory. */
function resolveCodexPluginAppCacheCodexHome(
  appServer: Pick<CodexAppServerRuntimeOptions, "start">,
  agentDir?: string,
): string | undefined {
  const configuredCodexHome = appServer.start.codexHome ?? appServer.start.env?.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return configuredCodexHome;
  }
  return appServer.start.transport === "stdio" && agentDir
    ? resolveCodexAppServerHomeDir(agentDir)
    : undefined;
}

function fingerprintCodexPluginAppCacheCredentials(
  startOptions: CodexAppServerStartOptions,
): string | null {
  const authToken = startOptions.authToken ?? "";
  const headers = Object.entries(startOptions.headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (!authToken && headers.length === 0) {
    return null;
  }
  return `sha256:${sha256Hex(
    ["openclaw:codex:plugin-app-cache-credentials:v1", authToken, ...headers.flat()].join("\0"),
  )}`;
}
