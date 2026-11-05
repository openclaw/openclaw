import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import {
  CHROME_REACHABILITY_TIMEOUT_MS,
  MANAGED_CDP_READY_HTTP_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import {
  readChromeVersionWithCredentialFallback,
  type ChromeVersion,
} from "./chrome.diagnostics.js";
import type { RunningChrome } from "./chrome.js";

export async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
  signal?: AbortSignal,
): Promise<ChromeVersion | null> {
  try {
    return await readChromeVersionWithCredentialFallback(cdpUrl, timeoutMs, ssrfPolicy, signal);
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export async function launchChromeWithNativeIdentity(params: {
  cdpUrl: string;
  headless: boolean;
  extraArgs: string[];
  signal?: AbortSignal;
  launch: (userAgent?: string) => Promise<RunningChrome>;
  stop: (running: RunningChrome) => Promise<void>;
}): Promise<RunningChrome> {
  const running = await params.launch();
  if (
    !params.headless ||
    params.extraArgs.some((arg) => arg === "--user-agent" || arg.startsWith("--user-agent="))
  ) {
    return running;
  }
  try {
    const version = await fetchChromeVersion(
      params.cdpUrl,
      MANAGED_CDP_READY_HTTP_TIMEOUT_MS,
      undefined,
      params.signal,
    );
    const userAgent = version?.["User-Agent"];
    if (!userAgent?.includes("HeadlessChrome/")) {
      return running;
    }
    // Chromium supplies the version and platform. A process-wide flag covers
    // every tab and worker, including those created by later CDP clients.
    await params.stop(running);
    params.signal?.throwIfAborted();
    return await params.launch(userAgent.replace("HeadlessChrome/", "Chrome/"));
  } catch (error) {
    await params.stop(running);
    throw error;
  }
}
