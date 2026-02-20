import { NextRequest, NextResponse } from "next/server";
import { listTasks } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { parseOrThrow, specialistRecommendationSchema } from "@/lib/schemas";
import { rankSpecialistsForTask } from "@/lib/specialist-intelligence";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

// POST /api/agents/specialists/recommend
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(
      specialistRecommendationSchema,
      await request.json()
    );

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const title = payload.title?.trim() || "";
    const description = payload.description?.trim() || "";
    const taskText = `${title}\n${description}`.trim();

    if (!taskText) {
      throw new UserError("Provide title and/or description to recommend specialists", 400);
    }

    const activeTasks = listTasks({
      workspace_id: payload.workspace_id,
    }).filter(
      (task) =>
        task.assigned_agent_id &&
        (task.status === "in_progress" || task.status === "assigned")
    );
    const busyAgentIds = new Set(
      activeTasks
        .map((task) => task.assigned_agent_id)
        .filter((agentId): agentId is string => !!agentId)
    );

    const recommendations = rankSpecialistsForTask(taskText, {
      limit: payload.limit ?? 3,
      busyAgentIds,
      workspaceId: payload.workspace_id,
    });

    return NextResponse.json({
      recommendations,
      workspaceId: payload.workspace_id,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error, "Failed to recommend specialists");
  }
}, ApiGuardPresets.read);
