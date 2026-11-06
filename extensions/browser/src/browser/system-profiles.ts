/** Discovery and cookie import for macOS Chrome-family system profiles. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { startSqliteReadOnlyLocationAsync } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import { usesOpenClawMockKeychain } from "./chrome.profile-decoration.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import { getPwAiModule } from "./pw-ai-module.js";
import { type BrowserRouteContext, runProfileContextOperation } from "./server-context.js";
import { isProfileRestartRequiredError } from "./server-context.lifecycle.js";
import {
  readChromeCookiesDatabase,
  SUPPORTED_SYSTEM_BROWSERS,
  type CookieImportCounts,
  type KeychainSecretReader,
  type SystemBrowser,
} from "./system-chrome-cookies.js";

export type SystemProfileInfo = {
  browser: SystemBrowser;
  id: string;
  name: string;
  hasCookies: boolean;
};

export type ImportSystemProfileParams = {
  browser?: string;
  systemProfile?: string;
  into?: string;
  domains?: string[];
  makeDefault?: boolean;
};

export type ImportSystemProfileResult = {
  ok: true;
  systemProfile: string;
  into: string;
  browser: SystemBrowser;
  cookies: CookieImportCounts;
  domains: string[];
};

type CreateProfile = (params: { name: string; driver?: "openclaw" }) => Promise<unknown>;

const SYSTEM_BROWSER_DIRS: Record<SystemBrowser, string[]> = {
  chrome: ["Google", "Chrome"],
  brave: ["BraveSoftware", "Brave-Browser"],
  edge: ["Microsoft Edge"],
  chromium: ["Chromium"],
};

function resolveSystemBrowser(value?: string): SystemBrowser {
  const browser = value?.trim().toLowerCase() || "chrome";
  const supported = SUPPORTED_SYSTEM_BROWSERS.find((candidate) => candidate === browser);
  if (supported) {
    return supported;
  }
  throw new Error(`unsupported system browser "${value}"; use chrome, brave, edge, or chromium`);
}

function resolveSystemBrowserRoot(browser: SystemBrowser): string {
  return path.join(os.homedir(), "Library", "Application Support", ...SYSTEM_BROWSER_DIRS[browser]);
}

/**
 * macOS App Data protection can park open() on another browser's files until someone answers a
 * consent prompt, possibly never on a headless host. Opening on the libuv pool keeps the Gateway
 * event loop running and settles consent before the SQLite worker reads the file.
 */
async function canOpenBrowserData(target: string): Promise<boolean> {
  try {
    await (await fs.promises.open(target, "r")).close();
    return true;
  } catch {
    return false;
  }
}

/** Prefer Chrome's current Network/Cookies location, then its legacy location. */
async function resolveSystemCookiesFile(
  root: string,
  profileId: string,
): Promise<string | undefined> {
  for (const candidate of [
    path.join(root, profileId, "Network", "Cookies"),
    path.join(root, profileId, "Cookies"),
  ]) {
    if (await canOpenBrowserData(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Enforce the host-local platform contract before touching browser cookie state. */
export function assertSystemCookiePlatform(operation = "cookie access"): void {
  if (process.platform !== "darwin") {
    throw new Error(`system profile ${operation} is only supported on macOS in this release`);
  }
}

export async function resolveSystemCookieSource(params: {
  browser?: string;
  systemProfile?: string;
}) {
  const browser = resolveSystemBrowser(params.browser);
  const systemProfile = params.systemProfile?.trim() || "Default";
  const root = resolveSystemBrowserRoot(browser);
  const cookiesFile = await resolveSystemCookiesFile(root, systemProfile);
  if (!cookiesFile) {
    throw new Error(`cookies database not found for ${browser} profile "${systemProfile}"`);
  }
  return { browser, systemProfile, cookiesFile };
}

async function readProfileNames(root: string): Promise<Map<string, string>> {
  try {
    const localState = JSON.parse(
      await fs.promises.readFile(path.join(root, "Local State"), "utf8"),
    ) as {
      profile?: {
        info_cache?: Record<string, { name?: unknown; user_name?: unknown; gaia_name?: unknown }>;
      };
    };
    const names = new Map<string, string>();
    for (const [id, info] of Object.entries(localState.profile?.info_cache ?? {})) {
      const displayName = [info.name, info.gaia_name, info.user_name].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      names.set(id, displayName?.trim() || id);
    }
    return names;
  } catch {
    return new Map();
  }
}

async function readBrowserProfiles(
  browser: SystemBrowser,
  root: string,
): Promise<SystemProfileInfo[]> {
  const names = await readProfileNames(root);
  if (names.size === 0 && (await canOpenBrowserData(path.join(root, "Default")))) {
    names.set("Default", "Default");
  }
  const profiles: SystemProfileInfo[] = [];
  for (const [id, name] of names) {
    if (id === "Default" || /^Profile \d+$/.test(id)) {
      const hasCookies = (await resolveSystemCookiesFile(root, id)) !== undefined;
      profiles.push({ browser, id, name, hasCookies });
    }
  }
  return profiles.toSorted((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

// A probe parked on consent holds one pool thread until macOS answers. Join it per browser
// root so app status polls and agent retries cannot park every libuv thread meanwhile.
const pendingBrowserProfiles = new Map<string, Promise<SystemProfileInfo[]>>();

function listOneBrowserProfiles(browser: SystemBrowser): Promise<SystemProfileInfo[]> {
  const root = resolveSystemBrowserRoot(browser);
  let pending = pendingBrowserProfiles.get(root);
  if (!pending) {
    pending = readBrowserProfiles(browser, root).finally(() => pendingBrowserProfiles.delete(root));
    pendingBrowserProfiles.set(root, pending);
  }
  return pending;
}

/**
 * Enumerate importable Chrome-family profiles without reading the Keychain. With
 * no browser specified, list every supported browser so discovery matches the
 * Chrome-family import support instead of assuming Chrome.
 */
export async function listSystemProfiles(browserInput?: string): Promise<SystemProfileInfo[]> {
  const browsers = browserInput?.trim()
    ? [resolveSystemBrowser(browserInput)]
    : SUPPORTED_SYSTEM_BROWSERS;
  const profiles: SystemProfileInfo[] = [];
  for (const browser of browsers) {
    profiles.push(...(await listOneBrowserProfiles(browser)));
  }
  return profiles;
}

/** Snapshot and decrypt cookies from one local macOS Chrome-family profile. */
export async function readSystemProfileCookies(
  params: {
    browser?: string;
    systemProfile?: string;
    domains?: readonly string[];
    signal?: AbortSignal;
  },
  options: { readSecret?: KeychainSecretReader } = {},
) {
  assertSystemCookiePlatform();
  const source = await resolveSystemCookieSource(params);
  const preparation = startSqliteReadOnlyLocationAsync(source.cookiesFile, {
    signal: params.signal,
  });
  try {
    const snapshot = await preparation.result;
    const decrypted = await readChromeCookiesDatabase({
      browser: source.browser,
      databasePath: snapshot.location,
      domains: params.domains,
      readSecret: options.readSecret,
      signal: params.signal,
    });
    return { browser: source.browser, systemProfile: source.systemProfile, ...decrypted };
  } finally {
    await preparation.startClose().result;
  }
}

/** Import decrypted system-profile cookies into one managed OpenClaw profile. */
export async function importSystemProfileCookies(
  params: ImportSystemProfileParams,
  runtime: {
    ctx: BrowserRouteContext;
    createProfile: CreateProfile;
    signal?: AbortSignal;
    finalize?: (result: ImportSystemProfileResult) => Promise<void>;
  },
): Promise<ImportSystemProfileResult> {
  assertSystemCookiePlatform("import");
  const cfg = getRuntimeConfig();
  if (cfg.browser?.allowSystemProfileImport === false) {
    throw new Error("system profile import is disabled (browser.allowSystemProfileImport=false)");
  }

  const browser = resolveSystemBrowser(params.browser);
  const systemProfile = params.systemProfile?.trim() || "Default";
  const into = params.into?.trim() || "imported";
  const available = await listSystemProfiles(browser);
  const sourceProfile = available.find((profile) => profile.id === systemProfile);
  if (!sourceProfile) {
    throw new Error(`system browser profile "${systemProfile}" was not found for ${browser}`);
  }
  await resolveSystemCookieSource({ browser, systemProfile });

  if (!(into in runtime.ctx.state().resolved.profiles)) {
    await runtime.createProfile({ name: into, driver: "openclaw" });
  }
  const profileCtx = runtime.ctx.forProfile(into);
  if (
    profileCtx.profile.driver !== "openclaw" ||
    !profileCtx.profile.cdpIsLoopback ||
    profileCtx.profile.attachOnly
  ) {
    throw new Error(
      `profile "${into}" is not a locally managed OpenClaw profile; import into a fresh profile name`,
    );
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runProfileContextOperation(
        profileCtx,
        runtime.signal,
        async (signal, profileRuntime) => {
          await profileCtx.ensureBrowserAvailable({ headless: true, signal });
          const userDataDir = resolveOpenClawUserDataDir(into);
          const runningUserDataDir = profileRuntime.running?.userDataDir;
          if (
            !runningUserDataDir ||
            path.resolve(runningUserDataDir) !== path.resolve(userDataDir)
          ) {
            throw new Error(
              `managed profile "${into}" is not owned by this OpenClaw browser runtime; stop it and import into a fresh profile name`,
            );
          }
          if (!usesOpenClawMockKeychain(userDataDir)) {
            throw new Error(
              `managed profile "${into}" does not use the OpenClaw mock keychain; import into a fresh profile name`,
            );
          }

          const decrypted = await readSystemProfileCookies({
            browser,
            systemProfile,
            domains: params.domains,
            signal,
          });
          signal.throwIfAborted();
          const pw = await getPwAiModule({ mode: "strict" });
          if (!pw) {
            throw new Error("Playwright is required to import system profile cookies");
          }
          let injected = 0;
          if (decrypted.cookies.length > 0) {
            const tab = await profileCtx.ensureTabAvailable(undefined, {
              allowPlaywrightFallback: true,
              signal,
            });
            try {
              const result = await pw.cookiesSetManyViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                targetId: tab.targetId,
                cookies: decrypted.cookies,
                signal,
              });
              signal.throwIfAborted();
              injected = result.added;
            } catch {
              // Session/CDP errors may include rejected cookie payloads. Keep decrypted values private.
              throw new Error(`failed to inject imported cookies into managed profile "${into}"`);
            }
          }
          // Cookies rejected by Playwright are counted, not fatal: the import stays
          // best-effort and imported reflects what actually landed in the profile.
          const rejected = decrypted.cookies.length - injected;
          return {
            ok: true,
            systemProfile,
            into,
            browser,
            cookies: {
              total: decrypted.counts.total,
              imported: injected,
              failed: decrypted.counts.failed + rejected,
              skipped: decrypted.counts.skipped,
            },
            domains: decrypted.domains,
          } satisfies ImportSystemProfileResult;
        },
        {
          commit: async (result) => await runtime.finalize?.(result),
        },
      );
    } catch (err) {
      if (isProfileRestartRequiredError(err)) {
        if (attempt === 0) {
          await profileCtx.ensureBrowserAvailable({ headless: true, signal: runtime.signal });
          continue;
        }
        throw new BrowserProfileUnavailableError(
          `Managed profile "${into}" could not stabilize for cookie import.`,
        );
      }
      throw err;
    }
  }
  throw new Error(`managed profile "${into}" could not stabilize for cookie import`);
}
