import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { listEmployees } from "@/lib/db";
import { parseOrThrow, workspaceSchema } from "@/lib/schemas";
import { isValidWorkspaceId } from "@/lib/workspaces-server";
import { z } from "zod";

const querySchema = z.object({
  workspace_id: workspaceSchema,
});

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(querySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const employees = listEmployees({ workspace_id: query.workspace_id });

    const byId = new Map(employees.map((e) => [e.id, e]));
    const children: Record<string, string[]> = {};
    const roots: string[] = [];

    for (const emp of employees) {
      if (!emp.manager_id) {
        roots.push(emp.id);
      } else if (byId.has(emp.manager_id)) {
        children[emp.manager_id] = children[emp.manager_id] || [];
        children[emp.manager_id].push(emp.id);
      } else {
        // manager missing, treat as root
        roots.push(emp.id);
      }
    }

    // sort children by sort_order then name
    const sorter = (a: string, b: string) => {
      const ea = byId.get(a)!;
      const eb = byId.get(b)!;
      return (ea.sort_order ?? 0) - (eb.sort_order ?? 0) || ea.name.localeCompare(eb.name);
    };

    roots.sort(sorter);
    for (const key of Object.keys(children)) {
      children[key].sort(sorter);
    }

    return NextResponse.json({ employees, roots, children });
  } catch (error) {
    return handleApiError(error, "Failed to load employee hierarchy");
  }
}, ApiGuardPresets.read);
