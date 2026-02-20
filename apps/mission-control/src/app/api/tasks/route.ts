import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  listTasks,
  getTaskWithWorkspace,
  createTask,
  updateTask,
  deleteTask,
  logActivity,
  addSpecialistFeedback,
  listSpecialistFeedback,
  hasActivityForTask,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { getSpecializedAgent } from "@/lib/agent-registry";
import {
  sanitizeInput,
} from "@/lib/validation";
import {
  createTaskSchema,
  deleteTaskQuerySchema,
  parseOrThrow,
  taskListQuerySchema,
  updateTaskSchema,
} from "@/lib/schemas";
import {
  type TaskStatus,
  validateTaskStatusTransition,
} from "@/lib/task-workflow";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

// Valid enum values (must match SQLite CHECK constraints)
type TaskPriority = "low" | "medium" | "high" | "urgent";

function assertValidTaskStatusTransition(params: {
  current: TaskStatus;
  next: TaskStatus;
  assignedAgentId: string | null;
}): void {
  const transition = validateTaskStatusTransition(params);
  if (!transition.ok) {
    throw new UserError(transition.reason || "Invalid task transition", 400);
  }
}

function ensureSystemFeedbackForCompletedTask(params: {
  taskId: string;
  taskTitle: string;
  specialistId: string;
  previousStatus: string;
}): void {
  const { taskId, taskTitle, specialistId, previousStatus } = params;
  const specialist = getSpecializedAgent(specialistId);
  if (!specialist) return;

  const existingFeedback = listSpecialistFeedback({
    specialist_id: specialistId,
    task_id: taskId,
    limit: 1,
  });
  if (existingFeedback.length > 0) return;

  const hasRework = hasActivityForTask("task_rework", taskId, specialistId);
  const rating = hasRework ? 3 : 4;
  const note = hasRework
    ? "Auto-eval: task completed after at least one rework loop."
    : previousStatus === "review"
      ? "Auto-eval: task approved and completed from review."
      : "Auto-eval: task completed without rework events.";

  addSpecialistFeedback({
    id: uuidv4(),
    specialist_id: specialistId,
    task_id: taskId,
    rating,
    dimension: "overall",
    note,
    created_by: "system",
  });

  logActivity({
    id: uuidv4(),
    type: "specialist_feedback_auto",
    task_id: taskId,
    agent_id: specialistId,
    message: `Auto-feedback recorded for "${specialist.name}" on "${taskTitle}"`,
    metadata: {
      rating,
      note,
    },
  });
}

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(taskListQuerySchema, {
      status: searchParams.get("status") ?? undefined,
      mission_id: searchParams.get("mission_id") ?? undefined,
      agent_id: searchParams.get("agent_id") ?? undefined,
      workspace_id: searchParams.get("workspace_id") ?? undefined,
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const tasks = listTasks({
      status: query.status,
      mission_id: query.mission_id,
      assigned_agent_id: query.agent_id,
      workspace_id: query.workspace_id,
    });
    return NextResponse.json({ tasks });
  } catch (error) {
    return handleApiError(error, "Failed to list tasks");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(createTaskSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    if (payload.status && payload.status !== "inbox" && !payload.assigned_agent_id) {
      throw new UserError(
        "Task must be assigned to an agent before starting outside Inbox",
        400
      );
    }

    const task = createTask({
      id: uuidv4(),
      title: sanitizeInput(payload.title),
      description:
        payload.description !== undefined
          ? sanitizeInput(String(payload.description))
          : undefined,
      status: payload.status as TaskStatus | undefined,
      priority: payload.priority as TaskPriority | undefined,
      mission_id: payload.mission_id,
      assigned_agent_id: payload.assigned_agent_id,
      employee_id: payload.employee_id ?? null,
      tags: JSON.stringify(payload.tags ?? []),
      due_date: payload.due_date ? String(payload.due_date).slice(0, 10) : null,
      cost_estimate: payload.cost_estimate ?? null,
      workspace_id: payload.workspace_id,
    });

    logActivity({
      id: uuidv4(),
      type: "task_created",
      task_id: task.id,
      mission_id: task.mission_id ?? undefined,
      message: `Task "${task.title}" created`,
      workspace_id: task.workspace_id,
      metadata: {
        workspace_id: task.workspace_id,
      },
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to create task");
  }
}, ApiGuardPresets.write);

export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const { id, workspace_id, ...patch } = parseOrThrow(updateTaskSchema, await request.json());

    if (!isValidWorkspaceId(workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const existing = getTaskWithWorkspace(id, workspace_id);
    if (!existing) throw new UserError("Task not found", 404);

    const normalizedPatch: Record<string, unknown> = { ...patch };

    if (patch.title != null) {
      normalizedPatch.title = sanitizeInput(String(patch.title));
    }

    if (patch.description != null) {
      normalizedPatch.description = sanitizeInput(String(patch.description));
    }
    if (patch.tags !== undefined) normalizedPatch.tags = JSON.stringify(patch.tags ?? []);
    if (patch.employee_id !== undefined) normalizedPatch.employee_id = patch.employee_id;
    if (patch.due_date !== undefined) {
      normalizedPatch.due_date = patch.due_date ? String(patch.due_date).slice(0, 10) : null;
    }

    const currentStatus = existing.status as TaskStatus;
    const nextStatus = normalizedPatch.status as TaskStatus | undefined;
    const nextAssignedAgentId = Object.prototype.hasOwnProperty.call(
      normalizedPatch,
      "assigned_agent_id"
    )
      ? (normalizedPatch.assigned_agent_id as string | null)
      : existing.assigned_agent_id;

    if (patch.assigned_agent_id !== undefined && !nextAssignedAgentId) {
      const resultingStatus = nextStatus ?? currentStatus;
      if (resultingStatus !== "inbox") {
        throw new UserError(
          "Cannot remove assignee while task is outside Inbox",
          400
        );
      }
    }

    if (nextStatus && nextStatus !== currentStatus) {
      assertValidTaskStatusTransition({
        current: currentStatus,
        next: nextStatus,
        assignedAgentId: nextAssignedAgentId,
      });
    }

    const task = updateTask(id, normalizedPatch as Parameters<typeof updateTask>[1]);

    if (patch.assigned_agent_id !== undefined && patch.assigned_agent_id !== existing.assigned_agent_id) {
      logActivity({
        id: uuidv4(),
        type: "task_assignee_changed",
        task_id: id,
        agent_id: patch.assigned_agent_id ?? undefined,
        message: `Task "${existing.title}" assignee changed`,
        metadata: {
          from: existing.assigned_agent_id,
          to: patch.assigned_agent_id,
        },
        workspace_id: existing.workspace_id,
      });
    }

    if (normalizedPatch.status && normalizedPatch.status !== existing.status) {
      logActivity({
        id: uuidv4(),
        type: "task_status_changed",
        task_id: id,
        agent_id: (normalizedPatch.assigned_agent_id ??
          existing.assigned_agent_id ??
          undefined) as string | undefined,
        message: `Task "${existing.title}" moved from ${existing.status} to ${normalizedPatch.status}`,
        metadata: { from: existing.status, to: normalizedPatch.status },
        workspace_id: existing.workspace_id,
      });

      if (normalizedPatch.status === "done" && existing.assigned_agent_id) {
        ensureSystemFeedbackForCompletedTask({
          taskId: id,
          taskTitle: existing.title,
          specialistId: existing.assigned_agent_id,
          previousStatus: existing.status,
        });
      }
    }

    return NextResponse.json({ task });
  } catch (error) {
    return handleApiError(error, "Failed to update task");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const { id, workspace_id } = parseOrThrow(deleteTaskQuerySchema, {
      id: searchParams.get("id"),
      workspace_id: searchParams.get("workspace_id"),
    });

    if (!isValidWorkspaceId(workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const existing = getTaskWithWorkspace(id, workspace_id);
    if (!existing) throw new UserError("Task not found", 404);

    deleteTask(id);

    logActivity({
      id: uuidv4(),
      type: "task_deleted",
      task_id: id,
      message: `Task "${existing.title}" deleted`,
      workspace_id: existing.workspace_id,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete task");
  }
}, ApiGuardPresets.write);
