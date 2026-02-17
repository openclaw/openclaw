const BASE = "";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts?.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401) {
    window.location.hash = "#/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// Auth
export const login = (password: string) =>
  request<{ ok: boolean }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });

export const logout = () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });

export const getMe = () => request<{ authenticated: boolean }>("/api/auth/me");

// Instances
export type InstanceSummary = {
  id: string;
  name: string;
  gatewayUrl: string;
  bridgeUrl: string;
  containerId: string | null;
  createdAt: number;
};

export type InstanceDetail = InstanceSummary & {
  connections: {
    id: string;
    provider: string;
    externalId: string;
    externalName: string | null;
    connectedAt: number;
  }[];
};

export const listInstances = () => request<InstanceSummary[]>("/api/instances");

export const getInstance = (id: string) => request<InstanceDetail>(`/api/instances/${id}`);

export const createInstance = (body: {
  name: string;
  spawn?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  bridgeUrl?: string;
}) =>
  request<{ id: string; installUrl: string; containerId?: string; dashboardUrl?: string }>(
    "/api/instances",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

export const deleteInstance = (id: string) =>
  request<{ ok: boolean }>(`/api/instances/${id}`, { method: "DELETE" });

export const startInstance = (id: string) =>
  request<{ ok: boolean }>(`/api/instances/${id}/start`, { method: "POST" });

export const stopInstance = (id: string) =>
  request<{ ok: boolean }>(`/api/instances/${id}/stop`, { method: "POST" });

export const getInstanceLogs = (id: string, tail = 200) =>
  request<{ logs: string }>(`/api/instances/${id}/logs?tail=${tail}`);

export const getInstanceStatus = (id: string) =>
  request<{ status: string }>(`/api/instances/${id}/status`);

// Connections
export type ConnectionSummary = {
  id: string;
  instanceId: string;
  provider: string;
  externalId: string;
  externalName: string | null;
  connectedAt: number;
};

export const listConnections = () => request<ConnectionSummary[]>("/api/connections");

export const deleteConnection = (id: string) =>
  request<{ ok: boolean }>(`/api/connections/${id}`, { method: "DELETE" });

// Events
export type EventLogEntry = {
  id: number;
  instanceId: string | null;
  connectionId: string | null;
  provider: string;
  externalId: string | null;
  eventType: string;
  status: string;
  responseStatus: number | null;
  latencyMs: number | null;
  createdAt: number;
};

export const listEvents = (params?: {
  instance_id?: string;
  provider?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) => {
  const qs = new URLSearchParams();
  if (params?.instance_id) {
    qs.set("instance_id", params.instance_id);
  }
  if (params?.provider) {
    qs.set("provider", params.provider);
  }
  if (params?.status) {
    qs.set("status", params.status);
  }
  if (params?.limit) {
    qs.set("limit", String(params.limit));
  }
  if (params?.offset) {
    qs.set("offset", String(params.offset));
  }
  const query = qs.toString();
  return request<{ events: EventLogEntry[]; total: number }>(
    `/api/events${query ? `?${query}` : ""}`,
  );
};
