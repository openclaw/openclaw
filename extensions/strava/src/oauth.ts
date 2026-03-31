import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StravaConfig, StravaTokens } from "./types.js";

const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";

/** Build the Strava OAuth authorization URL with a CSRF state nonce. */
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  scope = "activity:read_all",
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    approval_prompt: "force",
    state,
  });
  return `${STRAVA_AUTH_URL}?${params.toString()}`;
}

/** Generate a random state nonce for OAuth CSRF protection. */
export function generateOAuthState(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(config: StravaConfig, code: string): Promise<StravaTokens> {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava token exchange failed (${res.status}): ${text}`);
  }

  // Parse as text first so we can extract athlete.id as a raw string before
  // JSON.parse coerces it to a float64 (which would lose precision for IDs > 2^53-1).
  const body = await res.text();
  const data = JSON.parse(body) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete: { id: unknown };
  };
  const idMatch = /"athlete"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/.exec(body);
  const athleteId = idMatch ? idMatch[1] : String(data.athlete.id);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    athleteId,
  };
}

/** Error from a token refresh attempt, with HTTP status for triage. */
export class StravaRefreshError extends Error {
  status = 0;
}

/** Refresh an expired access token. Returns new token pair (refresh token rotates). */
export async function refreshTokens(
  config: StravaConfig,
  refreshToken: string,
): Promise<StravaTokens> {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new StravaRefreshError(`Strava token refresh failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };

  // Refresh response doesn't include athlete — we'll preserve the existing athleteId in the store.
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    athleteId: "", // caller must merge with existing athleteId
  };
}

const TOKEN_FILE = "strava-tokens.json";
const STATE_FILE = "oauth-state.json";

function writeOwnerOnlyJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  // `mode` only applies on create; chmod existing files too so retries/upgrades
  // do not preserve broader permissions from an older write.
  fs.chmodSync(filePath, 0o600);
}

/** Persistent token store backed by a JSON file. */
export class TokenStore {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = stateDir;
  }

  private filePath(): string {
    return path.join(this.dir, TOKEN_FILE);
  }

  private statePath(): string {
    return path.join(this.dir, STATE_FILE);
  }

  save(tokens: StravaTokens): void {
    fs.mkdirSync(this.dir, { recursive: true });
    writeOwnerOnlyJson(this.filePath(), tokens);
  }

  load(): StravaTokens | null {
    try {
      const raw = fs.readFileSync(this.filePath(), "utf-8");
      return JSON.parse(raw) as StravaTokens;
    } catch {
      return null;
    }
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath());
    } catch {
      // already gone
    }
  }

  /** Store an OAuth state nonce for CSRF validation. Keeps the last 5 nonces so
   *  multiple auth URLs can be valid concurrently (e.g. agent asks twice, user
   *  opens a second tab). */
  saveState(state: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const existing = this.loadStates();
    // Keep most recent 4 + the new one = 5 max.
    const states = [...existing.slice(-4), state];
    writeOwnerOnlyJson(this.statePath(), { states });
  }

  /** Check if a state nonce is valid and consume it. Returns true if matched. */
  consumeState(state: string): boolean {
    const states = this.loadStates();
    const idx = states.indexOf(state);
    if (idx === -1) return false;
    states.splice(idx, 1);
    try {
      if (states.length === 0) {
        fs.unlinkSync(this.statePath());
      } else {
        writeOwnerOnlyJson(this.statePath(), { states });
      }
    } catch {
      // best-effort cleanup
    }
    return true;
  }

  private loadStates(): string[] {
    try {
      const raw = fs.readFileSync(this.statePath(), "utf-8");
      const data = JSON.parse(raw) as { state?: string; states?: string[] };
      // Handle legacy single-state format gracefully.
      if (data.states) return [...data.states];
      if (data.state) return [data.state];
      return [];
    } catch {
      return [];
    }
  }
}

/** Margin in seconds before expiry to trigger a proactive refresh. */
const REFRESH_MARGIN_SEC = 300; // 5 minutes

/**
 * Return a valid access token, refreshing if needed.
 * Returns null if no tokens are stored (user hasn't connected).
 */
export async function ensureFreshToken(
  store: TokenStore,
  config: StravaConfig,
): Promise<string | null> {
  const tokens = store.load();
  if (!tokens) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (tokens.expiresAt - nowSec > REFRESH_MARGIN_SEC) {
    return tokens.accessToken;
  }

  // Token expired or about to — refresh it.
  const refreshed = await refreshTokens(config, tokens.refreshToken);
  const updated: StravaTokens = {
    ...refreshed,
    athleteId: tokens.athleteId, // preserve athlete ID
  };
  store.save(updated);
  return updated.accessToken;
}
