/**
 * REST client for MABOS gateway API.
 * Used by the unified SPA to call /mabos/api/* endpoints.
 */

export interface GatewayClientConfig {
  baseUrl?: string;
  token?: string;
}

export class GatewayRestClient {
  private baseUrl: string;
  private token: string | null;

  constructor(config?: GatewayClientConfig) {
    this.baseUrl = config?.baseUrl ?? "";
    this.token = config?.token ?? null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`GET ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`POST ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`PATCH ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`DELETE ${path}: ${res.status} ${res.statusText}`);
    }
  }
}
