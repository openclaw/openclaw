import { NextRequest, NextResponse } from "next/server";
import { SPECIALIZED_AGENTS, type SpecializedAgent } from "@/lib/agent-registry";
import { listTasks } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { parseOrThrow, specialistWorkspaceQuerySchema } from "@/lib/schemas";
import {
  buildAllSpecialistIntelligence,
  buildAllSpecialistIntelligenceByWorkspace,
  buildSpecialistIntelligence,
  type SpecialistIntelligenceSnapshot,
} from "@/lib/specialist-intelligence";

export interface SpecialistWithStatus extends SpecializedAgent {
  status: "idle" | "busy";
  activeTaskCount: number;
  intelligence: SpecialistIntelligenceSnapshot;
}

// GET /api/agents/specialists - Get all specialists with their current status
export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(specialistWorkspaceQuerySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
    });

    // Get all tasks to check which specialists are busy
    const tasks = query.workspace_id
      ? listTasks({ workspace_id: query.workspace_id })
      : listTasks({});
    const inProgressTasks = tasks.filter(
      (t) => t.status === "in_progress" || t.status === "assigned"
    );

    // Map specialists with their status
    const intelligenceById = query.workspace_id
      ? buildAllSpecialistIntelligenceByWorkspace(query.workspace_id)
      : buildAllSpecialistIntelligence();
    const specialistsWithStatus: SpecialistWithStatus[] =
      SPECIALIZED_AGENTS.map((specialist) => {
        // Count tasks assigned to this specialist
        const activeTaskCount = inProgressTasks.filter(
          (t) => t.assigned_agent_id === specialist.id
        ).length;

        return {
          ...specialist,
          status: activeTaskCount > 0 ? "busy" : "idle",
          activeTaskCount,
          intelligence:
            intelligenceById[specialist.id] ??
            buildSpecialistIntelligence(specialist),
        };
      });

    return NextResponse.json({
      specialists: specialistsWithStatus,
      total: specialistsWithStatus.length,
      busy: specialistsWithStatus.filter((s) => s.status === "busy").length,
      idle: specialistsWithStatus.filter((s) => s.status === "idle").length,
      workspaceId: query.workspace_id ?? null,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error, "Failed to get specialists");
  }
}, ApiGuardPresets.read);
