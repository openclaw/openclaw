import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  listMissions,
  listTasks,
  getMissionWithWorkspace,
  createMission,
  updateMission,
  deleteMission,
  logActivity,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  sanitizeInput,
} from "@/lib/validation";
import {
  createMissionSchema,
  deleteMissionQuerySchema,
  missionListQuerySchema,
  parseOrThrow,
  updateMissionSchema,
} from "@/lib/schemas";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

// Valid enum values (must match SQLite CHECK constraints)
const VALID_STATUS = ["active", "paused", "completed", "archived"] as const;
type MissionStatus = typeof VALID_STATUS[number];

function isValidStatus(s: unknown): s is MissionStatus {
  return typeof s === "string" && VALID_STATUS.includes(s as MissionStatus);
}

export const GET = withApiGuard(async (_request: NextRequest) => {
  try {
    const { searchParams } = new URL(_request.url);
    const query = parseOrThrow(missionListQuerySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const missions = listMissions({
      workspace_id: query.workspace_id,
    });

    const allTasks = listTasks({ workspace_id: query.workspace_id });
    const missionsWithTasks = missions.map((m: { id: string; [key: string]: unknown }) => ({
      ...m,
      tasks: allTasks.filter((t: { mission_id?: string; [key: string]: unknown }) => t.mission_id === m.id)
    }));
    return NextResponse.json({ missions: missionsWithTasks });
  } catch (error) {
    return handleApiError(error, "Failed to list missions");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(createMissionSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const mission = createMission({
      id: uuidv4(),
      name: sanitizeInput(payload.name),
      description:
        payload.description !== undefined
          ? sanitizeInput(String(payload.description))
          : undefined,
      workspace_id: payload.workspace_id,
    });

    logActivity({
      id: uuidv4(),
      type: "mission_created",
      mission_id: mission.id,
      message: `Mission "${mission.name}" created`,
      workspace_id: mission.workspace_id,
    });

    return NextResponse.json({ mission }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to create mission");
  }
}, ApiGuardPresets.write);

export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const { id, workspace_id, ...patch } = parseOrThrow(updateMissionSchema, await request.json());

    if (!isValidWorkspaceId(workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    if (patch.status !== undefined) {
      if (!isValidStatus(patch.status)) {throw new UserError("Invalid status", 400);}
    }

    const existing = getMissionWithWorkspace(id, workspace_id);
    if (!existing) {throw new UserError("Mission not found", 404);}

    if (patch.name !== undefined) {patch.name = sanitizeInput(String(patch.name));}
    if (patch.description !== undefined) {
      patch.description = sanitizeInput(String(patch.description));
    }

    const mission = updateMission(id, patch as Parameters<typeof updateMission>[1]);
    return NextResponse.json({ mission });
  } catch (error) {
    return handleApiError(error, "Failed to update mission");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const { id, workspace_id } = parseOrThrow(deleteMissionQuerySchema, {
      id: searchParams.get("id"),
      workspace_id: searchParams.get("workspace_id"),
    });

    if (!isValidWorkspaceId(workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const existing = getMissionWithWorkspace(id, workspace_id);
    if (!existing) {throw new UserError("Mission not found", 404);}

    deleteMission(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete mission");
  }
}, ApiGuardPresets.write);
