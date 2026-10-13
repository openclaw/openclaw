// Minimal Hetzner Cloud API client (fetch-based, no extra dependency).
// Covers server create / get / delete + firewall attach for OP-167.

export type HetznerServerType = string;

export type HetznerCreateServerParams = {
  name: string;
  serverType: string;
  location: string;
  image: string;
  sshKeys: string[];
  userData: string;
  labels?: Record<string, string>;
  firewallIds?: number[];
};

export type HetznerServer = {
  id: number;
  name: string;
  status: string;
  publicIpv4: string | undefined;
};

export type HetznerFetch = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE = "https://api.hetzner.cloud/v1";

function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export function createHetznerClient(params: {
  token: string;
  baseUrl?: string;
  fetchImpl?: HetznerFetch;
}) {
  const base = (params.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const doFetch: HetznerFetch = params.fetchImpl ?? defaultFetch;
  const headers = {
    Authorization: `Bearer ${params.token}`,
    "Content-Type": "application/json",
  };

  async function readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return text ? (JSON.parse(text) as unknown) : {};
    } catch {
      throw new Error(`Hetzner API non-JSON response (HTTP ${res.status})`);
    }
  }

  return {
    async createServer(input: HetznerCreateServerParams): Promise<HetznerServer> {
      const res = await doFetch(`${base}/servers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: input.name,
          server_type: input.serverType,
          location: input.location,
          image: input.image,
          ssh_keys: input.sshKeys,
          user_data: input.userData,
          labels: input.labels ?? { managed_by: "openclaw-manager-bot" },
          ...(input.firewallIds?.length
            ? { firewalls: input.firewallIds.map((id) => ({ firewall: id })) }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Hetzner createServer failed (HTTP ${res.status}): ${body.slice(0, 500)}`);
      }
      const json = (await readJson(res)) as {
        server?: {
          id: number;
          name: string;
          status: string;
          public_net?: { ipv4?: { ip?: string } };
        };
      };
      if (!json.server) {
        throw new Error("Hetzner createServer: missing server in response");
      }
      return {
        id: json.server.id,
        name: json.server.name,
        status: json.server.status,
        publicIpv4: json.server.public_net?.ipv4?.ip,
      };
    },

    async getServer(id: number): Promise<HetznerServer> {
      const res = await doFetch(`${base}/servers/${id}`, { headers });
      if (!res.ok) {
        throw new Error(`Hetzner getServer failed (HTTP ${res.status})`);
      }
      const json = (await readJson(res)) as {
        server?: {
          id: number;
          name: string;
          status: string;
          public_net?: { ipv4?: { ip?: string } };
        };
      };
      if (!json.server) {
        throw new Error("Hetzner getServer: missing server in response");
      }
      return {
        id: json.server.id,
        name: json.server.name,
        status: json.server.status,
        publicIpv4: json.server.public_net?.ipv4?.ip,
      };
    },

    async deleteServer(id: number): Promise<void> {
      const res = await doFetch(`${base}/servers/${id}`, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Hetzner deleteServer failed (HTTP ${res.status})`);
      }
    },
  };
}

export type HetznerClient = ReturnType<typeof createHetznerClient>;
