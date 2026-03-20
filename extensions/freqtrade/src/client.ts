/**
 * Freqtrade REST API client.
 *
 * Wraps freqtrade's REST API (default port 8080) with JWT auth.
 * See: https://www.freqtrade.io/en/stable/rest-api/
 */

export interface FreqtradeConfig {
  apiUrl: string;
  username: string;
  password: string;
}

export class FreqtradeClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(config: FreqtradeConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
  }

  private async authenticate(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiry) return;

    const resp = await fetch(`${this.baseUrl}/api/v1/token/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Freqtrade auth failed (${resp.status}): ${await resp.text()}`);
    }

    const data = (await resp.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error("Freqtrade auth: no access_token in response");
    }
    this.token = data.access_token;
    // Tokens typically expire in 15 min; refresh at 10 min
    this.tokenExpiry = Date.now() + 10 * 60 * 1000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.authenticate();

    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const resp = await fetch(`${this.baseUrl}${path}`, opts);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Freqtrade API error (${resp.status}): ${text}`);
    }
    return (await resp.json()) as T;
  }

  async getStatus(): Promise<unknown> {
    return this.request("GET", "/api/v1/status");
  }

  async getBalance(): Promise<unknown> {
    return this.request("GET", "/api/v1/balance");
  }

  async getTrades(limit = 50): Promise<unknown> {
    return this.request("GET", `/api/v1/trades?limit=${limit}`);
  }

  async getPerformance(): Promise<unknown> {
    return this.request("GET", "/api/v1/performance");
  }

  async getStrategies(): Promise<unknown> {
    return this.request("GET", "/api/v1/strategies");
  }

  async forceBuy(pair: string, price?: number): Promise<unknown> {
    const body: Record<string, unknown> = { pair };
    if (price !== undefined) body.price = price;
    return this.request("POST", "/api/v1/forcebuy", body);
  }

  async forceSell(tradeId: number): Promise<unknown> {
    return this.request("POST", "/api/v1/forcesell", { tradeid: tradeId });
  }

  async runBacktest(strategy: string, timerange: string): Promise<unknown> {
    return this.request("POST", "/api/v1/backtest", { strategy, timerange });
  }

  async getBacktestResult(): Promise<unknown> {
    return this.request("GET", "/api/v1/backtest");
  }
}
