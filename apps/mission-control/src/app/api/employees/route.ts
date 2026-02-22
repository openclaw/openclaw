import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  createEmployee,
  deleteEmployee,
  getEmployee,
  getEmployeeAccessSummary,
  listEmployees,
  updateEmployee,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  createEmployeeSchema,
  deleteEmployeeQuerySchema,
  employeesListQuerySchema,
  parseOrThrow,
  updateEmployeeSchema,
} from "@/lib/schemas";
import { sanitizeInput } from "@/lib/validation";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(employeesListQuerySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const employees = listEmployees({ workspace_id: query.workspace_id });
    const accessSummary = getEmployeeAccessSummary(query.workspace_id);

    return NextResponse.json({ employees, accessSummary });
  } catch (error) {
    return handleApiError(error, "Failed to list employees");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(createEmployeeSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const name = sanitizeInput(payload.name);
    const roleKey = sanitizeInput(
      (payload.role_key || name)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_-]/g, "")
    );

    const employee = createEmployee({
      id: uuidv4(),
      name,
      role_key: roleKey,
      department: payload.department,
      status: payload.status,
      description: payload.description ? sanitizeInput(payload.description) : "",
      manager_id: payload.manager_id ?? null,
      sort_order: payload.sort_order,
      workspace_id: payload.workspace_id,
    });

    return NextResponse.json({ ok: true, employee }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to create employee");
  }
}, ApiGuardPresets.write);

export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(updateEmployeeSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const updated = updateEmployee(payload.id, {
      name: payload.name ? sanitizeInput(payload.name) : undefined,
      role_key: payload.role_key ? sanitizeInput(payload.role_key) : undefined,
      department: payload.department,
      status: payload.status,
      description: payload.description ? sanitizeInput(payload.description) : undefined,
      manager_id: payload.manager_id ?? undefined,
      sort_order: payload.sort_order,
      workspace_id: payload.workspace_id,
    });

    if (!updated) {throw new UserError("Employee not found", 404);}

    return NextResponse.json({ ok: true, employee: updated });
  } catch (error) {
    return handleApiError(error, "Failed to update employee");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(deleteEmployeeQuerySchema, {
      id: searchParams.get("id"),
      workspace_id: searchParams.get("workspace_id"),
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    // Direct lookup by ID + workspace check (avoids loading all employees)
    const existing = getEmployee(query.id);
    if (!existing || existing.workspace_id !== query.workspace_id) {
      throw new UserError("Employee not found", 404);
    }

    deleteEmployee(query.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete employee");
  }
}, ApiGuardPresets.write);
