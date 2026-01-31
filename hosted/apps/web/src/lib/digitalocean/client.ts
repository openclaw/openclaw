/**
 * DigitalOcean App Platform API Client
 * Used to provision and manage OpenClaw containers for users
 */

const DO_API_BASE = "https://api.digitalocean.com/v2";

interface AppSpec {
  name: string;
  region: string;
  services: ServiceSpec[];
}

interface ServiceSpec {
  name: string;
  image: {
    registry_type: "DOCR";
    registry: string;
    repository: string;
    tag: string;
  };
  instance_count: number;
  instance_size_slug: string;
  http_port: number;
  run_command?: string;
  envs: { key: string; value: string; type?: string }[];
  health_check?: {
    http_path: string;
    initial_delay_seconds: number;
    period_seconds: number;
  };
}

interface CreateAppResponse {
  app: {
    id: string;
    default_ingress: string;
    live_url: string;
    created_at: string;
    updated_at: string;
  };
}

interface GetAppResponse {
  app: {
    id: string;
    default_ingress: string;
    live_url: string;
    active_deployment?: {
      phase: string; // PENDING_BUILD, BUILDING, PENDING_DEPLOY, DEPLOYING, ACTIVE, ERROR
    };
  };
}

export class DigitalOceanClient {
  private token: string;
  private registryName: string;

  constructor(token: string, registryName: string) {
    this.token = token;
    this.registryName = registryName;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${DO_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DigitalOcean API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * Create a new App Platform app for a user
   */
  async createApp(params: {
    userId: string;
    instanceId: string;
    gatewayToken: string;
    anthropicApiKey: string;
  }): Promise<{ appId: string; url: string }> {
    const appName = `openclaw-${params.instanceId.slice(0, 8)}`;

    const spec: AppSpec = {
      name: appName,
      region: "sfo", // San Francisco, same as your registry
      services: [
        {
          name: "gateway",
          image: {
            registry_type: "DOCR",
            registry: this.registryName,
            repository: "openclaw",
            tag: "latest",
          },
          instance_count: 1,
          instance_size_slug: "basic-s", // 1 vCPU, 2GB RAM, $20/mo (1GB still crashed)
          http_port: 8080,
          // Config is baked into Docker image at /app/hosted-config.json
          // Enables: chat completions API, disables device pairing (token auth only)
          run_command: "node dist/index.js gateway --port 8080 --bind lan --allow-unconfigured",
          envs: [
            { key: "PORT", value: "8080" },
            { key: "NODE_ENV", value: "production" },
            { key: "OPENCLAW_GATEWAY_TOKEN", value: params.gatewayToken, type: "SECRET" },
            { key: "ANTHROPIC_API_KEY", value: params.anthropicApiKey, type: "SECRET" },
            { key: "OPENCLAW_STATE_DIR", value: "/tmp/.openclaw" },
            { key: "OPENCLAW_CONFIG_PATH", value: "/app/hosted-config.json" },
          ],
          // Note: Gateway uses WebSocket, so we use TCP health check
          // DO App Platform will check if port 8080 is accepting connections
        },
      ],
    };

    const response = await this.request<CreateAppResponse>("POST", "/apps", {
      spec,
    });

    return {
      appId: response.app.id,
      url: response.app.default_ingress || response.app.live_url,
    };
  }

  /**
   * Get app status
   */
  async getApp(appId: string): Promise<{
    id: string;
    url: string;
    status: "pending" | "deploying" | "running" | "error";
  }> {
    const response = await this.request<GetAppResponse>("GET", `/apps/${appId}`);

    let status: "pending" | "deploying" | "running" | "error" = "pending";
    const phase = response.app.active_deployment?.phase;

    if (phase === "ACTIVE") {
      status = "running";
    } else if (phase === "ERROR") {
      status = "error";
    } else if (phase === "DEPLOYING" || phase === "PENDING_DEPLOY") {
      status = "deploying";
    }

    return {
      id: response.app.id,
      url: response.app.live_url || response.app.default_ingress,
      status,
    };
  }

  /**
   * Delete an app
   */
  async deleteApp(appId: string): Promise<void> {
    await this.request("DELETE", `/apps/${appId}`);
  }

  /**
   * List all apps (for debugging)
   */
  async listApps(): Promise<{ id: string; name: string; live_url: string }[]> {
    const response = await this.request<{ apps: any[] }>("GET", "/apps");
    return response.apps.map((app) => ({
      id: app.id,
      name: app.spec?.name || "unknown",
      live_url: app.live_url,
    }));
  }
}

// Singleton instance
let client: DigitalOceanClient | null = null;

export function getDigitalOceanClient(): DigitalOceanClient {
  if (!client) {
    const token = process.env.DO_API_TOKEN;
    const registryName = process.env.DO_REGISTRY_NAME;

    if (!token || !registryName) {
      throw new Error("DO_API_TOKEN and DO_REGISTRY_NAME must be set");
    }

    client = new DigitalOceanClient(token, registryName);
  }
  return client;
}
