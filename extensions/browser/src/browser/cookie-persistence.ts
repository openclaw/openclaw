/**
 * Persist managed-Chrome cookies across browser and gateway restarts.
 *
 * Chrome driven over CDP never flushes cookies to its on-disk SQLite store, so
 * the managed `openclaw` profile loses every login session whenever the browser
 * - or the parent gateway, which owns the Chrome child - restarts. We snapshot
 * cookies over CDP and restore them on the next launch so browser-SSO flows
 * survive restarts.
 *
 * Save runs on graceful stop AND on a periodic flush: a gateway restart
 * (SIGUSR1 / update / crash) kills the Chrome child without calling
 * stopOpenClawChrome, so only the latest periodic snapshot survives that path.
 *
 * Every call is best-effort — a failure here must never break browser
 * start/stop. The sidecar holds live auth tokens, so it is written 0600 inside
 * the already-0700 profile directory.
 */
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withCdpSocket } from "./cdp.helpers.js";

const log = createSubsystemLogger("browser").child("cookie-persistence");

const COOKIE_STORE_FILENAME = "cookies.json";
const COOKIE_CDP_TIMEOUT_MS = 4000;
export const COOKIE_FLUSH_INTERVAL_MS = 60_000;

// Bound the CDP round-trip so a hung browser cannot stall shutdown or pile up
// flush calls; never retry - cookie persistence is best-effort.
const cdpOpts = { commandTimeoutMs: COOKIE_CDP_TIMEOUT_MS, handshakeRetries: 0 } as const;

/** Sidecar path beside the profile user-data dir: ~/.openclaw/browser/<profile>/cookies.json. */
export function resolveCookieStorePath(userDataDir: string): string {
  return path.join(path.dirname(userDataDir), COOKIE_STORE_FILENAME);
}

/**
 * Snapshot all cookies over CDP into the sidecar (0600). Skips writing on an
 * empty result so a transient read failure cannot wipe a good saved jar.
 */
export async function saveManagedChromeCookies(wsUrl: string, userDataDir: string): Promise<void> {
  try {
    // Storage.getCookies works on the browser-level CDP target (default
    // browser context). Network.getAllCookies is page-session only and is not
    // exposed here, so it must not be used.
    const res = (await withCdpSocket(wsUrl, (send) => send("Storage.getCookies"), cdpOpts)) as {
      cookies?: unknown[];
    };
    const cookies = Array.isArray(res?.cookies) ? res.cookies : [];
    if (cookies.length === 0) {
      return;
    }
    fs.writeFileSync(
      resolveCookieStorePath(userDataDir),
      JSON.stringify({ savedAt: Date.now(), cookies }),
      { mode: 0o600 },
    );
    log.debug(`saved ${cookies.length} cookies for ${userDataDir}`);
  } catch (err) {
    log.debug(`cookie save skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Restore the saved cookie jar over CDP. Best-effort no-op when missing/empty. */
export async function restoreManagedChromeCookies(
  wsUrl: string,
  userDataDir: string,
): Promise<void> {
  try {
    const file = resolveCookieStorePath(userDataDir);
    if (!fs.existsSync(file)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      cookies?: Record<string, unknown>[];
    };
    const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
    if (cookies.length === 0) {
      return;
    }
    // Storage.getCookies returns Cookie[]; Storage.setCookies accepts
    // CookieParam[]. Cookie is a superset (extra read-only fields are ignored),
    // so the snapshot round-trips back in directly. Browser-level target only.
    await withCdpSocket(wsUrl, (send) => send("Storage.setCookies", { cookies }), cdpOpts);
    log.debug(`restored ${cookies.length} cookies for ${userDataDir}`);
  } catch (err) {
    log.debug(`cookie restore skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Periodic flush so cookies survive an ungraceful death of the Chrome child —
 * a gateway restart (SIGUSR1 / update / crash) kills it without ever calling
 * stopOpenClawChrome. Caller clears the timer on graceful stop; unref() keeps
 * it from holding the gateway process open.
 */
export function startManagedChromeCookieFlush(wsUrl: string, userDataDir: string): NodeJS.Timeout {
  const timer = setInterval(() => {
    void saveManagedChromeCookies(wsUrl, userDataDir);
  }, COOKIE_FLUSH_INTERVAL_MS);
  timer.unref();
  return timer;
}
