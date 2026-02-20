import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  createEmployee,
  createEmployeeSchedule,
  getEmployeeByRoleKey,
  listEmployeeSchedules,
  listEmployees,
  updateEmployee,
  type Employee,
} from "@/lib/db";
import { computeNextRun } from "@/lib/schedule-engine";
import { sanitizeInput } from "@/lib/validation";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

type EmployeeDepartment =
  | "operations"
  | "sales"
  | "marketing"
  | "finance"
  | "compliance"
  | "engineering"
  | "other";

interface SwarmEmployeeDefinition {
  role_key: string;
  name: string;
  department: EmployeeDepartment;
  description: string;
  manager_role_key?: string;
  sort_order: number;
}

interface SwarmScheduleDefinition {
  employee_role_key: string;
  title: string;
  description: string;
  cron_expression: string;
  timezone: string;
  priority: "low" | "medium" | "high" | "urgent";
  category: "operations" | "other";
  agent_id: string;
}

const SWARM_EMPLOYEES: SwarmEmployeeDefinition[] = [
  {
    role_key: "swarm_manager",
    name: "Swarm Manager",
    department: "operations",
    sort_order: 5,
    description:
      "Owns the full multi-agent workflow. Prioritizes tasks, coordinates groups, resolves blockers, and drives delivery.",
  },
  {
    role_key: "audit_manager",
    name: "Audit Manager",
    department: "compliance",
    manager_role_key: "swarm_manager",
    sort_order: 20,
    description:
      "Leads auditors to review quality, security, and regression risk before and after changes.",
  },
  {
    role_key: "monitor_manager",
    name: "Monitor Manager",
    department: "operations",
    manager_role_key: "swarm_manager",
    sort_order: 30,
    description:
      "Leads monitors to track runtime health, performance, and incidents continuously.",
  },
  {
    role_key: "fixer_manager",
    name: "Fixer Manager",
    department: "engineering",
    manager_role_key: "swarm_manager",
    sort_order: 40,
    description:
      "Leads fixers to implement corrective changes, close bugs fast, and reduce repeated failures.",
  },
  {
    role_key: "documentor_manager",
    name: "Documentor Manager",
    department: "operations",
    manager_role_key: "swarm_manager",
    sort_order: 50,
    description:
      "Leads documentors to keep changelogs, runbooks, and decision history accurate and current.",
  },
  {
    role_key: "code_auditor",
    name: "Code Auditor",
    department: "compliance",
    manager_role_key: "audit_manager",
    sort_order: 21,
    description:
      "Audits pull-ready work for correctness, edge cases, and behavior regressions.",
  },
  {
    role_key: "security_auditor",
    name: "Security Auditor",
    department: "compliance",
    manager_role_key: "audit_manager",
    sort_order: 22,
    description:
      "Reviews sensitive flows for auth, access control, data handling, and abuse-path risks.",
  },
  {
    role_key: "workflow_auditor",
    name: "Workflow Auditor",
    department: "compliance",
    manager_role_key: "audit_manager",
    sort_order: 23,
    description:
      "Audits process quality: test coverage, release hygiene, rollback readiness, and issue handling.",
  },
  {
    role_key: "runtime_monitor",
    name: "Runtime Monitor",
    department: "operations",
    manager_role_key: "monitor_manager",
    sort_order: 31,
    description:
      "Monitors production runtime signals, error streams, and availability to catch incidents early.",
  },
  {
    role_key: "performance_monitor",
    name: "Performance Monitor",
    department: "engineering",
    manager_role_key: "monitor_manager",
    sort_order: 32,
    description:
      "Tracks performance budgets, slow paths, and resource usage trends across key workflows.",
  },
  {
    role_key: "quality_monitor",
    name: "Quality Monitor",
    department: "operations",
    manager_role_key: "monitor_manager",
    sort_order: 33,
    description:
      "Monitors test health and quality trends to detect degradation before customer impact.",
  },
  {
    role_key: "backend_fixer",
    name: "Backend Fixer",
    department: "engineering",
    manager_role_key: "fixer_manager",
    sort_order: 41,
    description:
      "Implements backend fixes for API behavior, data integrity, and reliability defects.",
  },
  {
    role_key: "frontend_fixer",
    name: "Frontend Fixer",
    department: "engineering",
    manager_role_key: "fixer_manager",
    sort_order: 42,
    description:
      "Implements UI/UX fixes for accessibility, responsiveness, state handling, and visual regressions.",
  },
  {
    role_key: "integration_fixer",
    name: "Integration Fixer",
    department: "engineering",
    manager_role_key: "fixer_manager",
    sort_order: 43,
    description:
      "Fixes integration issues across gateway, APIs, automations, and external connectors.",
  },
  {
    role_key: "changelog_documentor",
    name: "Changelog Documentor",
    department: "operations",
    manager_role_key: "documentor_manager",
    sort_order: 51,
    description:
      "Maintains release-ready change summaries with outcomes, risk notes, and validation evidence.",
  },
  {
    role_key: "runbook_documentor",
    name: "Runbook Documentor",
    department: "operations",
    manager_role_key: "documentor_manager",
    sort_order: 52,
    description:
      "Maintains operational runbooks for incidents, triage, rollback steps, and ownership handoffs.",
  },
  {
    role_key: "evidence_documentor",
    name: "Evidence Documentor",
    department: "operations",
    manager_role_key: "documentor_manager",
    sort_order: 53,
    description:
      "Captures decisions, test results, and execution evidence so every fix is traceable.",
  },
];

const SWARM_SCHEDULES: SwarmScheduleDefinition[] = [
  {
    employee_role_key: "swarm_manager",
    title: "Daily swarm coordination",
    description:
      "Review open risk, queue priorities, and handoffs between auditors, monitors, fixers, and documentors.",
    cron_expression: "0 8 * * 1-5",
    timezone: "Asia/Riyadh",
    priority: "high",
    category: "operations",
    agent_id: "main",
  },
  {
    employee_role_key: "audit_manager",
    title: "Daily audit sweep",
    description:
      "Audit recent changes for regressions, security issues, and missed validation paths. Escalate blockers to fixers.",
    cron_expression: "30 8 * * 1-5",
    timezone: "Asia/Riyadh",
    priority: "high",
    category: "operations",
    agent_id: "main",
  },
  {
    employee_role_key: "monitor_manager",
    title: "Hourly monitor pulse",
    description:
      "Review uptime, error, and performance signals. Create remediation tasks for confirmed incidents.",
    cron_expression: "0 * * * *",
    timezone: "Asia/Riyadh",
    priority: "high",
    category: "operations",
    agent_id: "main",
  },
  {
    employee_role_key: "fixer_manager",
    title: "Daily remediation plan",
    description:
      "Prioritize active defects and assign targeted fix work based on severity and customer impact.",
    cron_expression: "0 10 * * 1-5",
    timezone: "Asia/Riyadh",
    priority: "high",
    category: "operations",
    agent_id: "main",
  },
  {
    employee_role_key: "documentor_manager",
    title: "Daily documentation sync",
    description:
      "Update changelogs, runbooks, and evidence logs so operational knowledge stays current.",
    cron_expression: "30 17 * * 1-5",
    timezone: "Asia/Riyadh",
    priority: "medium",
    category: "operations",
    agent_id: "main",
  },
];

function ensureEmployee(
  workspaceId: string,
  definition: SwarmEmployeeDefinition
): { employee: Employee; created: boolean } {
  const existing = getEmployeeByRoleKey({
    workspace_id: workspaceId,
    role_key: definition.role_key,
  });
  const manager = definition.manager_role_key
    ? getEmployeeByRoleKey({
        workspace_id: workspaceId,
        role_key: definition.manager_role_key,
      })
    : undefined;

  if (existing) {
    const patch: Partial<{
      manager_id: string | null;
      sort_order: number;
      description: string;
    }> = {};
    if (existing.manager_id == null && manager?.id) {
      patch.manager_id = manager.id;
    }
    if (Number(existing.sort_order ?? 0) === 0 && definition.sort_order !== 0) {
      patch.sort_order = definition.sort_order;
    }
    if (!existing.description?.trim()) {
      patch.description = sanitizeInput(definition.description);
    }
    if (Object.keys(patch).length > 0) {
      return {
        employee: updateEmployee(existing.id, patch) ?? existing,
        created: false,
      };
    }
    return { employee: existing, created: false };
  }

  return {
    employee: createEmployee({
      id: uuidv4(),
      name: sanitizeInput(definition.name),
      role_key: sanitizeInput(definition.role_key),
      department: sanitizeInput(definition.department),
      status: "active",
      description: sanitizeInput(definition.description),
      manager_id: manager?.id ?? null,
      sort_order: definition.sort_order,
      workspace_id: workspaceId,
    }),
    created: true,
  };
}

/**
 * Seed a grouped multi-agent workforce (managers + auditors + monitors + fixers + documentors).
 * Idempotent by (workspace_id, role_key) for employees and (employee_id, title) for schedules.
 */
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = (await request.json().catch(() => ({}))) as { workspace_id?: string };
    const workspaceId = String(payload.workspace_id || "").trim();

    if (!workspaceId) throw new UserError("workspace_id is required", 400);
    if (!isValidWorkspaceId(workspaceId)) throw new UserError("workspace_id is invalid", 400);

    let createdEmployees = 0;
    for (const definition of SWARM_EMPLOYEES) {
      const ensured = ensureEmployee(workspaceId, definition);
      if (ensured.created) createdEmployees += 1;
    }

    let createdSchedules = 0;
    for (const schedule of SWARM_SCHEDULES) {
      const employee = getEmployeeByRoleKey({
        workspace_id: workspaceId,
        role_key: schedule.employee_role_key,
      });
      if (!employee) continue;

      const existing = listEmployeeSchedules({
        workspace_id: workspaceId,
        employee_id: employee.id,
      });
      if (existing.some((item) => item.title === schedule.title)) {
        continue;
      }

      createEmployeeSchedule({
        id: uuidv4(),
        employee_id: employee.id,
        title: schedule.title,
        description: schedule.description,
        cron_expression: schedule.cron_expression,
        timezone: schedule.timezone,
        agent_id: schedule.agent_id,
        priority: schedule.priority,
        category: schedule.category,
        workspace_id: workspaceId,
        next_run_at: computeNextRun(schedule.cron_expression, schedule.timezone),
      });
      createdSchedules += 1;
    }

    const employees = listEmployees({ workspace_id: workspaceId });
    return NextResponse.json({
      ok: true,
      seeded: true,
      createdEmployees,
      createdSchedules,
      employees,
    });
  } catch (error) {
    return handleApiError(error, "Failed to seed swarm employees");
  }
}, ApiGuardPresets.write);

