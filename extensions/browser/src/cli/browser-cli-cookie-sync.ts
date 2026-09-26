/** Host-local macOS system-cookie sync into a managed Browser profile. */
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { watch } from "@openclaw/fs-safe/watch";
import type { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
} from "openclaw/plugin-sdk/file-access-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import {
  cacheKeychainSecret,
  type KeychainSecretReader,
} from "../browser/system-chrome-cookies.js";
import { parseSystemProfileDomains } from "../browser/system-profile-domains.js";
import {
  assertSystemCookiePlatform,
  readSystemProfileCookies,
  resolveSystemCookieSource,
} from "../system-profile-api.js";
import {
  callBrowserRequest,
  runBrowserCliCommand,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";

const COOKIE_SYNC_DEBOUNCE_MS = 1_500;

type CookieSyncOptions = {
  domains?: string;
  into: string;
  browser: string;
  system: string;
  watch?: boolean;
};

type CookieSyncSummary = {
  browser: string;
  systemProfile: string;
  into: string;
  gateway: string;
  total: number;
  pushed: number;
  skipped: number;
  failed: number;
  domains: string[];
};

function parseCookieSyncDomains(raw: string | undefined): string[] {
  if (raw === undefined) {
    throw new Error("--domains is required; cookie sync never sends an unrestricted cookie jar");
  }
  const domains = parseSystemProfileDomains(raw.split(","));
  if (!domains) {
    throw new Error("--domains must include at least one non-empty domain");
  }
  return domains;
}

function formatCookieSyncSummary(summary: CookieSyncSummary): string {
  const domains = summary.domains.length > 0 ? summary.domains.join(",") : "none";
  return (
    `cookie sync ${summary.browser}/${summary.systemProfile} -> ${summary.into} ` +
    `via ${summary.gateway}: total=${summary.total} pushed=${summary.pushed} ` +
    `skipped=${summary.skipped} failed=${summary.failed} domains=${domains}`
  );
}

async function pushSystemProfileCookies(params: {
  options: CookieSyncOptions;
  parent: BrowserParentOpts;
  domains: readonly string[];
  signal?: AbortSignal;
  readSecret?: KeychainSecretReader;
}): Promise<CookieSyncSummary> {
  const source = await readSystemProfileCookies(
    {
      browser: params.options.browser,
      systemProfile: params.options.system,
      domains: params.domains,
      signal: params.signal,
    },
    { readSecret: params.readSecret },
  );
  let pushed = 0;
  if (source.cookies.length > 0) {
    const result = await callBrowserRequest<{ added: number }>(params.parent, {
      method: "POST",
      path: "/cookies/set-many",
      query: { profile: params.options.into },
      body: { cookies: source.cookies },
    });
    pushed = result.added;
  }
  return {
    browser: source.browser,
    systemProfile: source.systemProfile,
    into: params.options.into,
    gateway: params.parent.url?.trim() || "configured/default",
    total: source.counts.total,
    pushed,
    skipped: source.counts.skipped,
    failed: source.counts.failed + Math.max(0, source.cookies.length - pushed),
    domains: source.domains.toSorted(),
  };
}

async function watchSystemProfileCookies(params: {
  options: CookieSyncOptions;
  parent: BrowserParentOpts;
  domains: readonly string[];
}): Promise<void> {
  assertSystemCookiePlatform();
  const source = resolveSystemCookieSource({
    browser: params.options.browser,
    systemProfile: params.options.system,
  });
  const controller = new AbortController();
  const readSecret = await cacheKeychainSecret(source.browser, controller.signal);
  let debounce: NodeJS.Timeout | undefined;
  let inFlight = false;
  let pending = false;
  let stopped = false;
  let stopError: Error | undefined;
  const stoppedResult = createDeferred<void>();
  const settleStopped = () => {
    stoppedResult.resolve();
  };

  const runCycle = async () => {
    if (stopped) {
      return;
    }
    if (inFlight) {
      pending = true;
      return;
    }
    pending = false;
    inFlight = true;
    try {
      const summary = await pushSystemProfileCookies({
        ...params,
        readSecret,
        signal: controller.signal,
      });
      defaultRuntime.error(formatCookieSyncSummary(summary));
    } catch (error) {
      if (!stopped) {
        defaultRuntime.error(`cookie sync failed: ${String(error)}`);
      }
    } finally {
      inFlight = false;
      if (stopped) {
        settleStopped();
      } else if (pending) {
        void runCycle();
      }
    }
  };

  const sourceName = path.basename(source.cookiesFile);
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(debounce);
    controller.abort(new Error("cookie sync stopped"));
    if (!inFlight) {
      settleStopped();
    }
  };
  const fail = (error: Error) => {
    stopError = error;
    stop();
  };
  const authority = await root(path.dirname(source.cookiesFile));
  const mode = resolveFsObservationMode();
  let ready = false;
  const selected = (name: string) => name === sourceName || name.startsWith(`${sourceName}-`);
  const watcher = watch(authority, {
    scopes: [{ path: ".", kind: "tree", depth: 1 }],
    mode,
    intervalMs: mode === "poll" ? resolveFsObservationIntervalMs() : undefined,
    exclude: (entry) =>
      Boolean(entry.path) && entry.path !== "." && !selected(path.basename(entry.path)),
    onInvalidate: (invalidation) => {
      if (stopped || (!ready && invalidation.reason === "reconcile" && !invalidation.changes)) {
        return;
      }
      if (
        invalidation.changes &&
        !invalidation.changes.some((change) => selected(path.basename(change.path)))
      ) {
        return;
      }
      clearTimeout(debounce);
      debounce = setTimeout(() => void runCycle(), COOKIE_SYNC_DEBOUNCE_MS);
    },
    onHealth: (health) => {
      if (health.state === "unavailable") {
        fail(new Error("cookie sync observation failed", { cause: health.failure?.error }));
      }
    },
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watcher.ready;
    ready = true;
    await runCycle();
    await stoppedResult.promise;
    if (stopError) {
      throw stopError;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    stop();
    await watcher.close();
  }
}

export function registerBrowserCookieSyncCommand(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("cookie-sync")
    .description("Sync allowlisted macOS Chrome-family cookies into a managed profile")
    .option("--domains <list>", "Required comma-separated domain allowlist")
    .option("--into <profile>", "Target managed Browser profile", "imported")
    .option("--browser <browser>", "System browser: chrome, brave, edge, or chromium", "chrome")
    .option("--system <id>", "System browser profile directory", "Default")
    .option("--watch", "Watch the source Cookies database and re-sync changes", false)
    .action((options: CookieSyncOptions, command: Command) =>
      runBrowserCliCommand(async () => {
        const domains = parseCookieSyncDomains(options.domains);
        const parent = parentOpts(command);
        if (options.watch) {
          await watchSystemProfileCookies({ options, parent, domains });
          return;
        }
        const summary = await pushSystemProfileCookies({ options, parent, domains });
        defaultRuntime.log(formatCookieSyncSummary(summary));
      }),
    );
}
