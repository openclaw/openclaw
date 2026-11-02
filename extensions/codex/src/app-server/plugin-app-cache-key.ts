/**
 * Builds stable Codex plugin/app inventory cache keys from app-server startup,
 * auth, account, and version inputs without storing secret material.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-registration";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import { parse as parseSemver } from "semver";
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
import { isJsonObject } from "./protocol.js";

const require = createRequire(import.meta.url);
const CODEX_PLUGIN_VERSION = readPluginPackageVersion({ require });

/** Inputs that identify the Codex app inventory cache scope for one runtime. */
type CodexPluginAppCacheKeyParams = Omit<
  CodexAppInventoryCacheKeyInput,
  "codexHome" | "endpoint"
> & {
  appServer: Pick<CodexAppServerRuntimeOptions, "start">;
  agentDir?: string;
  runtimeIdentity?: CodexAppServerRuntimeIdentity;
  desktopGenerationFingerprint?: string;
};

/** Builds the full app inventory cache key for Codex plugin/app discovery. */
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

/** Builds a durable thread-binding fingerprint for one initialized app-server runtime. */
export function buildCodexAppServerRuntimeFingerprint(params: {
  appServer: Pick<
    CodexAppServerRuntimeOptions,
    "start" | "connectionClass" | "remoteWorkspaceRoot"
  >;
  appServerVersion?: string;
  runtimeIdentity?: CodexAppServerRuntimeIdentity;
}): string {
  return JSON.stringify({
    endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
    connectionClass: params.appServer.connectionClass,
    remoteWorkspaceRoot: params.appServer.remoteWorkspaceRoot ?? null,
    appServerVersion: params.appServerVersion ?? params.runtimeIdentity?.serverVersion ?? null,
    runtimeIdentity: params.runtimeIdentity ?? null,
  });
}

/** Only the two version fields and the leading version in Codex's user agent may change. */
export function isCodexRemoteRuntimeVersionUpgrade(previous?: string, current?: string): boolean {
  if (!previous || !current || previous === current) {
    return false;
  }
  function normalize(raw: string) {
    const value: unknown = JSON.parse(raw);
    if (
      !isJsonObject(value) ||
      value.connectionClass !== "remote" ||
      typeof value.endpoint !== "string"
    ) {
      return undefined;
    }
    const endpoint: unknown = JSON.parse(value.endpoint);
    if (
      !isJsonObject(endpoint) ||
      endpoint.transport !== "websocket" ||
      typeof endpoint.url !== "string" ||
      !endpoint.url ||
      typeof endpoint.credentialFingerprint !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(endpoint.credentialFingerprint)
    ) {
      return undefined;
    }
    const identity = value.runtimeIdentity;
    if (
      !isJsonObject(identity) ||
      !identity.codexHome ||
      !identity.platformFamily ||
      !identity.platformOs
    ) {
      return undefined;
    }
    const version = value.appServerVersion;
    const agent =
      typeof identity.userAgent === "string" &&
      /^([^/\s]+)\/([^\s(]+)(.*)$/.exec(identity.userAgent);
    if (
      !agent ||
      typeof version !== "string" ||
      identity.serverVersion !== version ||
      agent[2] !== version
    ) {
      return undefined;
    }
    const parsed = parseSemver(version);
    if (!parsed) {
      return undefined;
    }
    return {
      version: parsed,
      location: {
        ...value,
        appServerVersion: null,
        runtimeIdentity: { ...identity, serverVersion: null, userAgent: [agent[1], agent[3]] },
      },
    };
  }
  try {
    const before = normalize(previous);
    const after = normalize(current);
    return Boolean(
      before &&
      after &&
      after.version.compare(before.version) > 0 &&
      isDeepStrictEqual(before.location, after.location),
    );
  } catch {
    return false;
  }
}

/** Fingerprints the configured connection that owns a supervised source thread. */
export function buildCodexAppServerConnectionFingerprint(
  appServer: Pick<
    CodexAppServerRuntimeOptions,
    "start" | "connectionClass" | "remoteWorkspaceRoot"
  >,
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
  const hash = createHash("sha256");
  hash.update("openclaw:codex:plugin-app-cache-credentials:v1");
  hash.update("\0");
  hash.update(authToken);
  for (const [key, value] of headers) {
    hash.update("\0");
    hash.update(key);
    hash.update("\0");
    hash.update(value);
  }
  return `sha256:${hash.digest("hex")}`;
}
