import type { BpmnWorkflow, BpmnValidationError } from "./bpmn-types";
import type {
  SystemStatus,
  Business,
  AgentListResponse,
  AgentListItem,
  AgentDetail,
  AgentFileInfo,
  AgentFileContent,
  Decision,
  DecisionResolution,
  Contractor,
  TroposGoalModel,
  CronJob,
  CronJobsResponse,
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

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
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

  // Agent Files
  getAgentFiles: (agentId: string) => get<{ files: AgentFileInfo[] }>(`/agents/${agentId}/files`),
  getAgentFile: (agentId: string, filename: string) =>
    get<AgentFileContent>(`/agents/${agentId}/files/${encodeURIComponent(filename)}`),
  updateAgentFile: (agentId: string, filename: string, content: string) =>
    put<{ ok: boolean }>(`/agents/${agentId}/files/${encodeURIComponent(filename)}`, { content }),

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
  sendChatMessage: (body: {
    agentId: string;
    message: string;
    businessId: string;
    pageContext?: { page: string; capabilities: string[] };
  }) => post<{ ok: boolean; messageId: string; message: string }>("/chat", body),

  // BDI
  triggerBdiCycle: (businessId: string, agentId: string) =>
    post<{ ok: boolean }>(`/bdi/cycle`, { businessId, agentId }),

  // Cron Jobs
  getCronJobs: (businessId: string) => get<CronJobsResponse>(`/businesses/${businessId}/cron`),
  getCronJobsByWorkflow: (businessId: string, workflowId: string) =>
    get<CronJobsResponse>(`/businesses/${businessId}/cron?workflowId=${workflowId}`),
  createCronJob: (
    businessId: string,
    body: {
      name: string;
      schedule: string;
      agentId: string;
      action: string;
      enabled?: boolean;
      workflowId?: string;
      stepId?: string;
    },
  ) => post<{ ok: boolean; job: CronJob }>(`/businesses/${businessId}/cron`, body),
  updateCronJob: (businessId: string, jobId: string, body: Partial<CronJob>) =>
    put<{ ok: boolean; job: CronJob }>(`/businesses/${businessId}/cron/${jobId}`, body),

  // BPMN Workflows
  getWorkflows: (params?: { status?: string; agentId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.agentId) qs.set("agentId", params.agentId);
    const q = qs.toString();
    return get<{ workflows: BpmnWorkflow[] }>(`/workflows${q ? `?${q}` : ""}`);
  },
  getWorkflow: (id: string) => get<BpmnWorkflow>(`/workflows/${id}`),
  createWorkflow: (body: {
    name: string;
    description?: string;
    goalId?: string;
    agentId?: string;
    status?: string;
  }) => post<{ ok: boolean; id: string }>("/workflows", body),
  updateWorkflow: (id: string, body: { name?: string; status?: string; description?: string }) =>
    put<{ ok: boolean }>(`/workflows/${id}`, body),
  deleteWorkflow: (id: string) => del<{ ok: boolean }>(`/workflows/${id}`),

  // BPMN Elements
  addElement: (workflowId: string, body: Record<string, unknown>) =>
    post<{ ok: boolean; id: string }>(`/workflows/${workflowId}/elements`, body),
  updateElement: (workflowId: string, elementId: string, body: Record<string, unknown>) =>
    put<{ ok: boolean }>(`/workflows/${workflowId}/elements/${elementId}`, body),
  updateElementPosition: (
    workflowId: string,
    elementId: string,
    position: { x: number; y: number },
  ) => patch<{ ok: boolean }>(`/workflows/${workflowId}/elements/${elementId}`, { position }),
  deleteElement: (workflowId: string, elementId: string) =>
    del<{ ok: boolean }>(`/workflows/${workflowId}/elements/${elementId}`),

  // BPMN Flows
  addFlow: (workflowId: string, body: { sourceId: string; targetId: string; type?: string }) =>
    post<{ ok: boolean; id: string }>(`/workflows/${workflowId}/flows`, body),
  deleteFlow: (workflowId: string, flowId: string) =>
    del<{ ok: boolean }>(`/workflows/${workflowId}/flows/${flowId}`),

  // BPMN Pools/Lanes
  addPool: (workflowId: string, body: { name: string }) =>
    post<{ ok: boolean; id: string }>(`/workflows/${workflowId}/pools`, body),
  addLane: (workflowId: string, body: { poolId: string; name: string; assignee?: string }) =>
    post<{ ok: boolean; id: string }>(`/workflows/${workflowId}/lanes`, body),

  // BPMN Validation
  validateWorkflow: (workflowId: string) =>
    post<{ valid: boolean; errors: BpmnValidationError[] }>(
      `/workflows/${workflowId}/validate`,
      {},
    ),
};
