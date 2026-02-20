import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  getDb,
  listAccounts,
  listEmployees,
  upsertEmployeeAccountAccess,
} from "@/lib/db";
import { parseOrThrow, workspaceSchema } from "@/lib/schemas";
import { isValidWorkspaceId } from "@/lib/workspaces-server";
import { z } from "zod";

const listAccessQuerySchema = z.object({
  workspace_id: workspaceSchema,
  employee_id: z.string().min(1),
});

const upsertAccessSchema = z.object({
  workspace_id: workspaceSchema,
  employee_id: z.string().min(1),
  account_id: z.string().min(1),
  mode: z.enum(["read", "draft", "execute"]),
  requires_approval: z.boolean().optional(),
});

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(listAccessQuerySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
      employee_id: searchParams.get("employee_id") ?? undefined,
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const employees = listEmployees({ workspace_id: query.workspace_id });
    const exists = employees.some((e) => e.id === query.employee_id);
    if (!exists) throw new UserError("Employee not found", 404);

    const accounts = listAccounts({ workspace_id: query.workspace_id });

    // Return access as rows with account metadata (matches Employees view expectations)
    const access = getDb()
      .prepare(
        `SELECT x.account_id, x.mode, x.requires_approval,
                a.service, a.label, a.region
         FROM employee_account_access x
         JOIN accounts a ON a.id = x.account_id
         WHERE x.employee_id = ?
         ORDER BY a.service ASC, a.label ASC`
      )
      .all(query.employee_id) as Array<{
      account_id: string;
      mode: "read" | "draft" | "execute";
      requires_approval: number;
      service: string;
      label: string;
      region: string | null;
    }>;

    return NextResponse.json({
      accounts,
      access,
    });
  } catch (error) {
    return handleApiError(error, "Failed to load employee access");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(upsertAccessSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    // best-effort existence checks within workspace
    const employees = listEmployees({ workspace_id: payload.workspace_id });
    if (!employees.some((e) => e.id === payload.employee_id)) {
      throw new UserError("Employee not found", 404);
    }
    const accounts = listAccounts({ workspace_id: payload.workspace_id });
    if (!accounts.some((a) => a.id === payload.account_id)) {
      throw new UserError("Account not found", 404);
    }

    // Default: approval required unless explicitly disabled.
    const requiresApproval = payload.requires_approval ?? (payload.mode !== "read");

    upsertEmployeeAccountAccess({
      employee_id: payload.employee_id,
      account_id: payload.account_id,
      mode: payload.mode,
      requires_approval: requiresApproval,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to update employee access");
  }
}, ApiGuardPresets.write);
