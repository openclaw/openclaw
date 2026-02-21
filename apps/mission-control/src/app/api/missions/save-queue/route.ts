import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { createMission, createTask, logActivity } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { z } from "zod";
import { parseOrThrow, workspaceSchema, orchestratorTaskSchema } from "@/lib/schemas";
import { sanitizeInput } from "@/lib/validation";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

const saveQueueSchema = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(50000).optional(),
    tasks: z.array(orchestratorTaskSchema).min(1).max(50),
    workspace_id: workspaceSchema,
});

export const POST = withApiGuard(async (request: NextRequest) => {
    try {
        const payload = parseOrThrow(saveQueueSchema, await request.json());

        if (!isValidWorkspaceId(payload.workspace_id)) {
            throw new UserError("workspace_id is invalid", 400);
        }

        const missionId = uuidv4();
        const mission = createMission({
            id: missionId,
            name: sanitizeInput(payload.name),
            description: payload.description
                ? sanitizeInput(String(payload.description))
                : undefined,
            workspace_id: payload.workspace_id,
        });

        logActivity({
            id: uuidv4(),
            type: "mission_created",
            mission_id: mission.id,
            message: `Mission "${mission.name}" created from Orchestrator queue`,
            workspace_id: mission.workspace_id,
            metadata: { taskCount: payload.tasks.length },
        });

        for (const def of payload.tasks) {
            createTask({
                id: uuidv4(),
                title: def.title,
                description: def.description || "",
                priority: def.priority || "medium",
                assigned_agent_id: def.agentId,
                mission_id: missionId,
                workspace_id: payload.workspace_id,
            });
        }

        return NextResponse.json({ ok: true, missionId }, { status: 201 });
    } catch (error) {
        return handleApiError(error, "Failed to save orchestrator queue as mission");
    }
}, ApiGuardPresets.write);
