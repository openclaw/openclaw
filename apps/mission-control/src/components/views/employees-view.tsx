"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users,
  Plus,
  RefreshCw,
  Building2,
  Shield,
  KeyRound,
  TrendingUp,
  Zap,
  ChevronRight,
  Search,
  Clock,
  Play,
  Pause,
  LayoutTemplate,
  Sparkles,
  Star,
  X,
  GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

// Reuse types already in the dashboard.
import type { Task, ActivityEntry, Agent } from "@/lib/hooks/use-tasks";
import { suggestAgentForTask, SPECIALIZED_AGENTS } from "@/lib/agent-registry";
import {
  loadCommunityUsecaseFavorites,
  saveCommunityUsecaseFavorites,
  toggleCommunityUsecaseFavorite,
} from "@/lib/community-usecase-favorites";

export type EmployeeDepartment =
  | "operations"
  | "sales"
  | "marketing"
  | "finance"
  | "compliance"
  | "engineering"
  | "other";

export interface Employee {
  id: string;
  name: string;
  role_key: string;
  department: EmployeeDepartment;
  status: "active" | "paused" | "archived";
  description: string;
  manager_id: string | null;
  sort_order: number;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

interface EmployeeAccountAccessSummary {
  accountCount: number;
  executeCount: number;
  draftCount: number;
  readCount: number;
}

interface EmployeesApiResponse {
  employees: Employee[];
  accessSummary?: Record<string, EmployeeAccountAccessSummary>;
  error?: string;
}

interface EmployeeHierarchyResponse {
  employees: Employee[];
  roots: string[];
  children: Record<string, string[]>;
}

interface EmployeeSeedResponse {
  ok?: boolean;
  seeded?: boolean;
  createdEmployees?: number;
  createdSchedules?: number;
  employees?: Employee[];
  error?: string;
}

interface EmployeeSchedule {
  id: string;
  employee_id: string;
  title: string;
  description: string;
  cron_expression: string;
  timezone: string;
  agent_id: string;
  priority: string;
  category: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

interface AccountRecord {
  id: string;
  service: string;
  label: string;
  region?: string | null;
  notes?: string;
}

interface EmployeeAccessRecord {
  account_id: string;
  mode: "read" | "draft" | "execute";
  requires_approval: number;
  service: string;
  label: string;
  region?: string | null;
}

interface CommunityUsecaseTemplate {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  rating: number;
  tags: string[];
  url?: string;
  source?: string;
  sourceDetail?: string;
}

interface CommunityUsecasesResponse {
  usecases?: CommunityUsecaseTemplate[];
  total?: number;
  error?: string;
}

interface EmployeeBlueprint {
  key: string;
  name: string;
  role_key: string;
  department: EmployeeDepartment;
  description: string;
  manager_role_key?: string;
}

const EMPLOYEE_BLUEPRINTS: EmployeeBlueprint[] = [
  {
    key: "staff_manager",
    name: "Staff Manager",
    role_key: "staff_manager",
    department: "operations",
    description:
      "Runs the AI office. Breaks objectives into tasks, assigns employees, monitors blockers, escalates for approvals.",
  },
  {
    key: "sales_dev_rep",
    name: "Sales Development Rep",
    role_key: "sales_dev_rep",
    department: "sales",
    manager_role_key: "sales_manager",
    description:
      "Drives lead follow-ups, pipeline reviews, and monthly outreach campaigns.",
  },
  {
    key: "social_media_manager",
    name: "Social Media Manager",
    role_key: "social_media_manager",
    department: "marketing",
    manager_role_key: "marketing_manager",
    description:
      "Manages daily engagement, content calendars, and monthly analytics across social channels.",
  },
  {
    key: "financial_analyst",
    name: "Financial Analyst",
    role_key: "financial_analyst",
    department: "finance",
    manager_role_key: "finance_compliance_manager",
    description:
      "Handles expense reconciliation, weekly P&L summaries, and recurring compliance checks.",
  },
  {
    key: "operations_coordinator",
    name: "Operations Coordinator",
    role_key: "operations_coordinator",
    department: "operations",
    manager_role_key: "staff_manager",
    description:
      "Runs daily health checks, weekly standup summaries, and monthly KPI dashboards.",
  },
  {
    key: "zatca_manager",
    name: "ZATCA Manager",
    role_key: "zatca_manager",
    department: "compliance",
    manager_role_key: "finance_compliance_manager",
    description:
      "Owns ZATCA e-invoicing compliance checks, filing prep, and audit pack quality.",
  },
  {
    key: "swarm_manager",
    name: "Swarm Manager",
    role_key: "swarm_manager",
    department: "operations",
    description:
      "Coordinates auditors, monitors, fixers, and documentors to keep delivery and quality in sync.",
  },
  {
    key: "audit_manager",
    name: "Audit Manager",
    role_key: "audit_manager",
    department: "compliance",
    manager_role_key: "swarm_manager",
    description:
      "Leads audit workflows for regressions, risk checks, and release-readiness reviews.",
  },
  {
    key: "monitor_manager",
    name: "Monitor Manager",
    role_key: "monitor_manager",
    department: "operations",
    manager_role_key: "swarm_manager",
    description:
      "Leads runtime and performance monitoring to detect issues quickly and route remediation.",
  },
  {
    key: "fixer_manager",
    name: "Fixer Manager",
    role_key: "fixer_manager",
    department: "engineering",
    manager_role_key: "swarm_manager",
    description:
      "Leads execution of bug fixes and reliability improvements with clear ownership and priority.",
  },
  {
    key: "documentor_manager",
    name: "Documentor Manager",
    role_key: "documentor_manager",
    department: "operations",
    manager_role_key: "swarm_manager",
    description:
      "Leads changelogs, runbooks, and evidence trails so every change remains traceable.",
  },
];

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (dom !== "*" && dow === "*") {
    return `Monthly on day ${dom} at ${hour}:${min.padStart(2, "0")}`;
  }
  if (dow !== "*" && dom === "*") {
    const days: Record<string, string> = {
      "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed",
      "4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun",
      "1-5": "Mon-Fri",
    };
    return `${days[dow] || dow} at ${hour}:${min.padStart(2, "0")}`;
  }
  if (dom === "*" && dow === "*") {
    return `Daily at ${hour}:${min.padStart(2, "0")}`;
  }
  return cron;
}

type EmployeesViewMode = "grid" | "org";

function departmentColor(dept: EmployeeDepartment): string {
  switch (dept) {
    case "sales":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
    case "marketing":
      return "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20";
    case "finance":
      return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    case "compliance":
      return "bg-red-500/10 text-red-400 border-red-500/20";
    case "engineering":
      return "bg-cyan-500/10 text-cyan-400 border-cyan-500/20";
    case "operations":
      return "bg-sky-500/10 text-sky-400 border-sky-500/20";
    default:
      return "bg-slate-500/10 text-slate-300 border-slate-500/20";
  }
}

function statusBadge(status: Employee["status"]) {
  if (status === "active") {
    return <Badge className="bg-green-500/10 text-green-400 border border-green-500/20">Active</Badge>;
  }
  if (status === "paused") {
    return <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20">Paused</Badge>;
  }
  return <Badge className="bg-slate-500/10 text-slate-300 border border-slate-500/20">Archived</Badge>;
}

function taskCountsForEmployee(tasks: Task[], employeeId: string) {
  const own = tasks.filter((t) => t.employee_id === employeeId);
  const by = (status: string) => own.filter((t) => t.status === status).length;
  return {
    total: own.length,
    inbox: by("inbox"),
    inProgress: by("in_progress") + by("assigned"),
    review: by("review"),
    done: by("done"),
  };
}

function roleDelegationDirective(employee: Employee): string {
  const roleKey = employee.role_key.toLowerCase();
  if (roleKey.includes("audit")) {
    return "Audit recent and in-flight changes for correctness, security risk, and regression potential. Escalate high-risk findings with concrete reproduction steps.";
  }
  if (roleKey.includes("monitor")) {
    return "Monitor runtime and quality signals continuously. Identify anomalies early, quantify impact, and create clear incident summaries.";
  }
  if (roleKey.includes("fixer")) {
    return "Implement corrective changes with tests and safe rollout behavior. Prioritize high-impact issues first and document verification steps.";
  }
  if (roleKey.includes("documentor")) {
    return "Document outcomes, decisions, and operational runbooks. Ensure changes are traceable and handoff-ready for future responders.";
  }
  if (roleKey.includes("manager")) {
    return "Own team-level planning and delegation. Break work into actionable tasks for your reports, track execution, and report blockers quickly.";
  }
  return "Execute this objective for your function with clear outcomes, measurable progress, and concise status updates.";
}

function buildDelegationTaskDescription(params: {
  managerName: string;
  objectiveTitle: string;
  objectiveDescription: string;
  recipient: Employee;
  parentLeadName?: string;
}): string {
  const recipientDirective = roleDelegationDirective(params.recipient);
  return [
    `Delegated by manager: ${params.managerName}`,
    params.parentLeadName ? `Parent team lead: ${params.parentLeadName}` : "",
    "",
    `Objective: ${params.objectiveTitle}`,
    params.objectiveDescription ? `Context: ${params.objectiveDescription}` : "Context: (no extra context provided)",
    "",
    "What you should do:",
    `1. ${recipientDirective}`,
    "2. Deliver one concrete, verifiable output for this objective.",
    "3. Post a short completion summary with files/areas changed and open risks.",
  ]
    .filter(Boolean)
    .join("\n");
}

const MAX_ORG_DEPTH = 12;

function OrgTreeNode(props: {
  employeeId: string;
  byId: Map<string, Employee>;
  childrenMap: Record<string, string[]>;
  tasks: Task[];
  accessSummary: Record<string, EmployeeAccountAccessSummary>;
  selectedId: string | null;
  onSelect: (employee: Employee) => void;
  depth: number;
  path: string[];
  visibleIds: Set<string> | null;
}) {
  const {
    employeeId,
    byId,
    childrenMap,
    tasks,
    accessSummary,
    selectedId,
    onSelect,
    depth,
    path,
    visibleIds,
  } = props;

  const employee = byId.get(employeeId);
  if (!employee) return null;
  if (visibleIds && !visibleIds.has(employeeId)) return null;

  const isCycle = path.includes(employeeId);
  const counts = taskCountsForEmployee(tasks, employeeId);
  const access = accessSummary[employeeId];

  const childIds = (childrenMap[employeeId] || []).filter(
    (childId) => byId.has(childId) && (!visibleIds || visibleIds.has(childId))
  );

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => onSelect(employee)}
        className={`w-full text-left rounded-xl border p-4 transition-all hover:border-primary/50 hover:bg-primary/5 ${
          selectedId === employeeId ? "border-primary/50 bg-primary/5" : "border-border bg-card/40"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold truncate">{employee.name}</div>
            <div className="text-[11px] text-muted-foreground font-mono truncate">
              {employee.role_key}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {statusBadge(employee.status)}
            <Badge className={`border ${departmentColor(employee.department)}`}>
              {employee.department}
            </Badge>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded border border-border bg-muted/20 px-2 py-1.5">
            Active: {counts.inProgress}
          </div>
          <div className="rounded border border-border bg-muted/20 px-2 py-1.5">
            Review: {counts.review}
          </div>
          <div className="rounded border border-border bg-muted/20 px-2 py-1.5">
            Accounts: {access?.accountCount ?? 0}
          </div>
        </div>
      </button>

      {isCycle ? (
        <div className="ml-6 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Cycle detected in hierarchy at {employee.name}. Resolve manager assignments.
        </div>
      ) : depth >= MAX_ORG_DEPTH ? (
        <div className="ml-6 text-xs text-muted-foreground">
          Depth limit reached. Additional levels are hidden.
        </div>
      ) : childIds.length > 0 ? (
        <div className="ml-6 pl-4 border-l border-border/70 space-y-3">
          {childIds.map((childId) => (
            <OrgTreeNode
              key={childId}
              employeeId={childId}
              byId={byId}
              childrenMap={childrenMap}
              tasks={tasks}
              accessSummary={accessSummary}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
              path={[...path, employeeId]}
              visibleIds={visibleIds}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EmployeesView(props: {
  workspaceId: string;
  tasks: Task[];
  activity: ActivityEntry[];
  agents: Agent[];
  onCreateTask: (data: {
    title: string;
    description: string;
    priority: string;
    assigned_agent_id?: string;
    employee_id?: string | null;
  }) => Promise<boolean> | boolean;
  onDispatchTask: (taskId: string, agentId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { workspaceId, tasks, agents, onCreateTask, onDispatchTask, onOpenTask } = props;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accessSummary, setAccessSummary] = useState<Record<string, EmployeeAccountAccessSummary>>({});

  const [query, setQuery] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState<EmployeeDepartment | "all">("all");
  const [viewMode, setViewMode] = useState<EmployeesViewMode>("grid");

  // Hierarchy view data (org chart)
  const [hierarchyLoading, setHierarchyLoading] = useState(false);
  const [hierarchyRoots, setHierarchyRoots] = useState<string[]>([]);
  const [hierarchyChildren, setHierarchyChildren] = useState<Record<string, string[]>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [seedingOffice, setSeedingOffice] = useState(false);
  const [seedingSwarm, setSeedingSwarm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    role_key: "",
    department: "operations" as EmployeeDepartment,
    description: "",
    manager_id: "" as string,
  });

  const [selected, setSelected] = useState<Employee | null>(null);

  // Create task directly for a specific employee (so Employees view is usable immediately)
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    priority: "medium",
    assigned_agent_id: "none",
  });
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskTemplateQuery, setTaskTemplateQuery] = useState("");
  const [taskTemplates, setTaskTemplates] = useState<CommunityUsecaseTemplate[]>([]);
  const [taskTemplatesLoading, setTaskTemplatesLoading] = useState(false);
  const [taskTemplatesError, setTaskTemplatesError] = useState<string | null>(null);
  const [taskFavoriteTemplateIds, setTaskFavoriteTemplateIds] = useState<string[]>([]);
  const [taskSuggestionDismissed, setTaskSuggestionDismissed] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [delegationForm, setDelegationForm] = useState({
    title: "",
    description: "",
    priority: "high",
  });

  const resetTaskComposer = useCallback(() => {
    setTaskForm({
      title: "",
      description: "",
      priority: "medium",
      assigned_agent_id: "none",
    });
    setTaskTemplateQuery("");
    setTaskSuggestionDismissed(false);
  }, []);

  const taskSuggestedSpecialist = useMemo(() => {
    if (taskSuggestionDismissed) return null;
    return suggestAgentForTask(`${taskForm.title} ${taskForm.description}`);
  }, [taskForm.title, taskForm.description, taskSuggestionDismissed]);

  useEffect(() => {
    if (!createTaskOpen || taskTemplates.length > 0 || taskTemplatesLoading) return;
    let cancelled = false;

    async function loadTemplates() {
      setTaskTemplatesLoading(true);
      setTaskTemplatesError(null);
      try {
        const res = await fetch("/api/openclaw/community-usecases");
        const data = (await res.json()) as CommunityUsecasesResponse;
        if (!res.ok) {
          throw new Error(data.error || `Failed to load templates (${res.status})`);
        }
        if (!cancelled) {
          setTaskTemplates(Array.isArray(data.usecases) ? data.usecases : []);
        }
      } catch (e) {
        if (!cancelled) {
          setTaskTemplatesError(e instanceof Error ? e.message : "Failed to load templates");
        }
      } finally {
        if (!cancelled) {
          setTaskTemplatesLoading(false);
        }
      }
    }

    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [createTaskOpen, taskTemplates.length, taskTemplatesLoading]);

  useEffect(() => {
    setTaskFavoriteTemplateIds(loadCommunityUsecaseFavorites());
  }, []);

  const taskFavoriteTemplateSet = useMemo(
    () => new Set(taskFavoriteTemplateIds),
    [taskFavoriteTemplateIds]
  );

  const filteredTaskTemplates = useMemo(() => {
    const query = taskTemplateQuery.trim().toLowerCase();
    const matching = !query
      ? taskTemplates
      : taskTemplates.filter((template) => {
          return (
            template.title.toLowerCase().includes(query) ||
            template.summary.toLowerCase().includes(query) ||
            template.category.toLowerCase().includes(query) ||
            template.tags.some((tag) => tag.toLowerCase().includes(query))
          );
        });
    return [...matching]
      .sort((a, b) => {
        const af = taskFavoriteTemplateSet.has(a.id) ? 1 : 0;
        const bf = taskFavoriteTemplateSet.has(b.id) ? 1 : 0;
        if (af !== bf) return bf - af;
        return b.rating - a.rating;
      })
      .slice(0, query ? 14 : 10);
  }, [taskTemplateQuery, taskTemplates, taskFavoriteTemplateSet]);

  const favoriteTaskTemplates = useMemo(
    () =>
      filteredTaskTemplates
        .filter((template) => taskFavoriteTemplateSet.has(template.id))
        .slice(0, 6),
    [filteredTaskTemplates, taskFavoriteTemplateSet]
  );

  const handleToggleEmployeeTemplateFavorite = useCallback((templateId: string) => {
    setTaskFavoriteTemplateIds((prev) => {
      const next = toggleCommunityUsecaseFavorite(prev, templateId);
      saveCommunityUsecaseFavorites(next);
      return next;
    });
  }, []);

  const buildEmployeeUsecaseTask = useCallback(
    (template: CommunityUsecaseTemplate) => {
      const employeeName = selected?.name || "employee";
      const title = `Implement use case: ${template.title}`.slice(0, 200);
      const description = [
        `You are executing this OpenClaw community use case as ${employeeName}.`,
        "",
        `Use case: ${template.title}`,
        `Category: ${template.category}`,
        `Source: ${template.sourceDetail || template.source || "community catalog"}`,
        `Reference: ${template.url || "N/A"}`,
        "",
        `Summary: ${template.summary}`,
        "",
        "Delivery criteria:",
        "1. Implement one concrete, testable improvement.",
        "2. Keep output concise and production-safe.",
        "3. Post a short completion summary with files touched.",
      ].join("\n");
      const priority = template.rating >= 94 ? "high" : "medium";
      const suggested = suggestAgentForTask(`${template.title} ${template.summary}`);
      return {
        title,
        description,
        priority,
        suggestedAgentId: suggested?.id,
      };
    },
    [selected?.name]
  );

  // Accounts & access management (metadata-only in v1)
  const [manageAccountsOpen, setManageAccountsOpen] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accounts, setAccounts] = useState<Array<{ id: string; service: string; label: string; region: string | null; notes: string }>>([]);
  const [accessRows, setAccessRows] = useState<Array<{ account_id: string; mode: "read" | "draft" | "execute"; requires_approval: number; service: string; label: string; region: string | null }>>([]);

  const [newAccount, setNewAccount] = useState({ service: "", label: "", region: "KSA", notes: "" });

  // Schedules
  const [schedules, setSchedules] = useState<EmployeeSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ workspace_id: workspaceId });
      const res = await fetch(`/api/employees?${params.toString()}`);
      const data = (await res.json()) as EmployeesApiResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEmployees(data.employees || []);
      setAccessSummary(data.accessSummary || {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load employees");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshHierarchy = useCallback(async () => {
    setHierarchyLoading(true);
    try {
      const res = await fetch(
        `/api/employees/hierarchy?${new URLSearchParams({ workspace_id: workspaceId }).toString()}`
      );
      const data = (await res.json()) as EmployeeHierarchyResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setHierarchyRoots(data.roots || []);
      setHierarchyChildren(data.children || {});
    } catch (e) {
      // Don't hard-fail the whole page if hierarchy fails.
      setHierarchyRoots([]);
      setHierarchyChildren({});
      setError((prev) => prev || (e instanceof Error ? e.message : "Failed to load employee hierarchy"));
    } finally {
      setHierarchyLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (viewMode !== "org") return;
    void refreshHierarchy();
  }, [viewMode, refreshHierarchy]);

  const refreshAccountsAndAccess = useCallback(async () => {
    if (!selected) return;
    setAccountsLoading(true);
    try {
      const [accRes, accessRes] = await Promise.all([
        fetch(`/api/accounts?${new URLSearchParams({ workspace_id: workspaceId }).toString()}`),
        fetch(
          `/api/employees/access?${new URLSearchParams({
            employee_id: selected.id,
            workspace_id: workspaceId,
          }).toString()}`
        ),
      ]);
      const accData = (await accRes.json()) as { accounts?: AccountRecord[]; error?: string };
      const accessData = (await accessRes.json()) as {
        access?: EmployeeAccessRecord[];
        error?: string;
      };
      if (!accRes.ok) throw new Error(accData.error || `Accounts HTTP ${accRes.status}`);
      if (!accessRes.ok) throw new Error(accessData.error || `Access HTTP ${accessRes.status}`);
      setAccounts(
        (accData.accounts || []).map((a) => ({
          id: a.id,
          service: a.service,
          label: a.label,
          region: a.region ?? null,
          notes: a.notes ?? "",
        }))
      );
      setAccessRows(
        (accessData.access || []).map((r) => ({
          account_id: r.account_id,
          mode: r.mode,
          requires_approval: r.requires_approval,
          service: r.service,
          label: r.label,
          region: r.region ?? null,
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    } finally {
      setAccountsLoading(false);
    }
  }, [selected, workspaceId]);

  useEffect(() => {
    if (!manageAccountsOpen) return;
    void refreshAccountsAndAccess();
  }, [manageAccountsOpen, refreshAccountsAndAccess]);

  const refreshSchedules = useCallback(async () => {
    if (!selected) return;
    setSchedulesLoading(true);
    try {
      const params = new URLSearchParams({
        workspace_id: workspaceId,
        employee_id: selected.id,
      });
      const res = await fetch(`/api/employees/schedules?${params.toString()}`);
      const data = (await res.json()) as { schedules?: EmployeeSchedule[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSchedules(data.schedules || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schedules");
    } finally {
      setSchedulesLoading(false);
    }
  }, [selected, workspaceId]);

  useEffect(() => {
    if (!selected) return;
    void refreshSchedules();
  }, [selected, refreshSchedules]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return employees
      .filter((e) => e.workspace_id === workspaceId)
      .filter((e) => (departmentFilter === "all" ? true : e.department === departmentFilter))
      .filter((e) => {
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q) ||
          e.role_key.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
  }, [employees, query, departmentFilter, workspaceId]);

  const hierarchyById = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const employee of employees) {
      if (employee.workspace_id === workspaceId) {
        map.set(employee.id, employee);
      }
    }
    return map;
  }, [employees, workspaceId]);

  const orgVisibleIds = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const hasQuery = normalizedQuery.length > 0;
    const hasDepartmentFilter = departmentFilter !== "all";
    if (!hasQuery && !hasDepartmentFilter) return null;

    const visible = new Set<string>();

    for (const employee of hierarchyById.values()) {
      const matchesDepartment = hasDepartmentFilter ? employee.department === departmentFilter : true;
      const matchesQuery = hasQuery
        ? employee.name.toLowerCase().includes(normalizedQuery) ||
          employee.role_key.toLowerCase().includes(normalizedQuery) ||
          employee.description.toLowerCase().includes(normalizedQuery)
        : true;
      if (matchesDepartment && matchesQuery) {
        visible.add(employee.id);
      }
    }

    const seedIds = Array.from(visible);

    for (const id of seedIds) {
      let current = hierarchyById.get(id);
      while (current?.manager_id) {
        const manager = hierarchyById.get(current.manager_id);
        if (!manager || visible.has(manager.id)) break;
        visible.add(manager.id);
        current = manager;
      }
    }

    const visited = new Set<string>();
    const stack = [...seedIds];
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const children = hierarchyChildren[currentId] || [];
      for (const childId of children) {
        if (!hierarchyById.has(childId)) continue;
        if (!visible.has(childId)) {
          visible.add(childId);
        }
        if (!visited.has(childId)) {
          stack.push(childId);
        }
      }
    }

    return visible;
  }, [hierarchyById, hierarchyChildren, query, departmentFilter]);

  const orgRoots = useMemo(() => {
    const bySort = (a: string, b: string) => {
      const ea = hierarchyById.get(a);
      const eb = hierarchyById.get(b);
      if (!ea || !eb) return a.localeCompare(b);
      return (ea.sort_order ?? 0) - (eb.sort_order ?? 0) || ea.name.localeCompare(eb.name);
    };

    const roots = hierarchyRoots.filter(
      (id) => hierarchyById.has(id) && (!orgVisibleIds || orgVisibleIds.has(id))
    );

    if (roots.length > 0) {
      return [...roots].sort(bySort);
    }

    if (!orgVisibleIds) return [];

    const fallbackRoots: string[] = [];
    for (const id of orgVisibleIds) {
      const employee = hierarchyById.get(id);
      if (!employee) continue;
      const managerId = employee.manager_id;
      if (!managerId || !orgVisibleIds.has(managerId)) {
        fallbackRoots.push(id);
      }
    }
    return fallbackRoots.sort(bySort);
  }, [hierarchyById, hierarchyRoots, orgVisibleIds]);

  const selectedDirectReports = useMemo(() => {
    if (!selected) return [] as Employee[];
    return employees
      .filter(
        (employee) =>
          employee.workspace_id === workspaceId &&
          employee.manager_id === selected.id &&
          employee.status === "active"
      )
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }, [employees, selected, workspaceId]);

  const selectedSecondLevelCount = useMemo(() => {
    if (!selected) return 0;
    return employees.filter((employee) => {
      if (employee.workspace_id !== workspaceId || employee.status !== "active" || !employee.manager_id) {
        return false;
      }
      return selectedDirectReports.some((lead) => lead.id === employee.manager_id);
    }).length;
  }, [employees, selected, selectedDirectReports, workspaceId]);

  const workspaceEmployeesByRoleKey = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const employee of employees) {
      if (employee.workspace_id !== workspaceId) continue;
      map.set(employee.role_key, employee);
    }
    return map;
  }, [employees, workspaceId]);

  const totals = useMemo(() => {
    const activeCount = employees.filter((e) => e.workspace_id === workspaceId && e.status === "active").length;
    const workingCount = employees.filter((e) => {
      if (e.workspace_id !== workspaceId) return false;
      const c = taskCountsForEmployee(tasks, e.id);
      return e.status === "active" && (c.inProgress > 0 || c.review > 0);
    }).length;
    const blockedCount = 0; // reserved for future (blocked reasons)
    return { activeCount, workingCount, blockedCount };
  }, [employees, tasks, workspaceId]);

  const applyEmployeeBlueprint = useCallback(
    (blueprint: EmployeeBlueprint) => {
      const managerId = blueprint.manager_role_key
        ? workspaceEmployeesByRoleKey.get(blueprint.manager_role_key)?.id || ""
        : "";
      setForm({
        name: blueprint.name,
        role_key: blueprint.role_key,
        department: blueprint.department,
        description: blueprint.description,
        manager_id: managerId,
      });
      setError(null);
    },
    [workspaceEmployeesByRoleKey]
  );

  const handleCreate = useCallback(async () => {
    const name = form.name.trim();
    const roleKey = (form.role_key || name)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_\-]/g, "");

    if (!name) return;

    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          role_key: roleKey,
          department: form.department,
          description: form.description,
          manager_id: form.manager_id ? form.manager_id : null,
          workspace_id: workspaceId,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; employee?: Employee };
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setCreateOpen(false);
      setForm({ name: "", role_key: "", department: "operations", description: "", manager_id: "" });
      setNotice(`Created employee: ${data.employee?.name || name}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create employee");
    } finally {
      setCreating(false);
    }
  }, [form, refresh, workspaceId]);

  const handleSeedOffice = useCallback(async () => {
    setSeedingOffice(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/employees/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const data = (await res.json()) as EmployeeSeedResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await refresh();
      if (viewMode === "org") {
        await refreshHierarchy();
      }
      const workspaceEmployeeCount = (data.employees || []).filter(
        (employee) => employee.workspace_id === workspaceId
      ).length;
      setNotice(
        workspaceEmployeeCount > 0
          ? `Seeded AI office for this workspace (${workspaceEmployeeCount} employees available).`
          : "Seeded AI office for this workspace."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to seed employees");
    } finally {
      setSeedingOffice(false);
    }
  }, [refresh, refreshHierarchy, viewMode, workspaceId]);

  const handleSeedSwarm = useCallback(async () => {
    setSeedingSwarm(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/employees/swarm-seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const data = (await res.json()) as EmployeeSeedResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await refresh();
      if (viewMode === "org") {
        await refreshHierarchy();
      }
      const createdEmployees = Number(data.createdEmployees || 0);
      const createdSchedules = Number(data.createdSchedules || 0);
      setNotice(
        createdEmployees > 0 || createdSchedules > 0
          ? `Swarm deployed: ${createdEmployees} employees and ${createdSchedules} schedules created.`
          : "Swarm groups already present. No changes needed."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to seed swarm groups");
    } finally {
      setSeedingSwarm(false);
    }
  }, [refresh, refreshHierarchy, viewMode, workspaceId]);

  const handleDelegateObjective = useCallback(async () => {
    if (!selected) return;
    const objectiveTitle = delegationForm.title.trim();
    const objectiveDescription = delegationForm.description.trim();
    if (!objectiveTitle) {
      setError("Objective title is required.");
      return;
    }
    if (selectedDirectReports.length === 0) {
      setError("This manager has no active direct reports to delegate to.");
      return;
    }

    setDelegating(true);
    setError(null);
    setNotice(null);

    try {
      let createdCount = 0;
      const failedRecipients: string[] = [];

      const managerCoordinatorSuggestion = suggestAgentForTask(
        `${selected.role_key} ${objectiveTitle} ${objectiveDescription}`
      );
      const managerCoordinatorOk = await Promise.resolve(
        onCreateTask({
          title: `Coordinate objective: ${objectiveTitle}`.slice(0, 200),
          description: [
            `You are ${selected.name}, coordinating delegation for this objective.`,
            "",
            `Objective: ${objectiveTitle}`,
            objectiveDescription ? `Context: ${objectiveDescription}` : "",
            "",
            "Execution checklist:",
            "1. Delegate work across teams with clear ownership and outcomes.",
            "2. Monitor delivery and unblock teams quickly.",
            "3. Consolidate final status and residual risk.",
          ]
            .filter(Boolean)
            .join("\n"),
          priority: delegationForm.priority,
          employee_id: selected.id,
          ...(managerCoordinatorSuggestion?.id
            ? { assigned_agent_id: managerCoordinatorSuggestion.id }
            : {}),
        })
      );
      if (!managerCoordinatorOk) {
        throw new Error("Failed to create manager coordination task.");
      }
      createdCount += 1;

      for (const lead of selectedDirectReports) {
        const leadTaskDescription = buildDelegationTaskDescription({
          managerName: selected.name,
          objectiveTitle,
          objectiveDescription,
          recipient: lead,
        });
        const leadSuggestedAgent = suggestAgentForTask(
          `${lead.role_key} ${lead.description} ${objectiveTitle} ${objectiveDescription}`
        );
        const leadOk = await Promise.resolve(
          onCreateTask({
            title: `${objectiveTitle} - Team Lead: ${lead.name}`.slice(0, 200),
            description: leadTaskDescription,
            priority: delegationForm.priority,
            employee_id: lead.id,
            ...(leadSuggestedAgent?.id ? { assigned_agent_id: leadSuggestedAgent.id } : {}),
          })
        );
        if (leadOk) {
          createdCount += 1;
        } else {
          failedRecipients.push(lead.name);
        }

        const teamMembers = employees
          .filter(
            (employee) =>
              employee.workspace_id === workspaceId &&
              employee.manager_id === lead.id &&
              employee.status === "active"
          )
          .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

        for (const member of teamMembers) {
          const memberTaskDescription = buildDelegationTaskDescription({
            managerName: selected.name,
            objectiveTitle,
            objectiveDescription,
            recipient: member,
            parentLeadName: lead.name,
          });
          const memberSuggestedAgent = suggestAgentForTask(
            `${member.role_key} ${member.description} ${objectiveTitle} ${objectiveDescription}`
          );
          const memberOk = await Promise.resolve(
            onCreateTask({
              title: `${objectiveTitle} - ${member.name}`.slice(0, 200),
              description: memberTaskDescription,
              priority: delegationForm.priority,
              employee_id: member.id,
              ...(memberSuggestedAgent?.id ? { assigned_agent_id: memberSuggestedAgent.id } : {}),
            })
          );
          if (memberOk) {
            createdCount += 1;
          } else {
            failedRecipients.push(member.name);
          }
        }
      }

      setDelegateOpen(false);
      setDelegationForm({ title: "", description: "", priority: "high" });
      setNotice(
        failedRecipients.length === 0
          ? `Delegation completed. Created ${createdCount} tasks across manager and teams.`
          : `Delegation partially completed. Created ${createdCount} tasks. Failed for: ${failedRecipients.join(", ")}`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delegate objective");
    } finally {
      setDelegating(false);
    }
  }, [
    delegationForm.description,
    delegationForm.priority,
    delegationForm.title,
    employees,
    onCreateTask,
    selected,
    selectedDirectReports,
    workspaceId,
  ]);

  const submitEmployeeTask = useCallback(
    async (payload: {
      title: string;
      description: string;
      priority: string;
      assignedAgentId?: string;
    }) => {
      if (!selected) return false;
      if (!payload.title.trim()) return false;

      setTaskCreating(true);
      setError(null);
      try {
        const ok = await Promise.resolve(
          onCreateTask({
            title: payload.title.trim(),
            description: payload.description.trim(),
            priority: payload.priority,
            employee_id: selected.id,
            ...(payload.assignedAgentId
              ? { assigned_agent_id: payload.assignedAgentId }
              : {}),
          })
        );
        if (!ok) {
          throw new Error("Failed to create task");
        }
        setCreateTaskOpen(false);
        resetTaskComposer();
        void refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create task");
        return false;
      } finally {
        setTaskCreating(false);
      }
    },
    [selected, onCreateTask, refresh, resetTaskComposer]
  );

  const handleEmployeeTemplateUse = useCallback(
    (template: CommunityUsecaseTemplate) => {
      const built = buildEmployeeUsecaseTask(template);
      setTaskForm((prev) => ({
        ...prev,
        title: built.title,
        description: built.description,
        priority: built.priority,
        assigned_agent_id: built.suggestedAgentId || prev.assigned_agent_id,
      }));
      setTaskSuggestionDismissed(false);
      setError(null);
    },
    [buildEmployeeUsecaseTask]
  );

  const handleEmployeeTemplateCreateAndDispatch = useCallback(
    async (template: CommunityUsecaseTemplate) => {
      const built = buildEmployeeUsecaseTask(template);
      const assignedAgentId =
        built.suggestedAgentId ||
        (taskForm.assigned_agent_id !== "none" ? taskForm.assigned_agent_id : undefined);

      if (!assignedAgentId) {
        handleEmployeeTemplateUse(template);
        setError("Template loaded. Pick an agent once, then click Create & Dispatch.");
        return;
      }

      await submitEmployeeTask({
        title: built.title,
        description: built.description,
        priority: built.priority,
        assignedAgentId,
      });
    },
    [buildEmployeeUsecaseTask, handleEmployeeTemplateUse, submitEmployeeTask, taskForm.assigned_agent_id]
  );

  const handleEmployeeCreateAndDispatch = useCallback(async () => {
    const assignedAgentId =
      taskForm.assigned_agent_id !== "none"
        ? taskForm.assigned_agent_id
        : taskSuggestedSpecialist?.id;

    if (!assignedAgentId) {
      setError("No suggested specialist found. Pick an agent first, then use Create & Dispatch.");
      return;
    }

    await submitEmployeeTask({
      title: taskForm.title,
      description: taskForm.description,
      priority: taskForm.priority,
      assignedAgentId,
    });
  }, [taskForm, taskSuggestedSpecialist?.id, submitEmployeeTask]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Employees
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Your AI office building. Track work, outputs, access, and orchestration per employee.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void handleSeedSwarm();
            }}
            disabled={seedingSwarm}
          >
            <Shield className={`w-4 h-4 mr-1.5 ${seedingSwarm ? "animate-pulse" : ""}`} />
            {seedingSwarm ? "Deploying..." : "Deploy Swarm Groups"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void handleSeedOffice();
            }}
            disabled={seedingOffice}
          >
            <Zap className={`w-4 h-4 mr-1.5 ${seedingOffice ? "animate-pulse" : ""}`} />
            {seedingOffice ? "Seeding..." : "Seed AI Office"}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add Employee
          </Button>
        </div>
      </div>

      {/* Top stats (addictive glanceable widgets) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5" /> Workforce (active)
          </div>
          <div className="text-3xl font-bold text-primary">{totals.activeCount}</div>
          <div className="text-xs text-muted-foreground mt-1">in this workspace</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5" /> Working now
          </div>
          <div className="text-3xl font-bold text-amber-400">{totals.workingCount}</div>
          <div className="text-xs text-muted-foreground mt-1">in progress / review</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5" /> Guardrails
          </div>
          <div className="text-3xl font-bold text-emerald-400">Draft-first</div>
          <div className="text-xs text-muted-foreground mt-1">approval gates will be configured per account</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode("grid")}
            className={`h-10 px-3 rounded-lg border text-sm transition-colors ${
              viewMode === "grid"
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-card/50 text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
          >
            Grid
          </button>
          <button
            onClick={() => setViewMode("org")}
            className={`h-10 px-3 rounded-lg border text-sm transition-colors ${
              viewMode === "org"
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-card/50 text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
          >
            Org Chart
          </button>
        </div>

        <div className="relative flex-1 max-w-xl">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search employees (name, role, description)"
            className="w-full h-10 rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {([
            "all",
            "operations",
            "sales",
            "marketing",
            "finance",
            "compliance",
            "engineering",
            "other",
          ] as const).map((dept) => (
            <button
              key={dept}
              onClick={() => setDepartmentFilter(dept)}
              className={`h-8 px-3 rounded-lg border text-xs transition-colors ${
                departmentFilter === dept
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card/50 text-muted-foreground hover:text-foreground hover:bg-muted/30"
              }`}
            >
              {dept === "all" ? "All" : dept}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border px-4 py-3 text-sm border-destructive/40 bg-destructive/10 text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border px-4 py-3 text-sm border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
          {notice}
        </div>
      )}

      {/* Employee grid / org chart */}
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-card border border-border rounded-xl p-5 animate-pulse">
              <div className="h-4 w-32 bg-muted rounded" />
              <div className="h-3 w-48 bg-muted rounded mt-2" />
              <div className="h-20 bg-muted/40 rounded mt-4" />
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="col-span-full bg-card border border-dashed border-border rounded-xl p-10 text-center">
            <p className="text-sm text-muted-foreground">No employees found.</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="w-4 h-4 mr-1.5" /> Add Employee
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void handleSeedOffice();
                }}
                disabled={seedingOffice || seedingSwarm}
              >
                <Zap className="w-4 h-4 mr-1.5" />
                {seedingOffice ? "Seeding..." : "Seed AI office"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void handleSeedSwarm();
                }}
                disabled={seedingSwarm || seedingOffice}
              >
                <Shield className="w-4 h-4 mr-1.5" />
                {seedingSwarm ? "Deploying..." : "Deploy swarm groups"}
              </Button>
            </div>
          </div>
        ) : (
          filtered.map((e) => {
            const counts = taskCountsForEmployee(tasks, e.id);
            const access = accessSummary[e.id];
            const accessText = access
              ? `${access.accountCount} accounts • ${access.executeCount} exec`
              : "0 accounts";

            const busy = counts.inProgress + counts.review > 0;

            return (
              <button
                key={e.id}
                onClick={() => setSelected(e)}
                className={`text-left group bg-card border rounded-xl p-5 transition-all hover:border-primary/50 hover:shadow-[0_0_20px_oklch(0.58_0.2_260/0.15)] ${
                  busy ? "border-primary/25" : "border-border"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                        <Users className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <div className="font-semibold text-base leading-tight">{e.name}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">{e.role_key}</div>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {statusBadge(e.status)}
                    <Badge className={`border ${departmentColor(e.department)}`}>{e.department}</Badge>
                  </div>
                </div>

                <p className="mt-3 text-sm text-muted-foreground line-clamp-2">
                  {e.description || "No description yet. Add responsibilities and SOPs."}
                </p>

                <div className="mt-4 grid grid-cols-4 gap-2">
                  <div className="rounded-lg border border-border bg-muted/20 p-2">
                    <div className="text-[10px] text-muted-foreground">Inbox</div>
                    <div className="text-sm font-semibold">{counts.inbox}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-2">
                    <div className="text-[10px] text-muted-foreground">Active</div>
                    <div className="text-sm font-semibold">{counts.inProgress}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-2">
                    <div className="text-[10px] text-muted-foreground">Review</div>
                    <div className="text-sm font-semibold">{counts.review}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-2">
                    <div className="text-[10px] text-muted-foreground">Done</div>
                    <div className="text-sm font-semibold">{counts.done}</div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5" /> {accessText}
                  </span>
                  <span className="inline-flex items-center gap-1.5 group-hover:text-primary transition-colors">
                    Open control room <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
      ) : (
        <div className="rounded-xl border border-border bg-card/40 p-6">
          {hierarchyLoading ? (
            <p className="text-sm text-muted-foreground animate-pulse text-center">Loading org chart...</p>
          ) : orgRoots.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center">
              No hierarchy data. Add managers to employees to build the org chart.
            </p>
          ) : (
            <div className="space-y-4">
              {orgRoots.map((rootId) => (
                <OrgTreeNode
                  key={rootId}
                  employeeId={rootId}
                  byId={hierarchyById}
                  childrenMap={hierarchyChildren}
                  tasks={tasks}
                  accessSummary={accessSummary}
                  selectedId={selected?.id || null}
                  onSelect={setSelected}
                  depth={0}
                  path={[]}
                  visibleIds={orgVisibleIds}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create Employee Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" /> Add Employee
            </DialogTitle>
            <DialogDescription>
              Create a new AI employee. You can attach accounts and guardrails after creation.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Role Blueprints
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Click one to prefill fields
                </p>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {EMPLOYEE_BLUEPRINTS.map((blueprint) => (
                  <button
                    key={blueprint.key}
                    type="button"
                    onClick={() => applyEmployeeBlueprint(blueprint)}
                    className="h-7 px-2.5 rounded-md border border-border bg-background text-xs text-foreground hover:bg-muted"
                  >
                    {blueprint.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g., ZATCA Manager"
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Role key (optional)</label>
              <input
                value={form.role_key}
                onChange={(e) => setForm((p) => ({ ...p, role_key: e.target.value }))}
                placeholder="e.g., zatca_manager (auto-generated if empty)"
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Department</label>
              <select
                value={form.department}
                onChange={(e) => setForm((p) => ({ ...p, department: e.target.value as EmployeeDepartment }))}
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              >
                <option value="operations">operations</option>
                <option value="sales">sales</option>
                <option value="marketing">marketing</option>
                <option value="finance">finance</option>
                <option value="compliance">compliance</option>
                <option value="engineering">engineering</option>
                <option value="other">other</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Manager (optional)</label>
              <select
                value={form.manager_id}
                onChange={(e) => setForm((p) => ({ ...p, manager_id: e.target.value }))}
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              >
                <option value="">No manager</option>
                {employees
                  .filter((emp) => emp.workspace_id === workspaceId)
                  .map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.role_key})
                    </option>
                  ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Use this to build hierarchy (Staff Manager → department managers → specialists).
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Description</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="What is this employee responsible for? What outputs should they generate?"
                className="w-full min-h-[110px] rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !form.name.trim()}>
              {creating ? "Creating..." : "Create Employee"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Employee Control Room Dialog */}
      <Dialog open={!!selected} onOpenChange={(open) => {
        if (!open) {
          setSelected(null);
          setCreateTaskOpen(false);
        }
      }}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 min-w-0">
                <Users className="w-5 h-5 text-primary" />
                <span className="truncate">{selected?.name}</span>
                {selected ? statusBadge(selected.status) : null}
              </span>
              {selected ? (
                <Badge className={`border ${departmentColor(selected.department)}`}>{selected.department}</Badge>
              ) : null}
            </DialogTitle>
            <DialogDescription>
              Monitor tasks, outputs, and accounts. (Execution + approvals are next.)
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-5 gap-4">
              {/* Left: task list */}
              <div className="lg:col-span-3 min-h-0">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium">Task Queue</h3>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDelegationForm({
                          title: "",
                          description: "",
                          priority: "high",
                        });
                        setDelegateOpen(true);
                        setError(null);
                      }}
                      disabled={selectedDirectReports.length === 0}
                    >
                      <GitBranch className="w-4 h-4 mr-1.5" /> Delegate Objective
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        resetTaskComposer();
                        setCreateTaskOpen(true);
                      }}
                    >
                      <Plus className="w-4 h-4 mr-1.5" /> Create Task
                    </Button>
                  </div>
                </div>

                <ScrollArea className="h-[52vh] rounded-xl border border-border bg-card/40">
                  <div className="p-2 space-y-2">
                    {tasks
                      .filter((t) => t.employee_id === selected.id)
                      .sort((a, b) => {
                        const aTs = new Date(a.updated_at || a.created_at).getTime();
                        const bTs = new Date(b.updated_at || b.created_at).getTime();
                        return bTs - aTs;
                      })
                      .slice(0, 50)
                      .map((t) => (
                        <div
                          key={t.id}
                          className="rounded-lg border border-border bg-background/50 hover:bg-muted/30 transition-colors p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <button
                                className="text-sm font-semibold truncate hover:underline"
                                onClick={() => onOpenTask(t.id)}
                              >
                                {t.title}
                              </button>
                              <div className="text-xs text-muted-foreground line-clamp-1">
                                {t.description}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="outline" className="text-[10px]">
                                {t.status}
                              </Badge>
                              <Badge variant="outline" className="text-[10px]">
                                {t.priority}
                              </Badge>
                            </div>
                          </div>

                          <div className="mt-2 flex items-center justify-between">
                            <div className="text-[11px] text-muted-foreground font-mono truncate">
                              {t.assigned_agent_id ? `agent:${t.assigned_agent_id}` : "unassigned"}
                            </div>
                            <div className="flex items-center gap-2">
                              <select
                                className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
                                defaultValue={t.assigned_agent_id ?? ""}
                                onChange={(e) => {
                                  const agentId = e.target.value;
                                  if (!agentId) return;
                                  onDispatchTask(t.id, agentId);
                                }}
                              >
                                <option value="">Dispatch…</option>
                                {agents.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name || a.id}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      ))}

                    {tasks.filter((t) => t.employee_id === selected.id).length === 0 && (
                      <div className="p-10 text-center text-sm text-muted-foreground">
                        No tasks assigned to this employee yet.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>

              {/* Right: access + quick notes */}
              <div className="lg:col-span-2 min-h-0 space-y-4">
                <div className="rounded-xl border border-border bg-card/40 p-4">
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-primary" /> Accounts & Access
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Next step: connect portal/social accounts with read/draft/execute permissions.
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-lg border border-border bg-muted/20 p-2">
                      <div className="text-[10px] text-muted-foreground">Read</div>
                      <div className="text-sm font-semibold">{accessSummary[selected.id]?.readCount ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/20 p-2">
                      <div className="text-[10px] text-muted-foreground">Draft</div>
                      <div className="text-sm font-semibold">{accessSummary[selected.id]?.draftCount ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/20 p-2">
                      <div className="text-[10px] text-muted-foreground">Execute</div>
                      <div className="text-sm font-semibold">{accessSummary[selected.id]?.executeCount ?? 0}</div>
                    </div>
                  </div>

                  <div className="mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setManageAccountsOpen(true)}
                    >
                      <KeyRound className="w-4 h-4 mr-1.5" /> Manage Accounts
                    </Button>
                  </div>
                </div>

                {/* Schedules */}
                <div className="rounded-xl border border-border bg-card/40 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium flex items-center gap-2">
                      <Clock className="w-4 h-4 text-primary" /> Schedules
                    </h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={refreshSchedules}
                      disabled={schedulesLoading}
                      className="h-7 px-2"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${schedulesLoading ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                  {schedulesLoading ? (
                    <div className="text-xs text-muted-foreground animate-pulse">Loading…</div>
                  ) : schedules.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No scheduled tasks for this employee.</p>
                  ) : (
                    <div className="space-y-2 max-h-[250px] overflow-y-auto">
                      {schedules.map((s) => (
                        <div
                          key={s.id}
                          className={`rounded-lg border p-2.5 transition-colors ${
                            s.enabled ? "border-border bg-background/50" : "border-border/50 bg-muted/10 opacity-60"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{s.title}</div>
                              <div className="text-[11px] text-muted-foreground">{cronToHuman(s.cron_expression)}</div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                title={s.enabled ? "Pause schedule" : "Enable schedule"}
                                onClick={async () => {
                                  try {
                                    const res = await fetch("/api/employees/schedules", {
                                      method: "PATCH",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({
                                        id: s.id,
                                        workspace_id: workspaceId,
                                        enabled: !s.enabled,
                                      }),
                                    });
                                    if (!res.ok) {
                                      const data = await res.json().catch(() => ({}));
                                      throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
                                    }
                                    void refreshSchedules();
                                  } catch (err) {
                                    setError(err instanceof Error ? err.message : "Failed to toggle schedule");
                                  }
                                }}
                              >
                                {s.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                title="Run now"
                                onClick={async () => {
                                  try {
                                    const res = await fetch("/api/employees/schedules/run", {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({
                                        id: s.id,
                                        workspace_id: workspaceId,
                                      }),
                                    });
                                    if (!res.ok) {
                                      const data = await res.json().catch(() => ({}));
                                      throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
                                    }
                                    void refreshSchedules();
                                  } catch (err) {
                                    setError(err instanceof Error ? err.message : "Failed to run schedule");
                                  }
                                }}
                              >
                                <Zap className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                          {s.next_run_at && (
                            <div className="text-[10px] text-muted-foreground mt-1">
                              Next: {new Date(s.next_run_at).toLocaleString()}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-border bg-card/40 p-4">
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <Shield className="w-4 h-4 text-primary" /> Guardrails
                  </h3>
                  <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      Default mode should be <span className="text-foreground">Draft-first</span> (approval required) for portals + outbound messaging.
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      Every action will log evidence (message IDs, screenshots, receipts).
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Task for Employee */}
      <Dialog
        open={createTaskOpen}
        onOpenChange={(open) => {
          setCreateTaskOpen(open);
          if (!open) {
            resetTaskComposer();
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Create Task for {selected?.name}</DialogTitle>
            <DialogDescription>
              This task will be attached to the employee so you can monitor output and progress.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  <LayoutTemplate className="w-4 h-4 text-primary" />
                  Community Usecase Templates
                </label>
                <span className="text-xs text-muted-foreground">
                  {taskTemplatesLoading ? "Loading..." : `${taskTemplates.length} imported`}
                </span>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={taskTemplateQuery}
                  onChange={(e) => setTaskTemplateQuery(e.target.value)}
                  className="w-full h-9 rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
                  placeholder="Search templates..."
                />
              </div>
              {taskTemplatesError ? (
                <p className="text-xs text-destructive">{taskTemplatesError}</p>
              ) : (
                <>
                  {!taskTemplateQuery.trim() && favoriteTaskTemplates.length > 0 && (
                    <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5">
                      <p className="text-xs font-medium text-primary mb-2">Favorite Templates</p>
                      <div className="flex flex-wrap gap-1.5">
                        {favoriteTaskTemplates.map((template) => (
                          <button
                            key={`fav-${template.id}`}
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-background px-2 py-1 text-xs hover:bg-primary/10"
                            onClick={() => handleEmployeeTemplateUse(template)}
                          >
                            <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                            <span className="max-w-[180px] truncate">{template.title}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
                    {filteredTaskTemplates.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No matching templates. Clear search to see top imported usecases.
                      </p>
                    ) : (
                      filteredTaskTemplates.map((template) => (
                        <div
                          key={template.id}
                          className="rounded-md border border-border/70 bg-muted/20 p-2.5 space-y-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium leading-tight">{template.title}</p>
                              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                                {template.summary}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Badge variant="outline" className="text-[10px]">
                                {template.category}
                              </Badge>
                              <button
                                type="button"
                                className="h-6 w-6 rounded border border-border/60 bg-background flex items-center justify-center hover:bg-muted"
                                title={
                                  taskFavoriteTemplateSet.has(template.id)
                                    ? "Remove from favorites"
                                    : "Add to favorites"
                                }
                                onClick={() =>
                                  handleToggleEmployeeTemplateFavorite(template.id)
                                }
                              >
                                <Star
                                  className={`w-3.5 h-3.5 ${
                                    taskFavoriteTemplateSet.has(template.id)
                                      ? "fill-amber-400 text-amber-400"
                                      : "text-muted-foreground"
                                  }`}
                                />
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-muted-foreground">
                              Score {template.rating}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => handleEmployeeTemplateUse(template)}
                                disabled={taskCreating}
                              >
                                Use
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => {
                                  void handleEmployeeTemplateCreateAndDispatch(template);
                                }}
                                disabled={taskCreating}
                              >
                                Create & Dispatch
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Title</label>
              <input
                value={taskForm.title}
                onChange={(e) => setTaskForm((p) => ({ ...p, title: e.target.value }))}
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                placeholder="What should this employee do?"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Description</label>
              <textarea
                value={taskForm.description}
                onChange={(e) => setTaskForm((p) => ({ ...p, description: e.target.value }))}
                className="w-full min-h-[110px] rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder="Context, assets, links, constraints, SOPs…"
              />
            </div>
            {taskSuggestedSpecialist && taskForm.assigned_agent_id !== taskSuggestedSpecialist.id && (
              <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <Sparkles className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-medium">Suggested:</span>{" "}
                    <span className="text-primary">
                      {taskSuggestedSpecialist.icon} {taskSuggestedSpecialist.name}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      — {taskSuggestedSpecialist.description}
                    </span>
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 h-7 px-2 text-primary hover:text-primary hover:bg-primary/10"
                  onClick={() =>
                    setTaskForm((prev) => ({
                      ...prev,
                      assigned_agent_id: taskSuggestedSpecialist.id,
                    }))
                  }
                >
                  Use
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 h-7 w-7 p-0"
                  onClick={() => setTaskSuggestionDismissed(true)}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-sm font-medium">Priority</label>
              <select
                value={taskForm.priority}
                onChange={(e) => setTaskForm((p) => ({ ...p, priority: e.target.value }))}
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="urgent">urgent</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Assign / Dispatch Agent</label>
              <select
                value={taskForm.assigned_agent_id}
                onChange={(e) =>
                  setTaskForm((p) => ({ ...p, assigned_agent_id: e.target.value }))
                }
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              >
                <option value="none">Unassigned</option>
                {agents.length > 0 && <option disabled>──────── Gateway Agents ────────</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.id}
                  </option>
                ))}
                {SPECIALIZED_AGENTS.length > 0 && (
                  <option disabled>──────── AI Specialists ────────</option>
                )}
                {SPECIALIZED_AGENTS.map((specialist) => (
                  <option key={specialist.id} value={specialist.id}>
                    {specialist.icon} {specialist.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                If set, task is auto-dispatched immediately after creation.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateTaskOpen(false);
                resetTaskComposer();
              }}
              disabled={taskCreating}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void submitEmployeeTask({
                  title: taskForm.title,
                  description: taskForm.description,
                  priority: taskForm.priority,
                  assignedAgentId:
                    taskForm.assigned_agent_id !== "none"
                      ? taskForm.assigned_agent_id
                      : undefined,
                });
              }}
              disabled={taskCreating || !taskForm.title.trim() || !selected}
            >
              {taskCreating ? "Creating..." : "Create Task"}
            </Button>
            <Button
              onClick={() => {
                void handleEmployeeCreateAndDispatch();
              }}
              disabled={taskCreating || !taskForm.title.trim() || !selected}
            >
              {taskCreating ? "Creating..." : "Create & Dispatch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delegate Objective from manager to teams */}
      <Dialog
        open={delegateOpen}
        onOpenChange={(open) => {
          setDelegateOpen(open);
          if (!open) {
            setDelegationForm({ title: "", description: "", priority: "high" });
          }
        }}
      >
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Delegate Objective via {selected?.name}</DialogTitle>
            <DialogDescription>
              One objective will be split into explicit tasks for this manager&apos;s direct teams and their active members.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <p className="text-xs text-muted-foreground">
                Direct reports: <span className="text-foreground font-medium">{selectedDirectReports.length}</span> •
                team members under them: <span className="text-foreground font-medium">{selectedSecondLevelCount}</span>
              </p>
              {selectedDirectReports.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {selectedDirectReports.map((employee) => (
                    <Badge key={employee.id} variant="outline" className="text-[10px]">
                      {employee.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Objective title</label>
              <input
                value={delegationForm.title}
                onChange={(e) =>
                  setDelegationForm((prev) => ({ ...prev, title: e.target.value }))
                }
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                placeholder="e.g., Stabilize release quality and close top regressions"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Objective context</label>
              <textarea
                value={delegationForm.description}
                onChange={(e) =>
                  setDelegationForm((prev) => ({ ...prev, description: e.target.value }))
                }
                className="w-full min-h-[120px] rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder="Scope, deadline, constraints, risk areas, and success criteria..."
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Priority</label>
              <select
                value={delegationForm.priority}
                onChange={(e) =>
                  setDelegationForm((prev) => ({ ...prev, priority: e.target.value }))
                }
                className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="urgent">urgent</option>
              </select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDelegateOpen(false)} disabled={delegating}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void handleDelegateObjective();
              }}
              disabled={delegating || !delegationForm.title.trim() || !selected}
            >
              {delegating ? "Delegating..." : "Delegate to Teams"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Accounts & Access */}
      <Dialog
        open={manageAccountsOpen}
        onOpenChange={(open) => {
          setManageAccountsOpen(open);
          if (open) {
            setNewAccount({ service: "", label: "", region: "KSA", notes: "" });
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-primary" /> Accounts for {selected?.name}
            </DialogTitle>
            <DialogDescription>
              Add accounts (portal/social/email/WhatsApp) and set permissions for this employee.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Existing access */}
            <div className="min-h-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium">Current access</h3>
                <Button variant="outline" size="sm" onClick={refreshAccountsAndAccess} disabled={accountsLoading}>
                  <RefreshCw className={`w-4 h-4 mr-1.5 ${accountsLoading ? "animate-spin" : ""}`} /> Refresh
                </Button>
              </div>

              <ScrollArea className="h-[55vh] rounded-xl border border-border bg-card/40">
                <div className="p-2 space-y-2">
                  {accountsLoading ? (
                    <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>
                  ) : accessRows.length === 0 ? (
                    <div className="p-10 text-center text-sm text-muted-foreground">
                      No accounts connected to this employee yet.
                    </div>
                  ) : (
                    accessRows.map((row) => (
                      <div key={row.account_id} className="rounded-lg border border-border bg-background/50 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold truncate">{row.label}</div>
                            <div className="text-xs text-muted-foreground font-mono truncate">
                              {row.service}{row.region ? ` • ${row.region}` : ""}
                            </div>
                          </div>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {row.mode}
                          </Badge>
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div className="text-[11px] text-muted-foreground">
                            {row.requires_approval ? "Approval required" : "No approval"}
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
                              defaultValue={row.mode}
                              onChange={async (e) => {
                                if (!selected) return;
                                const mode = e.target.value as "read" | "draft" | "execute";
                                try {
                                  const res = await fetch("/api/employees/access", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      workspace_id: workspaceId,
                                      employee_id: selected.id,
                                      account_id: row.account_id,
                                      mode,
                                      requires_approval: true,
                                    }),
                                  });
                                  if (!res.ok) {
                                    const data = await res.json().catch(() => ({}));
                                    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
                                  }
                                  void refresh();
                                  void refreshAccountsAndAccess();
                                } catch (err) {
                                  setError(err instanceof Error ? err.message : "Failed to update access mode");
                                }
                              }}
                            >
                              <option value="read">read</option>
                              <option value="draft">draft</option>
                              <option value="execute">execute</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Right: Add account + connect */}
            <div className="min-h-0 space-y-4">
              <div className="rounded-xl border border-border bg-card/40 p-4">
                <h3 className="text-sm font-medium">Add account</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  This stores metadata now. Later we’ll add secret storage + login/session handling.
                </p>

                <div className="mt-3 space-y-3">
                  <div className="space-y-1">
                    <label className="text-sm font-medium">Service</label>
                    <input
                      value={newAccount.service}
                      onChange={(e) => setNewAccount((p) => ({ ...p, service: e.target.value }))}
                      className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                      placeholder="e.g., whatsapp, zatca, linkedin, instagram, gmail"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">Label</label>
                    <input
                      value={newAccount.label}
                      onChange={(e) => setNewAccount((p) => ({ ...p, label: e.target.value }))}
                      className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                      placeholder="e.g., KSA WhatsApp #1 / ZATCA Portal User A"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Region</label>
                      <input
                        value={newAccount.region}
                        onChange={(e) => setNewAccount((p) => ({ ...p, region: e.target.value }))}
                        className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                        placeholder="KSA / EU / US"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Default mode</label>
                      <select
                        className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                        defaultValue="draft"
                        onChange={() => {
                          // no-op (kept for future enhancements)
                        }}
                      >
                        <option value="draft">draft</option>
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">Notes</label>
                    <textarea
                      value={newAccount.notes}
                      onChange={(e) => setNewAccount((p) => ({ ...p, notes: e.target.value }))}
                      className="w-full min-h-[80px] rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      placeholder="What is this used for? Any restrictions?"
                    />
                  </div>

                  <Button
                    className="w-full"
                    disabled={!selected || !newAccount.service.trim() || !newAccount.label.trim()}
                    onClick={async () => {
                      if (!selected) return;
                      try {
                        // 1) Create account
                        const accRes = await fetch("/api/accounts", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            workspace_id: workspaceId,
                            service: newAccount.service.trim(),
                            label: newAccount.label.trim(),
                            region: newAccount.region.trim() || null,
                            notes: newAccount.notes,
                          }),
                        });
                        const accData = (await accRes.json()) as { ok?: boolean; account?: { id: string }; error?: string };
                        if (!accRes.ok || !accData.ok || !accData.account?.id) {
                          throw new Error(accData.error || `HTTP ${accRes.status}`);
                        }

                        // 2) Link access (draft + approval required)
                        await fetch("/api/employees/access", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            workspace_id: workspaceId,
                            employee_id: selected.id,
                            account_id: accData.account.id,
                            mode: "draft",
                            requires_approval: true,
                          }),
                        });

                        setNewAccount({ service: "", label: "", region: "KSA", notes: "" });
                        void refresh();
                        void refreshAccountsAndAccess();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Failed to add account");
                      }
                    }}
                  >
                    <Plus className="w-4 h-4 mr-1.5" /> Add & Connect
                  </Button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card/40 p-4">
                <h3 className="text-sm font-medium">Existing accounts</h3>
                <p className="text-xs text-muted-foreground mt-1">(connect an existing account without creating a new one)</p>
                <div className="mt-3 space-y-2">
                  {accounts.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No accounts in this workspace yet.</div>
                  ) : (
                    accounts.slice(0, 10).map((a) => (
                      <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/40 p-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{a.label}</div>
                          <div className="text-[11px] text-muted-foreground font-mono truncate">{a.service}{a.region ? ` • ${a.region}` : ""}</div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            if (!selected) return;
                            try {
                              const res = await fetch("/api/employees/access", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  workspace_id: workspaceId,
                                  employee_id: selected.id,
                                  account_id: a.id,
                                  mode: "draft",
                                  requires_approval: true,
                                }),
                              });
                              if (!res.ok) {
                                const data = await res.json().catch(() => ({}));
                                throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
                              }
                              void refresh();
                              void refreshAccountsAndAccess();
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "Failed to connect account");
                            }
                          }}
                        >
                          Connect
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setManageAccountsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
