import path from "node:path";
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk/health-tracker";

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const API_BASE = "https://api.prod.whoop.com/developer";

const SCOPES = [
  "read:recovery",
  "read:sleep",
  "read:workout",
  "read:cycles",
  "read:profile",
  "offline",
];

export type WhoopTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

export type WhoopConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type WhoopSleepScore = {
  stageSummary?: {
    totalInBedTimeMilli?: number;
    totalAwakeTimeMilli?: number;
    totalNoDataTimeMilli?: number;
    totalLightSleepTimeMilli?: number;
    totalSlowWaveSleepTimeMilli?: number;
    totalRemSleepTimeMilli?: number;
    sleepCycleCount?: number;
    disturbanceCount?: number;
  };
  sleepNeeded?: {
    baselineMilli?: number;
    needFromSleepDebtMilli?: number;
    needFromRecentStrainMilli?: number;
    needFromRecentNapMilli?: number;
  };
  respiratoryRate?: number;
  sleepPerformancePercentage?: number;
  sleepConsistencyPercentage?: number;
  sleepEfficiencyPercentage?: number;
};

export type WhoopSleep = {
  id: number;
  user_id: number;
  start: string;
  end: string;
  nap: boolean;
  score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  score?: WhoopSleepScore;
};

export type WhoopRecoveryScore = {
  user_calibrating: boolean;
  recovery_score: number;
  resting_heart_rate: number;
  hrv_rmssd_milli: number;
  spo2_percentage?: number;
  skin_temp_celsius?: number;
};

export type WhoopRecovery = {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  score?: WhoopRecoveryScore;
};

export type WhoopCycle = {
  id: number;
  user_id: number;
  start: string;
  end?: string;
  score_state: string;
  score?: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  };
};

export class WhoopClient {
  private tokensPath: string;
  private configPath: string;

  constructor(private readonly baseDir: string) {
    this.tokensPath = path.join(baseDir, "whoop-tokens.json");
    this.configPath = path.join(baseDir, "whoop-config.json");
  }

  // --- config ---

  async getConfig(): Promise<WhoopConfig | null> {
    const { value, exists } = await readJsonFileWithFallback<WhoopConfig | null>(
      this.configPath,
      null,
    );
    return exists ? value : null;
  }

  async saveConfig(config: WhoopConfig): Promise<void> {
    await writeJsonFileAtomically(this.configPath, config);
  }

  // --- tokens ---

  async getTokens(): Promise<WhoopTokens | null> {
    const { value, exists } = await readJsonFileWithFallback<WhoopTokens | null>(
      this.tokensPath,
      null,
    );
    return exists ? value : null;
  }

  async saveTokens(tokens: WhoopTokens): Promise<void> {
    await writeJsonFileAtomically(this.tokensPath, tokens);
  }

  /** Build the OAuth authorization URL that the user opens in their browser. */
  async buildAuthUrl(state: string): Promise<string | null> {
    const config = await this.getConfig();
    if (!config) return null;

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(code: string): Promise<WhoopTokens | null> {
    const config = await this.getConfig();
    if (!config) return null;

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };

    const tokens: WhoopTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };

    await this.saveTokens(tokens);
    return tokens;
  }

  /** Refresh the access token using the stored refresh token. */
  private async refreshAccessToken(): Promise<WhoopTokens | null> {
    const config = await this.getConfig();
    const tokens = await this.getTokens();
    if (!config || !tokens) return null;

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "offline",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };

    const newTokens: WhoopTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };

    await this.saveTokens(newTokens);
    return newTokens;
  }

  /** Get a valid access token, refreshing if needed. */
  private async getValidToken(): Promise<string | null> {
    let tokens = await this.getTokens();
    if (!tokens) return null;

    // Refresh if token expires within 5 minutes
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      tokens = await this.refreshAccessToken();
      if (!tokens) return null;
    }

    return tokens.accessToken;
  }

  /** Make an authenticated API request. */
  private async apiGet<T>(endpoint: string, params?: Record<string, string>): Promise<T | null> {
    const token = await this.getValidToken();
    if (!token) return null;

    const url = new URL(`${API_BASE}${endpoint}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return null;
    return (await resp.json()) as T;
  }

  // --- data endpoints ---

  async isConnected(): Promise<boolean> {
    const tokens = await this.getTokens();
    return tokens != null;
  }

  async getSleepCollection(
    limit = 5,
    startDate?: string,
    endDate?: string,
  ): Promise<WhoopSleep[] | null> {
    const params: Record<string, string> = { limit: String(limit) };
    if (startDate) params.start = `${startDate}T00:00:00.000Z`;
    if (endDate) params.end = `${endDate}T23:59:59.999Z`;

    const data = await this.apiGet<{ records: WhoopSleep[] }>("/v1/activity/sleep", params);
    return data?.records ?? null;
  }

  async getRecoveryCollection(
    limit = 5,
    startDate?: string,
    endDate?: string,
  ): Promise<WhoopRecovery[] | null> {
    const params: Record<string, string> = { limit: String(limit) };
    if (startDate) params.start = `${startDate}T00:00:00.000Z`;
    if (endDate) params.end = `${endDate}T23:59:59.999Z`;

    const data = await this.apiGet<{ records: WhoopRecovery[] }>("/v1/recovery", params);
    return data?.records ?? null;
  }

  async getCycleCollection(
    limit = 5,
    startDate?: string,
    endDate?: string,
  ): Promise<WhoopCycle[] | null> {
    const params: Record<string, string> = { limit: String(limit) };
    if (startDate) params.start = `${startDate}T00:00:00.000Z`;
    if (endDate) params.end = `${endDate}T23:59:59.999Z`;

    const data = await this.apiGet<{ records: WhoopCycle[] }>("/v1/cycle", params);
    return data?.records ?? null;
  }
}
