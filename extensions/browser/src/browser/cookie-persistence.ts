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

/** Delete the managed Chrome cookie sidecar, if present. */
export function deleteManagedChromeCookieStore(userDataDir: string): void {
  fs.rmSync(resolveCookieStorePath(userDataDir), { force: true });
}

function writeRestrictiveCookieStore(file: string, payload: string): void {
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tempFile, payload, { mode: 0o600 });
    fs.renameSync(tempFile, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

function normalizeSavedCookieParam(
  cookie: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
    return null;
  }

  const normalized: Record<string, unknown> = {
    name: cookie.name,
    value: cookie.value,
  };
  for (const key of [
    "domain",
    "path",
    "secure",
    "httpOnly",
    "sameSite",
    "priority",
    "sameParty",
    "sourceScheme",
    "sourcePort",
    "partitionKey",
  ]) {
    if (cookie[key] !== undefined) {
      normalized[key] = cookie[key];
    }
  }

  if (
    typeof cookie.expires === "number" &&
    Number.isFinite(cookie.expires) &&
    cookie.expires >= 0
  ) {
    normalized.expires = cookie.expires;
  }

  return normalized;
}

/**
 * Snapshot all cookies over CDP into the sidecar (0600). A successful empty
 * result clears the sidecar so logout / cookie clearing is not undone later.
 */
export async function saveManagedChromeCookies(wsUrl: string, userDataDir: string): Promise<void> {
  try {
    // Storage.getCookies works on the browser-level CDP target (default
    // browser context). Network.getAllCookies is page-session only and is not
    // exposed here, so it must not be used.
    const res = (await withCdpSocket(wsUrl, (send) => send("Storage.getCookies"), cdpOpts)) as {
      cookies?: unknown[];
    };
    if (!Array.isArray(res?.cookies)) {
      return;
    }
    const cookies = res.cookies;
    const file = resolveCookieStorePath(userDataDir);
    if (cookies.length === 0) {
      deleteManagedChromeCookieStore(userDataDir);
      log.debug(`cleared saved cookies for ${userDataDir}`);
      return;
    }
    writeRestrictiveCookieStore(file, JSON.stringify({ savedAt: Date.now(), cookies }));
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
    // CookieParam[]. Session cookies are represented as expires=-1 in the
    // snapshot and must omit expires when restored.
    const cookieParams = cookies
      .map((cookie) => normalizeSavedCookieParam(cookie))
      .filter((cookie): cookie is Record<string, unknown> => cookie !== null);
    if (cookieParams.length === 0) {
      return;
    }
    await withCdpSocket(
      wsUrl,
      (send) => send("Storage.setCookies", { cookies: cookieParams }),
      cdpOpts,
    );
    log.debug(`restored ${cookieParams.length} cookies for ${userDataDir}`);
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
