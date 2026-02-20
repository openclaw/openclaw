const BASE = "/mabos/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

export const api = {
  getStatus: () => get<unknown>("/status"),
  getBusinesses: () => get<unknown[]>("/businesses"),
  getAgents: (businessId: string) =>
    get<unknown[]>(`/businesses/${businessId}/agents`),
  getAgent: (businessId: string, agentId: string) =>
    get<unknown>(`/businesses/${businessId}/agents/${agentId}`),
  getTasks: (businessId: string) =>
    get<unknown[]>(`/businesses/${businessId}/tasks`),
  updateTask: (businessId: string, taskId: string, body: unknown) =>
    put<unknown>(`/businesses/${businessId}/tasks/${taskId}`, body),
  getMetrics: (businessId: string) => get<unknown>(`/metrics/${businessId}`),
  getGoals: (businessId: string) =>
    get<unknown>(`/businesses/${businessId}/goals`),
  getDecisions: () => get<unknown[]>("/decisions"),
  resolveDecision: (id: string, body: unknown) =>
    post<unknown>(`/decisions/${id}/resolve`, body),
  getContractors: () => get<unknown[]>("/contractors"),
  getCampaigns: (businessId: string) =>
    get<unknown[]>(`/businesses/${businessId}/campaigns`),
  onboard: (body: unknown) => post<unknown>("/onboard", body),
};
