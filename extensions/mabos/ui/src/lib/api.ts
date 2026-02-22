import type {
  SystemStatus,
  Business,
  AgentListResponse,
  AgentListItem,
  AgentDetail,
  Decision,
  DecisionResolution,
  Contractor,
  TroposGoalModel,
} from "./types";

const BASE = "/mabos/api";
const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  status: number;
  path: string;
  body: unknown;

  constructor(status: number, path: string, body: unknown) {
    super(`API ${status}: ${path}`);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => res.text().catch(() => null));
      throw new ApiError(res.status, path, body);
    }

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw new ApiError(res.status, path, `Non-JSON response: ${ct || "no content-type"}`);
    }

    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  // Status
  getStatus: () => get<SystemStatus>("/status"),

  // Businesses
  getBusinesses: () => get<{ businesses: Business[] }>("/businesses"),

  // Agents
  getAgents: (businessId: string) => get<AgentListResponse>(`/businesses/${businessId}/agents`),
  getAgent: (businessId: string, agentId: string) =>
    get<AgentListItem>(`/businesses/${businessId}/agents/${agentId}`),
  getAgentDetail: (agentId: string) => get<AgentDetail>(`/agents/${agentId}`),
  createAgent: (
    businessId: string,
    body: {
      id: string;
      name: string;
      type: "core" | "domain";
      autonomy_level: "low" | "medium" | "high";
      approval_threshold_usd: number;
    },
  ) => post<{ ok: boolean }>(`/businesses/${businessId}/agents`, body),
  updateAgent: (businessId: string, agentId: string, body: Partial<AgentListItem>) =>
    post<{ ok: boolean }>(`/businesses/${businessId}/agents/${agentId}`, body),
  archiveAgent: (businessId: string, agentId: string) =>
    post<{ ok: boolean }>(`/businesses/${businessId}/agents/${agentId}/archive`, {}),

  // Tasks
  getTasks: (businessId: string) => get<{ tasks: unknown[] }>(`/businesses/${businessId}/tasks`),
  updateTask: (businessId: string, taskId: string, body: unknown) =>
    put<unknown>(`/businesses/${businessId}/tasks/${taskId}`, body),

  // Metrics
  getMetrics: (businessId: string) => get<unknown>(`/metrics/${businessId}`),

  // Goals
  getGoals: (businessId: string) => get<TroposGoalModel>(`/businesses/${businessId}/goals`),
  updateGoals: (businessId: string, body: TroposGoalModel) =>
    put<{ ok: boolean }>(`/businesses/${businessId}/goals`, body),

  // Decisions
  getDecisions: () => get<{ decisions: Decision[] }>("/decisions"),
  resolveDecision: (id: string, body: DecisionResolution) =>
    post<{ ok: boolean }>(`/decisions/${id}/resolve`, body),

  // Contractors
  getContractors: () => get<{ contractors: Contractor[] }>("/contractors"),

  // Campaigns
  getCampaigns: (businessId: string) => get<unknown[]>(`/businesses/${businessId}/campaigns`),

  // Onboarding
  onboard: (body: unknown) => post<unknown>("/onboard", body),

  // Chat
  sendChatMessage: (body: { agentId: string; message: string; businessId: string }) =>
    post<{ ok: boolean; messageId: string; message: string }>("/chat", body),

  // BDI
  triggerBdiCycle: (businessId: string, agentId: string) =>
    post<{ ok: boolean }>(`/bdi/cycle`, { businessId, agentId }),
};
