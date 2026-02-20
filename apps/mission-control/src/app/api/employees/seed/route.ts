import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  createEmployee,
  createEmployeeSchedule,
  getEmployeeByRoleKey,
  listEmployees,
  listEmployeeSchedules,
  updateEmployee,
} from "@/lib/db";
import { computeNextRun } from "@/lib/schedule-engine";
import { sanitizeInput } from "@/lib/validation";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

/**
 * Seed a default employee hierarchy for a workspace.
 * Idempotent by (workspace_id, role_key).
 */
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = (await request.json().catch(() => ({}))) as {
      workspace_id?: string;
    };

    const workspaceId = String(payload.workspace_id || "").trim();
    if (!workspaceId) throw new UserError("workspace_id is required", 400);
    if (!isValidWorkspaceId(workspaceId)) throw new UserError("workspace_id is invalid", 400);

    // Ensure at least one Staff Manager exists
    const ensure = (params: {
      role_key: string;
      name: string;
      department: string;
      description: string;
      manager_role_key?: string;
      sort_order: number;
    }) => {
      const existing = getEmployeeByRoleKey({ workspace_id: workspaceId, role_key: params.role_key });
      const manager = params.manager_role_key
        ? getEmployeeByRoleKey({ workspace_id: workspaceId, role_key: params.manager_role_key })
        : undefined;

      if (existing) {
        // keep seed as non-destructive: only fill manager/sort_order if missing
        const patch: { manager_id?: string; sort_order?: number } = {};
        if (existing.manager_id == null && manager?.id) patch.manager_id = manager.id;
        if (Number(existing.sort_order ?? 0) === 0 && params.sort_order !== 0) patch.sort_order = params.sort_order;
        if (Object.keys(patch).length > 0) {
          updateEmployee(existing.id, patch);
        }
        return getEmployeeByRoleKey({ workspace_id: workspaceId, role_key: params.role_key })!;
      }

      return createEmployee({
        id: uuidv4(),
        name: sanitizeInput(params.name),
        role_key: sanitizeInput(params.role_key),
        department: sanitizeInput(params.department),
        status: "active",
        description: sanitizeInput(params.description),
        manager_id: manager?.id ?? null,
        sort_order: params.sort_order,
        workspace_id: workspaceId,
      });
    };

    // Top
    ensure({
      role_key: "staff_manager",
      name: "Staff Manager",
      department: "operations",
      description:
        "Runs the AI office. Breaks objectives into tasks, assigns employees, monitors blockers, escalates for approvals.",
      sort_order: 10,
    });

    // Department managers
    ensure({
      role_key: "sales_manager",
      name: "Sales Manager",
      department: "sales",
      description: "Owns outbound performance, lead routing, and pipeline hygiene.",
      manager_role_key: "staff_manager",
      sort_order: 20,
    });
    ensure({
      role_key: "marketing_manager",
      name: "Marketing Manager",
      department: "marketing",
      description: "Owns content calendar, brand consistency, campaign reporting.",
      manager_role_key: "staff_manager",
      sort_order: 30,
    });
    ensure({
      role_key: "finance_compliance_manager",
      name: "Finance & Compliance Manager",
      department: "compliance",
      description: "Owns accounting close, compliance workflows, ZATCA readiness, audit packs.",
      manager_role_key: "staff_manager",
      sort_order: 40,
    });

    // Sales team
    ensure({
      role_key: "business_development",
      name: "Business Development",
      department: "sales",
      description: "Prospecting, qualification, CRM updates, meeting setting.",
      manager_role_key: "sales_manager",
      sort_order: 21,
    });
    ensure({
      role_key: "cold_email_agent",
      name: "Cold Email Agent",
      department: "sales",
      description: "Writes sequences, personalizes outreach, drafts replies, runs A/B tests (draft-first).",
      manager_role_key: "sales_manager",
      sort_order: 22,
    });
    ensure({
      role_key: "whatsapp_outreach_agent",
      name: "WhatsApp Outreach Agent",
      department: "sales",
      description: "Drafts WhatsApp outreach and follow-ups with opt-out compliance (draft-first).",
      manager_role_key: "sales_manager",
      sort_order: 23,
    });

    // Marketing team
    ensure({
      role_key: "social_media_strategist",
      name: "Social Media Strategist",
      department: "marketing",
      description: "Plans content calendar, hooks, campaign structure, KPIs.",
      manager_role_key: "marketing_manager",
      sort_order: 31,
    });
    ensure({
      role_key: "social_media_copywriter",
      name: "Social Media Copywriter",
      department: "marketing",
      description: "Writes platform-specific posts, captions, hashtags, CTAs.",
      manager_role_key: "marketing_manager",
      sort_order: 32,
    });
    ensure({
      role_key: "social_media_designer",
      name: "Social Media Designer",
      department: "marketing",
      description: "Creates visual assets (carousels/banners), variations, brand kit adherence.",
      manager_role_key: "marketing_manager",
      sort_order: 33,
    });

    // Ops
    ensure({
      role_key: "ceo_assistant",
      name: "CEO Assistant",
      department: "operations",
      description: "Daily brief, reminders, meeting prep, follow-ups. Draft-first for outbound comms.",
      manager_role_key: "staff_manager",
      sort_order: 50,
    });

    // Finance / Compliance
    ensure({
      role_key: "accountant",
      name: "Accountant",
      department: "finance",
      description: "Reconciliation, categorization, month-end reporting (draft-first).",
      manager_role_key: "finance_compliance_manager",
      sort_order: 41,
    });
    ensure({
      role_key: "zatca_manager",
      name: "ZATCA Manager",
      department: "compliance",
      description: "ZATCA e-invoicing compliance checks, filing prep, audit packs (approval-gated).",
      manager_role_key: "finance_compliance_manager",
      sort_order: 42,
    });

    // --- New scheduled employees ---

    const socialMediaManager = ensure({
      role_key: "social_media_manager",
      name: "Social Media Manager",
      department: "marketing",
      description:
        "Manages daily engagement, content calendars, and monthly analytics across all social media platforms.",
      manager_role_key: "marketing_manager",
      sort_order: 34,
    });

    const financialAnalyst = ensure({
      role_key: "financial_analyst",
      name: "Financial Analyst",
      department: "finance",
      description:
        "Handles expense reconciliation, P&L summaries, and ZATCA compliance checks on a recurring basis.",
      manager_role_key: "finance_compliance_manager",
      sort_order: 43,
    });

    const salesDevRep = ensure({
      role_key: "sales_dev_rep",
      name: "Sales Development Rep",
      department: "sales",
      description:
        "Drives lead follow-ups, pipeline reviews, and monthly client outreach campaigns.",
      manager_role_key: "sales_manager",
      sort_order: 24,
    });

    const operationsCoordinator = ensure({
      role_key: "operations_coordinator",
      name: "Operations Coordinator",
      department: "operations",
      description:
        "Runs daily system health checks, weekly standup summaries, and monthly KPI dashboards.",
      manager_role_key: "staff_manager",
      sort_order: 51,
    });

    // --- Seed schedules (idempotent: skip if employee already has schedules) ---

    const ensureSchedules = (
      employeeId: string,
      schedules: Array<{
        title: string;
        description: string;
        cron: string;
        category: string;
        priority?: string;
      }>
    ) => {
      const existing = listEmployeeSchedules({ employee_id: employeeId, workspace_id: workspaceId });
      if (existing.length > 0) return; // already seeded

      const tz = "Asia/Riyadh";
      for (const s of schedules) {
        createEmployeeSchedule({
          id: uuidv4(),
          employee_id: employeeId,
          title: s.title,
          description: s.description,
          cron_expression: s.cron,
          timezone: tz,
          agent_id: "main",
          priority: s.priority ?? "medium",
          category: s.category,
          workspace_id: workspaceId,
          next_run_at: computeNextRun(s.cron, tz),
        });
      }
    };

    // Social Media Manager schedules
    ensureSchedules(socialMediaManager.id, [
      {
        title: "Daily engagement check",
        description:
          "Review all social media accounts for new mentions, comments, and DMs. Respond to high-priority interactions and flag any negative sentiment or trending topics that need immediate attention.",
        cron: "0 9 * * *",
        category: "social_media",
      },
      {
        title: "Weekly content calendar",
        description:
          "Plan and draft the upcoming week's social media content across all platforms. Ensure posts align with the marketing calendar, include appropriate hashtags, and are scheduled for optimal engagement windows.",
        cron: "0 9 * * 1",
        category: "social_media",
      },
      {
        title: "Monthly analytics report",
        description:
          "Compile a comprehensive social media performance report covering follower growth, engagement rates, top-performing posts, and audience demographics. Highlight trends and recommend strategy adjustments for the next month.",
        cron: "0 9 1 * *",
        category: "social_media",
      },
    ]);

    // Financial Analyst schedules
    ensureSchedules(financialAnalyst.id, [
      {
        title: "Daily expense reconciliation",
        description:
          "Match all new transactions against bank statements and categorize unreconciled items. Flag any discrepancies exceeding SAR 500 and prepare a brief summary of the day's cash position.",
        cron: "0 8 * * 1-5",
        category: "finance",
      },
      {
        title: "Weekly P&L summary",
        description:
          "Generate a profit and loss summary for the past week, comparing actual figures against budget. Highlight any line items with variance above 10% and draft commentary for management review.",
        cron: "0 20 * * 0",
        category: "finance",
      },
      {
        title: "Monthly ZATCA compliance check",
        description:
          "Audit all invoices issued during the month for ZATCA e-invoicing compliance. Verify QR codes, tax calculations, and XML formatting. Produce a compliance status report and flag any invoices requiring correction before filing.",
        cron: "0 10 1 * *",
        category: "finance",
      },
    ]);

    // Sales Development Rep schedules
    ensureSchedules(salesDevRep.id, [
      {
        title: "Daily lead follow-ups",
        description:
          "Review the CRM for leads that require follow-up within the next 24 hours. Draft personalized follow-up messages for each lead based on their last interaction and current pipeline stage.",
        cron: "0 9 * * 1-5",
        category: "sales",
      },
      {
        title: "Weekly pipeline review",
        description:
          "Analyze the full sales pipeline for stalled deals, upcoming close dates, and conversion rate trends. Prepare a summary with recommended actions for each deal stage and flag at-risk opportunities.",
        cron: "0 10 * * 1",
        category: "sales",
      },
      {
        title: "Monthly client outreach campaign",
        description:
          "Design and execute a targeted outreach campaign to dormant prospects and past clients. Segment the audience, craft personalized messaging sequences, and schedule the campaign for maximum open-rate timing.",
        cron: "0 9 15 * *",
        category: "sales",
      },
    ]);

    // Operations Coordinator schedules
    ensureSchedules(operationsCoordinator.id, [
      {
        title: "Daily system health check",
        description:
          "Verify that all critical systems (dashboard, gateway, integrations) are operational. Check error logs for recurring issues, confirm scheduled jobs ran successfully, and report any anomalies to the Staff Manager.",
        cron: "0 7 * * *",
        category: "operations",
      },
      {
        title: "Weekly team standup summary",
        description:
          "Compile a summary of the week's completed tasks, blockers, and upcoming priorities across all departments. Format as a concise standup report that can be shared with leadership for visibility.",
        cron: "0 16 * * 5",
        category: "operations",
      },
      {
        title: "Monthly KPI dashboard",
        description:
          "Aggregate key performance indicators from all departments into a unified dashboard report. Include task completion rates, response times, revenue metrics, and operational efficiency scores with month-over-month comparisons.",
        cron: "0 17 28 * *",
        category: "operations",
      },
    ]);

    const employees = listEmployees({ workspace_id: workspaceId });
    return NextResponse.json({ ok: true, seeded: true, employees });
  } catch (error) {
    return handleApiError(error, "Failed to seed employees");
  }
}, ApiGuardPresets.write);
