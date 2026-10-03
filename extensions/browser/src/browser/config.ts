import os from "node:os";
import path from "node:path";
import { parseBrowserHttpUrl, redactCdpUrl } from "openclaw/plugin-sdk/browser-cdp";
import type {
  ResolvedBrowserConfig as ResolvedBrowserConfigContract,
  ResolvedBrowserTabCleanupConfig,
} from "openclaw/plugin-sdk/browser-config";
import type {
  BrowserConfig,
  BrowserProfileConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-policy";
import { isLoopbackHost, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeOptionalString,
  normalizeOptionalTrimmedStringList,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  DEFAULT_BROWSER_CONTROL_PORT,
  deriveDefaultBrowserCdpPortRange,
  deriveDefaultBrowserControlPort,
} from "../config/port-defaults.js";
import { normalizeChromeMcpOptions } from "./chrome-mcp-options.js";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS,
  DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS,
  DEFAULT_BROWSER_TAB_CLEANUP_IDLE_MINUTES,
  DEFAULT_BROWSER_TAB_CLEANUP_MAX_TABS_PER_SESSION,
  DEFAULT_BROWSER_TAB_CLEANUP_SWEEP_MINUTES,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import type { BrowserEngineId } from "./engines/types.js";
import type { ManagedBrowserHeadlessSource, ResolvedBrowserProfile } from "./profile.types.js";
export type { ResolvedBrowserProfile } from "./profile.types.js";
export type { ResolvedBrowserTabCleanupConfig } from "openclaw/plugin-sdk/browser-config";

export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  parseBrowserHttpUrl,
  redactCdpUrl,
};
export { parseBrowserHttpUrl as parseHttpUrl };

export type ResolvedBrowserConfig = Omit<ResolvedBrowserConfigContract, "profiles"> & {
  headlessSource?: "config" | "default";
  profiles: Record<string, BrowserProfileConfig>;
  /** Default loopback port for extension-driver relay servers. */
  extensionRelayDefaultPort: number;
  /** Assigned loopback relay port per extension-driver profile (no explicit cdpPort). */
  extensionRelayPorts: Record<string, number>;
  extensionRelay: {
    allowLegacyAuth: boolean;
  };
  /** Per-profile process-only Basic credentials for internal browser clients. */
  extensionRelayInternalTokens: Record<string, string>;
  /** Host-local HMAC key last adopted by the relay lifecycle, not raw config resolution. */
  extensionRelayToken?: string;
};

/** Read a named browser profile without falling through to inherited object keys. */
export function getOwnBrowserProfile<T>(
  profiles: Record<string, T> | undefined,
  name: string,
): T | undefined {
  return profiles && Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}

const DEFAULT_BROWSER_REMOTE_CDP_TIMEOUT_MS = 1_500;
const DEFAULT_BROWSER_REMOTE_CDP_HANDSHAKE_TIMEOUT_MS = 3_000;
const EXTENSION_RELAY_PORT_OFFSET = 8;
/** Username half of the process-only internal relay credential. */
const EXTENSION_RELAY_CDP_USER = "openclaw-internal";
const BROWSER_HEADLESS_ENV_KEY = "OPENCLAW_BROWSER_HEADLESS";

type ManagedBrowserHeadlessMode = {
  headless: boolean;
  source: ManagedBrowserHeadlessSource;
};

type ManagedBrowserMissingDisplayError = {
  message: string;
  headlessSource: Exclude<ManagedBrowserHeadlessSource, "linux-display-fallback">;
};

export type ManagedBrowserHeadlessOptions = {
  headlessOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function normalizeExecutablePath(raw: string | undefined): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  if (!/^~(?=$|[\\/])/.test(value)) {
    return value;
  }
  return path.resolve(value.replace(/^~(?=$|[\\/])/, () => os.homedir()));
}

function normalizeExistingSessionCdpUrl(
  raw: string | undefined,
  profileName: string,
): { cdpUrl: string; cdpHost: string; cdpIsLoopback: boolean } | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`browser.profiles.${profileName}.cdpUrl must be a valid URL.`);
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`browser.profiles.${profileName}.cdpUrl must use http, https, ws, or wss.`);
  }

  const normalized =
    parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString().replace(/\/$/, "")
      : parsed.toString();
  return {
    cdpUrl: normalized,
    cdpHost: parsed.hostname,
    cdpIsLoopback: isLoopbackHost(parsed.hostname),
  };
}

function hasLinuxDisplay(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

export function isLocalManagedProfile(profile: ResolvedBrowserProfile): boolean {
  return (
    resolveBrowserEngine(profile.engine).descriptor.launchMode !== "attach-only" &&
    profile.driver === "openclaw" &&
    profile.cdpIsLoopback &&
    !profile.attachOnly
  );
}

function resolveBrowserTabCleanupConfig(
  cfg: BrowserConfig | undefined,
): ResolvedBrowserTabCleanupConfig {
  const raw = cfg?.tabCleanup;
  return {
    enabled: raw?.enabled ?? true,
    idleMinutes: DEFAULT_BROWSER_TAB_CLEANUP_IDLE_MINUTES,
    maxTabsPerSession: DEFAULT_BROWSER_TAB_CLEANUP_MAX_TABS_PER_SESSION,
    sweepMinutes: DEFAULT_BROWSER_TAB_CLEANUP_SWEEP_MINUTES,
  };
}

function resolveBrowserSsrFPolicy(cfg: BrowserConfig | undefined): SsrFPolicy | undefined {
  const rawPolicy = cfg?.ssrfPolicy;
  const dangerouslyAllowPrivateNetwork = rawPolicy?.dangerouslyAllowPrivateNetwork;
  const resolved = mergeSsrFPolicies({
    ...rawPolicy,
    // Browser config grants private access only through its canonical flag.
    allowPrivateNetwork: false,
    allowedHostnames: normalizeOptionalTrimmedStringList(rawPolicy?.allowedHostnames),
  });
  if (dangerouslyAllowPrivateNetwork !== undefined) {
    return { ...resolved, dangerouslyAllowPrivateNetwork };
  }
  // Keep an explicit strict object so every browser guard stays fail-closed
  // even when the operator leaves the shared policy unconfigured.
  return resolved ?? {};
}

/**
 * Assign a distinct loopback relay port to each extension-driver profile that
 * does not pin its own cdpPort. Ports count down from the default (controlPort+8)
 * — below the managed CDP allocation band (controlPort+9..) — so extension
 * relays and managed Chrome never contend, and two extension profiles never
 * share one port. Deterministic (sorted names) so restarts keep the same URLs.
 */
function resolveExtensionRelayPorts(
  profiles: Record<string, BrowserProfileConfig>,
  defaultPort: number,
): Record<string, number> {
  const names = Object.entries(profiles)
    .filter(([, profile]) => profile.driver === "extension" && profile.cdpPort == null)
    .map(([name]) => name)
    .toSorted();
  // Explicit ports can belong to any profile driver. Reserve them before
  // allocation so an extension relay cannot bind another profile's listener.
  const reservedPorts = new Set(
    Object.values(profiles)
      .map((profile) => profile.cdpPort)
      .filter((port): port is number => typeof port === "number"),
  );
  const ports: Record<string, number> = {};
  const minimumPort = defaultPort - EXTENSION_RELAY_PORT_OFFSET;
  let nextPort = defaultPort;
  for (const name of names) {
    while (nextPort > minimumPort && reservedPorts.has(nextPort)) {
      nextPort -= 1;
    }
    // The control port sits below this band; crossing it would silently
    // collide with browser control instead of creating an extension relay.
    if (nextPort <= minimumPort) {
      throw new Error(
        "No available extension relay ports in the reserved browser relay port range",
      );
    }
    ports[name] = nextPort;
    reservedPorts.add(nextPort);
    nextPort -= 1;
  }
  return ports;
}

function assertDedicatedEngineEndpoints(profiles: Record<string, BrowserProfileConfig>): void {
  const endpoints = new Map<string, { name: string; engine?: BrowserEngineId }>();
  for (const [name, profile] of Object.entries(profiles)) {
    const endpoint = profile.cdpUrl ? URL.parse(profile.cdpUrl) : null;
    if (!endpoint) {
      continue;
    }
    const key = endpoint.toString().replace(/\/$/, "");
    const previous = endpoints.get(key);
    const adapter = resolveBrowserEngine(profile.engine);
    const dedicated = adapter.requiresDedicatedEndpoint
      ? adapter
      : previous && resolveBrowserEngine(previous.engine);
    if (previous && dedicated?.requiresDedicatedEndpoint) {
      throw new Error(
        `${dedicated.descriptor.label} requires a dedicated CDP endpoint; profiles "${previous.name}" and "${name}" share one.`,
      );
    }
    endpoints.set(key, { name, engine: profile.engine });
  }
}

export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
  rootConfig?: OpenClawConfig,
): ResolvedBrowserConfig {
  const gatewayPort = resolveGatewayPort(rootConfig);
  const controlPort = deriveDefaultBrowserControlPort(gatewayPort ?? DEFAULT_BROWSER_CONTROL_PORT);

  const derivedCdpRange = deriveDefaultBrowserCdpPortRange(controlPort);

  const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
  const derivedPort = controlPort + 1;
  if (!rawCdpUrl && derivedPort > 65535) {
    throw new Error(
      `Derived CDP port (${derivedPort}) is too high; check gateway port configuration.`,
    );
  }
  const cdpInfo = parseBrowserHttpUrl(
    rawCdpUrl || `http://127.0.0.1:${derivedPort}`,
    "browser.cdpUrl",
  );

  const executablePath = normalizeExecutablePath(cfg?.executablePath);
  const defaultProfile =
    normalizeOptionalString(cfg?.defaultProfile) ?? DEFAULT_BROWSER_DEFAULT_PROFILE_NAME;

  const isWsUrl = cdpInfo.parsed.protocol === "ws:" || cdpInfo.parsed.protocol === "wss:";
  const profiles = { ...cfg?.profiles };
  profiles[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME] ||= {
    cdpPort: rawCdpUrl ? cdpInfo.port : derivedCdpRange.start,
    ...(rawCdpUrl && isWsUrl ? { cdpUrl: cdpInfo.normalized } : {}),
  };
  profiles.user ||= { driver: "existing-session", attachOnly: true };
  profiles.chrome ||= { driver: "extension" };
  const selectedProfile = getOwnBrowserProfile(profiles, defaultProfile);
  if (
    rawCdpUrl &&
    selectedProfile?.driver === "existing-session" &&
    !normalizeOptionalString(selectedProfile.cdpUrl)
  ) {
    profiles[defaultProfile] = { ...selectedProfile, cdpUrl: cdpInfo.normalized };
  }

  const extraArgs = Array.isArray(cfg?.extraArgs)
    ? cfg.extraArgs.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];

  assertDedicatedEngineEndpoints(profiles);

  return {
    enabled: cfg?.enabled ?? DEFAULT_OPENCLAW_BROWSER_ENABLED,
    evaluateEnabled: cfg?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED,
    controlPort,
    cdpPortRangeStart: derivedCdpRange.start,
    cdpPortRangeEnd: derivedCdpRange.end,
    cdpProtocol: cdpInfo.parsed.protocol === "https:" ? "https" : "http",
    cdpHost: cdpInfo.parsed.hostname,
    cdpIsLoopback: isLoopbackHost(cdpInfo.parsed.hostname),
    remoteCdpTimeoutMs: DEFAULT_BROWSER_REMOTE_CDP_TIMEOUT_MS,
    remoteCdpHandshakeTimeoutMs: DEFAULT_BROWSER_REMOTE_CDP_HANDSHAKE_TIMEOUT_MS,
    localLaunchTimeoutMs: DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS,
    localCdpReadyTimeoutMs: DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS,
    actionTimeoutMs: DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    color: DEFAULT_OPENCLAW_BROWSER_COLOR,
    executablePath,
    headless: cfg?.headless === true,
    headlessSource: typeof cfg?.headless === "boolean" ? "config" : "default",
    noSandbox: cfg?.noSandbox === true,
    attachOnly: cfg?.attachOnly === true,
    defaultProfile,
    profiles,
    tabCleanup: resolveBrowserTabCleanupConfig(cfg),
    ssrfPolicy: resolveBrowserSsrFPolicy(cfg),
    extraArgs,
    extensionRelayDefaultPort: controlPort + EXTENSION_RELAY_PORT_OFFSET,
    extensionRelayPorts: resolveExtensionRelayPorts(
      profiles,
      controlPort + EXTENSION_RELAY_PORT_OFFSET,
    ),
    extensionRelay: {
      allowLegacyAuth: cfg?.extensionRelay?.allowLegacyAuth ?? true,
    },
    extensionRelayInternalTokens: {},
  };
}

/** Selector-free extension pairing follows configuration order, independently of defaultProfile. */
export function resolveFirstExtensionProfileName(
  resolved: Pick<ResolvedBrowserConfig, "profiles">,
): string | undefined {
  return Object.entries(resolved.profiles).find(
    ([, profile]) => profile.driver === "extension",
  )?.[0];
}

export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  const profile = getOwnBrowserProfile(resolved.profiles, profileName);
  if (!profile) {
    return null;
  }

  const adapter = resolveBrowserEngine(profile.engine);
  const engine = adapter.descriptor.id;
  if (adapter.resolveExternalProfile) {
    return adapter.resolveExternalProfile(profileName, profile);
  }

  const rawProfileUrl = profile.cdpUrl?.trim() ?? "";
  let cdpHost = resolved.cdpHost;
  let cdpPort = profile.cdpPort ?? 0;
  let cdpUrl;
  const driver: ResolvedBrowserProfile["driver"] =
    profile.driver === "existing-session" || profile.driver === "extension"
      ? profile.driver
      : "openclaw";
  const headless = profile.headless ?? resolved.headless;
  const headlessSource =
    typeof profile.headless === "boolean" ? "profile" : resolved.headlessSource;
  const executablePath = normalizeExecutablePath(profile.executablePath) ?? resolved.executablePath;
  const common = {
    name: profileName,
    engine,
    color: DEFAULT_OPENCLAW_BROWSER_COLOR,
    driver,
    executablePath,
  };

  if (driver === "extension") {
    const relayPort =
      profile.cdpPort ??
      resolved.extensionRelayPorts[profileName] ??
      resolved.extensionRelayDefaultPort;
    const token = resolved.extensionRelayInternalTokens[profileName];
    // Internal browser clients use a process-only credential. The persistent
    // relay key is reserved for HMAC proofs and never enters a URL or header.
    const relayCdpUrl = token
      ? `http://${EXTENSION_RELAY_CDP_USER}:${encodeURIComponent(token)}@127.0.0.1:${relayPort}`
      : `http://127.0.0.1:${relayPort}`;
    return {
      ...common,
      cdpPort: relayPort,
      cdpUrl: relayCdpUrl,
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      headless: false,
      headlessSource: "default",
      attachOnly: true,
    };
  }

  if (driver === "existing-session") {
    const mcpArgs = normalizeOptionalTrimmedStringList(profile.mcpArgs) ?? undefined;
    const existingSessionCdp = normalizeExistingSessionCdpUrl(
      normalizeChromeMcpOptions({ ...profile, mcpArgs }).browserUrl,
      profileName,
    );
    return {
      ...common,
      cdpPort: 0,
      cdpUrl: existingSessionCdp?.cdpUrl ?? "",
      cdpHost: existingSessionCdp?.cdpHost ?? "",
      cdpIsLoopback: existingSessionCdp?.cdpIsLoopback ?? true,
      userDataDir: resolveUserPath(profile.userDataDir?.trim() || "") || undefined,
      mcpCommand: normalizeOptionalString(profile.mcpCommand),
      mcpArgs,
      headless,
      headlessSource,
      attachOnly: true,
    };
  }

  const hasStaleWsPath =
    rawProfileUrl !== "" &&
    cdpPort > 0 &&
    /^wss?:\/\//i.test(rawProfileUrl) &&
    /\/devtools\/browser\//i.test(rawProfileUrl);

  if (hasStaleWsPath) {
    const parsed = new URL(rawProfileUrl);
    cdpHost = parsed.hostname;
    cdpUrl = `${resolved.cdpProtocol}://${cdpHost}:${cdpPort}`;
  } else if (rawProfileUrl) {
    const parsed = parseBrowserHttpUrl(rawProfileUrl, `browser.profiles.${profileName}.cdpUrl`);
    cdpHost = parsed.parsed.hostname;
    // Port precedence: explicit URL port > configured cdpPort > protocol default.
    if (parsed.hasExplicitPort) {
      cdpPort = parsed.port;
      cdpUrl = parsed.normalizedWithPort;
    } else if (cdpPort) {
      // URL omitted the port but we have an explicit cdpPort — inject it while
      // preserving the rest of the URL (path, query, credentials, etc.).
      const rebuilt = new URL(rawProfileUrl);
      rebuilt.port = String(cdpPort);
      cdpUrl = rebuilt.toString().replace(/\/$/, "");
    } else {
      cdpPort = parsed.port;
      cdpUrl = parsed.normalized;
    }
  } else if (cdpPort) {
    cdpUrl = `${resolved.cdpProtocol}://${resolved.cdpHost}:${cdpPort}`;
  } else {
    throw new Error(`Profile "${profileName}" must define cdpPort or cdpUrl.`);
  }

  return {
    ...common,
    cdpPort,
    cdpUrl,
    cdpHost,
    cdpIsLoopback: isLoopbackHost(cdpHost),
    headless,
    headlessSource,
    attachOnly: profile.attachOnly ?? resolved.attachOnly,
  };
}

export function resolveManagedBrowserHeadlessMode(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  params: ManagedBrowserHeadlessOptions = {},
): ManagedBrowserHeadlessMode {
  if (!isLocalManagedProfile(profile)) {
    return { headless: profile.headless, source: profile.headlessSource ?? "default" };
  }

  if (typeof params.headlessOverride === "boolean") {
    return { headless: params.headlessOverride, source: "request" };
  }

  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const envHeadless = parseBooleanValue(env[BROWSER_HEADLESS_ENV_KEY]);
  if (envHeadless !== undefined) {
    return { headless: envHeadless, source: "env" };
  }

  const profileHeadlessSource = profile.headlessSource ?? "default";
  if (profileHeadlessSource !== "default") {
    return { headless: profile.headless, source: profileHeadlessSource };
  }

  if (platform === "linux" && !hasLinuxDisplay(env)) {
    return { headless: true, source: "linux-display-fallback" };
  }

  return { headless: resolved.headless, source: "default" };
}

export function getManagedBrowserMissingDisplayError(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  params: ManagedBrowserHeadlessOptions = {},
): ManagedBrowserMissingDisplayError | null {
  if (!isLocalManagedProfile(profile)) {
    return null;
  }
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  if (platform !== "linux" || hasLinuxDisplay(env)) {
    return null;
  }

  const mode = resolveManagedBrowserHeadlessMode(resolved, profile, {
    ...params,
    env,
    platform,
  });
  if (mode.headless || mode.source === "linux-display-fallback") {
    return null;
  }

  const sourceHint =
    mode.source === "request"
      ? "request override"
      : mode.source === "env"
        ? `${BROWSER_HEADLESS_ENV_KEY}=0`
        : mode.source === "profile"
          ? `browser.profiles.${profile.name}.headless=false`
          : "browser.headless=false";
  return {
    message:
      `Headed browser start requested for profile "${profile.name}" via ${sourceHint}, ` +
      "but no Linux display server was detected ($DISPLAY/$WAYLAND_DISPLAY unset). " +
      `Set ${BROWSER_HEADLESS_ENV_KEY}=1, remove the headed override, or launch under Xvfb.`,
    headlessSource: mode.source,
  };
}
