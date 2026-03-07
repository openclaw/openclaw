/**
 * API client for the Command Center backend.
 *
 * All endpoints are served by FastAPI at /admin/cc/* and proxied
 * by Vite in dev mode.
 */

const TOKEN_KEY = "openclaw_admin_token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "X-Admin-Token": getToken(),
    ...(init?.headers as Record<string, string>),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── Panel data ──

export interface PanelData {
  ok: boolean;
  today: TodayData;
  health: HealthData;
  schedule: ScheduleData;
  approvals: ApprovalsData;
  ts: string;
}

export interface BrandInfo {
  kpi_line: string;
  trend_color: string;
  goal_chip: string;
}

export interface OverdueItem {
  title: string;
  brand: string;
}

export interface FocusEvent {
  time: string;
  title: string;
  brand: string;
  source: string;
  conflict?: boolean;
}

export interface TodayData {
  brands: {
    fulldigital: BrandInfo;
    cutmv: BrandInfo;
  };
  schedule: unknown[];
  next_up: unknown[];
  overdue_count: number;
  overdue_list: OverdueItem[];
  focus: {
    up_next: FocusEvent[];
    deadlines: FocusEvent[];
    focus_hours: number;
  };
  last_sync: Record<string, unknown>;
  error?: string;
}

export interface HealthData {
  warnings: string[];
  cooldown: { active: boolean };
  queue: { scheduled_actions_pending: number | null };
  notion_compliance_status: Record<string, unknown>;
  command_center_compliance: Record<string, unknown>;
  webops: { last_success_ts: string | null };
  error?: string;
}

export interface ScheduleData {
  last_runs: Record<string, unknown>;
  event_counts: {
    total_active: number;
    by_source: Record<string, number>;
    conflicts: number;
  };
  error?: string;
}

export interface ApprovalItem {
  id: number;
  action_type: string;
  description: string;
  created_at: string;
}

export interface ApprovalsData {
  pending_count: number;
  items: ApprovalItem[];
  error?: string;
}

export async function fetchPanels(): Promise<PanelData> {
  return fetchJSON<PanelData>("/admin/cc/panels");
}

// ── Prompt ──

export interface PromptResponse {
  ok: boolean;
  reply: string;
  conversation_id: string;
  intent?: {
    type: string;
    confidence: number;
    brand: string;
  };
}

export async function submitPrompt(text: string, brandHint?: string): Promise<PromptResponse> {
  return fetchJSON<PromptResponse>("/admin/cc/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, brand_hint: brandHint }),
  });
}

// ── Guide ──

export interface PanelHelpInfo {
  title: string;
  description: string;
  actions: string[];
  prompts: string[];
  approval_note: string;
}

export async function fetchGuide(): Promise<Record<string, PanelHelpInfo>> {
  const res = await fetchJSON<{ ok: boolean; panels: Record<string, PanelHelpInfo> }>(
    "/admin/cc/guide/panels",
  );
  return res.panels;
}

export interface WalkthroughStep {
  title: string;
  body: string;
  spotlight: string | null;
  tip: string;
  cta: string;
}

export async function fetchWalkthrough(): Promise<WalkthroughStep[]> {
  const res = await fetchJSON<{ ok: boolean; steps: WalkthroughStep[] }>(
    "/admin/cc/guide/walkthrough",
  );
  return res.steps;
}

export interface PromptBarConfig {
  placeholder: string;
  suggestions: string[];
  help_text: string;
}

export async function fetchPromptBarConfig(): Promise<PromptBarConfig> {
  const res = await fetchJSON<{ ok: boolean } & PromptBarConfig>("/admin/cc/guide/prompt-bar");
  return {
    placeholder: res.placeholder,
    suggestions: res.suggestions,
    help_text: res.help_text,
  };
}

// ── Actions ──

export async function startTheDay(): Promise<Record<string, unknown>> {
  return fetchJSON<Record<string, unknown>>("/admin/today/start_day", {
    method: "POST",
  });
}
