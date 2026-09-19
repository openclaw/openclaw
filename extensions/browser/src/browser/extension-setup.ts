import os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import {
  browserExtensionStatus,
  installChromeExtensionBootstrap,
  type BrowserExtensionStatus,
} from "./extension-install.js";
import { isValidProfileName } from "./profiles.js";

type BrowserExtensionSetupAction = "inspect" | "install" | "verify";
export type BrowserExtensionSetupResult = {
  action: BrowserExtensionSetupAction;
  target: {
    kind: "local-host";
    platform: NodeJS.Platform;
    hostname: string;
    profile: string;
    relayPort: number;
  };
  phase:
    | "inspection_required"
    | "preparing"
    | "needs_browser_action"
    | "waiting_for_connection"
    | "ready"
    | "blocked";
  reason:
    | "native_host_missing"
    | "native_host_unavailable"
    | "platform_unsupported"
    | "chrome_approval_required"
    | "extension_missing"
    | "connection_unchecked"
    | "relay_unavailable"
    | "extension_disconnected"
    | "connected";
  installation: {
    nativeHostRegistered: boolean;
    installRequested: boolean;
    discoveredProfiles: number;
    awaitingApproval: boolean;
    automaticBootstrapSupported: boolean;
  };
  connection: {
    state: "not_checked" | "unavailable" | "waiting_for_extension" | "connected";
    extensionVersion?: string;
  };
  nextAction:
    | "none"
    | "install"
    | "open_chrome"
    | "approve_extension"
    | "install_from_store"
    | "check_connection"
    | "repair_native_host"
    | "unsupported";
};

type SetupOptions = {
  action: BrowserExtensionSetupAction;
  bundledDir: string;
  pluginRoot: string;
  cfg: OpenClawConfig;
  profile?: string;
  waitMs?: number;
  requestStoreInstall?: boolean;
  nativeHostExecutable?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

/** Filesystem setup has one owner; callers retain their documented output projections. */
export async function observeBrowserExtensionSetup(
  options: Pick<
    SetupOptions,
    | "action"
    | "bundledDir"
    | "pluginRoot"
    | "waitMs"
    | "requestStoreInstall"
    | "signal"
    | "onProgress"
    | "profile"
    | "nativeHostExecutable"
  >,
): Promise<BrowserExtensionStatus> {
  options.signal?.throwIfAborted();
  return options.action === "install"
    ? installChromeExtensionBootstrap({ ...options, browserProfile: options.profile })
    : browserExtensionStatus({
        bundledDir: options.bundledDir,
        pluginRoot: options.pluginRoot,
        browserProfile: options.profile,
        nativeHostExecutable: options.nativeHostExecutable,
        signal: options.signal,
      });
}

async function resolveWindowsSetupSelection(
  options: SetupOptions,
  initial: BrowserExtensionStatus,
  resolved: ReturnType<typeof resolveBrowserConfig>,
): Promise<{ observed: BrowserExtensionStatus; profile: string }> {
  const { windowsManagementObservation } = await import("./extension-windows-host.js");
  const blocked = () =>
    new Error(
      "Windows saved profile is unverified. Repair the intended existing profile with an explicit --browser-profile; no automatic change was made.",
    );
  const inspect = async (profile: string) => {
    options.signal?.throwIfAborted();
    const status = await observeBrowserExtensionSetup({ ...options, action: "inspect", profile });
    options.signal?.throwIfAborted();
    return status;
  };
  function classify(status: BrowserExtensionStatus) {
    if (status.platform !== "win32") {
      return "blocked";
    }
    const fact = windowsManagementObservation(status.registrations);
    const response = fact?.response;
    if (!response || (response.store !== "missing" && response.store !== "requested")) {
      return "blocked";
    }
    if (
      response.ok &&
      response.registration === "owned" &&
      response.mode === "native-windows-cli" &&
      response.installation &&
      fact.browserProfile
    ) {
      return "matching";
    }
    if (
      response.ok &&
      response.registration === "missing" &&
      response.mode === null &&
      !response.installation &&
      response.store === "missing"
    ) {
      return "missing";
    }
    if (
      !response.ok &&
      response.code === "context_conflict" &&
      response.registration === "owned" &&
      response.mode === "native-windows-cli" &&
      !response.installation
    ) {
      return "conflict";
    }
    return "blocked";
  }
  let observed = initial;
  let kind = classify(observed);
  if (kind === "conflict") {
    for (const name of Object.keys(resolved.profiles)) {
      options.signal?.throwIfAborted();
      if (
        name === "chrome" ||
        !isValidProfileName(name) ||
        resolveProfile(resolved, name)?.driver !== "extension"
      ) {
        continue;
      }
      observed = await inspect(name);
      kind = classify(observed);
      if (kind === "matching") {
        break;
      }
      // A disappearance, drift, foreign mode or unknown observation is not another candidate.
      if (kind !== "conflict") {
        throw blocked();
      }
    }
  }
  if (kind !== "matching" && kind !== "missing") {
    throw blocked();
  }
  const selected = windowsManagementObservation(observed.registrations);
  const profile = kind === "missing" ? "chrome" : selected?.browserProfile;
  if (
    !profile ||
    !isValidProfileName(profile) ||
    resolveProfile(resolved, profile)?.driver !== "extension"
  ) {
    throw blocked();
  }
  // Reobserve the same selection before relay access or the single mutation.
  // The C# owner still revalidates under its mutation lock; never retry a mutation.
  const confirmed = await inspect(profile);
  const confirmation = windowsManagementObservation(confirmed.registrations);
  if (
    classify(confirmed) !== kind ||
    (kind === "matching" &&
      (confirmation?.browserProfile !== profile ||
        confirmation.response?.installation?.generation !==
          selected?.response?.installation?.generation))
  ) {
    throw blocked();
  }
  return { observed: confirmed, profile };
}

/** Native bootstrap, not the UI, transfers the host-local key to the origin-locked extension. */
export async function runBrowserExtensionSetup(
  input: SetupOptions,
): Promise<BrowserExtensionSetupResult> {
  let options = input;
  options.signal?.throwIfAborted();
  // Share the existing 60-second management budget across discovery and the
  // selected operation, rather than granting every candidate another minute.
  // POSIX never consumes this signal and retains its existing behavior.
  const windowsBudget = AbortSignal.timeout(60_000);
  const windowsSignal = options.signal
    ? AbortSignal.any([options.signal, windowsBudget])
    : windowsBudget;
  if (process.platform === "win32") {
    options = { ...options, signal: windowsSignal };
  }
  const resolved = resolveBrowserConfig(options.cfg.browser, options.cfg);
  // Omission is not a request to replace an owned launcher selection. Native
  // adapters have no profile picker; resolve their saved local selection before effects.
  let observed =
    options.profile === undefined
      ? await observeBrowserExtensionSetup({ ...options, action: "inspect" })
      : undefined;
  let windowsProfile: string | undefined;
  if (observed?.platform === "win32") {
    options = { ...options, signal: windowsSignal };
    options.signal?.throwIfAborted();
    const selection = await resolveWindowsSetupSelection(options, observed, resolved);
    observed = selection.observed;
    windowsProfile = selection.profile;
  }
  if (
    observed &&
    observed.platform !== "win32" &&
    observed.registrations.some((entry) => entry.state !== "owned" && entry.state !== "missing")
  ) {
    throw new Error("Chrome setup cannot recover the saved profile from an unverified native host");
  }
  const savedProfiles = new Set(
    observed?.registrations
      .filter((entry) => entry.state === "owned")
      .map((entry) => entry.browserProfile ?? "chrome"),
  );
  if (savedProfiles.size > 1) {
    throw new Error("Chrome setup requires an explicit profile when owned registrations disagree");
  }
  const profileName =
    options.profile ?? windowsProfile ?? savedProfiles.values().next().value ?? "chrome";
  const profile = resolveProfile(resolved, profileName);
  if (!profile || profile.driver !== "extension") {
    throw new Error("Chrome setup requires an existing extension browser profile");
  }
  const relayPort =
    profile.cdpPort ??
    resolved.extensionRelayPorts[profileName] ??
    resolved.extensionRelayDefaultPort;
  const status =
    options.action !== "install" && observed
      ? observed
      : await observeBrowserExtensionSetup({ ...options, profile: profileName });
  options.signal?.throwIfAborted();
  const healthyProducts = new Set(
    status.registrations
      .filter((entry) => entry.state === "owned" && !entry.issue)
      .map((entry) => entry.product),
  );
  const discoveredProducts = [...status.discovered, ...status.storeDiscovered].map(
    (entry) => entry.product,
  );
  const nativeHostRegistered =
    healthyProducts.size > 0 && discoveredProducts.every((product) => healthyProducts.has(product));
  const unavailable = status.registrations.some(
    (entry) => entry.state === "foreign" || entry.state === "invalid" || Boolean(entry.issue),
  );
  const installation = {
    nativeHostRegistered,
    installRequested: status.storeInstallRequests.some((entry) => entry.state === "requested"),
    discoveredProfiles:
      status.discovered.length + status.storeDiscovered.filter((entry) => entry.enabled).length,
    awaitingApproval: status.storeDiscovered.some((entry) => entry.awaitingApproval),
    automaticBootstrapSupported: status.platformSupport === "automatic",
  };
  const result: BrowserExtensionSetupResult = {
    action: options.action,
    target: {
      kind: "local-host",
      platform: status.platform,
      hostname: os.hostname(),
      profile: profileName,
      relayPort,
    },
    phase: "waiting_for_connection",
    reason: "connection_unchecked",
    installation,
    connection: { state: "not_checked" },
    nextAction: "check_connection",
  };
  if (!installation.automaticBootstrapSupported) {
    Object.assign(result, {
      phase: "blocked",
      reason: "platform_unsupported",
      nextAction: "unsupported",
    });
  } else if (!nativeHostRegistered) {
    Object.assign(result, {
      phase: unavailable ? "blocked" : "inspection_required",
      reason: unavailable ? "native_host_unavailable" : "native_host_missing",
      nextAction: unavailable ? "repair_native_host" : "install",
    });
  } else if (!installation.discoveredProfiles) {
    Object.assign(result, {
      phase: "needs_browser_action",
      reason: installation.awaitingApproval ? "chrome_approval_required" : "extension_missing",
      nextAction: installation.awaitingApproval
        ? "approve_extension"
        : installation.installRequested
          ? "open_chrome"
          : "install_from_store",
    });
  }
  return options.action === "verify" && (status.platform !== "win32" || result.phase !== "blocked")
    ? verifyBrowserExtensionSetup(result, options.signal)
    : result;
}

async function verifyBrowserExtensionSetup(
  result: BrowserExtensionSetupResult,
  signal?: AbortSignal,
): Promise<BrowserExtensionSetupResult> {
  // Read-only, exact profile/port proof; no key creation, relay start, or remote Gateway.
  try {
    const { readExtensionRelayToken } = await import("./extension-relay/relay-auth.js");
    const token = readExtensionRelayToken();
    if (!token) {
      result.connection = { state: "unavailable" };
    } else {
      const { RelayOwnerClient } = await import("./extension-relay/owner-client.js");
      const client = await RelayOwnerClient.connect({
        port: result.target.relayPort,
        profile: result.target.profile,
        token,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
      try {
        const connection = await client.status();
        result.connection =
          connection.ready && connection.identity
            ? { state: "connected", extensionVersion: connection.identity.extensionVersion }
            : { state: "waiting_for_extension" };
      } finally {
        await client.close();
      }
    }
  } catch {
    signal?.throwIfAborted();
    result.connection = { state: "unavailable" };
  }
  if (result.connection.state === "connected") {
    Object.assign(result, { phase: "ready", reason: "connected", nextAction: "none" });
  } else if (result.phase === "waiting_for_connection") {
    result.reason =
      result.connection.state === "waiting_for_extension"
        ? "extension_disconnected"
        : "relay_unavailable";
  }
  return result;
}
