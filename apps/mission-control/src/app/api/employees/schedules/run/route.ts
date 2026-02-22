import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  createTask,
  getEmployeeScheduleWithWorkspace,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { parseOrThrow, runScheduleSchema } from "@/lib/schemas";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(runScheduleSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const schedule = getEmployeeScheduleWithWorkspace(payload.id, payload.workspace_id);
    if (!schedule) {throw new UserError("Schedule not found", 404);}

    const newTask = createTask({
      id: uuidv4(),
      title: schedule.title,
      description: schedule.description || undefined,
      employee_id: schedule.employee_id,
      priority: schedule.priority,
      workspace_id: schedule.workspace_id,
      status: "inbox",
    });

    return NextResponse.json({ ok: true, task_id: newTask.id });
  } catch (error) {
    return handleApiError(error, "Failed to run schedule");
  }
}, ApiGuardPresets.write);
