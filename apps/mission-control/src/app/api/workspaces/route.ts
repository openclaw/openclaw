import { NextRequest, NextResponse } from "next/server";
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  logActivity,
} from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  deleteWorkspaceQuerySchema,
  parseOrThrow,
} from "@/lib/schemas";
import { DEFAULT_WORKSPACE } from "@/lib/workspaces";

export const GET = withApiGuard(async () => {
  try {
    const workspaces = listWorkspaces();
    return NextResponse.json({ workspaces });
  } catch (error) {
    return handleApiError(error, "Failed to list workspaces");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(createWorkspaceSchema, await request.json());

    // Check for duplicate id
    const existing = getWorkspace(payload.id);
    if (existing) {
      throw new UserError(
        `Workspace with id "${payload.id}" already exists`,
        409,
        "CONFLICT"
      );
    }

    const workspace = createWorkspace({
      id: payload.id,
      label: sanitizeInput(payload.label),
      color: payload.color,
      folder_path: payload.folder_path ?? null,
      access_mode: payload.access_mode,
    });

    logActivity({
      id: uuidv4(),
      type: "workspace_created",
      message: `Workspace "${workspace.label}" (${workspace.id}) created`,
      workspace_id: workspace.id,
      metadata: {
        workspace_id: workspace.id,
        folder_path: workspace.folder_path,
      },
    });

    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to create workspace");
  }
}, ApiGuardPresets.write);

export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const { id, ...patch } = parseOrThrow(
      updateWorkspaceSchema,
      await request.json()
    );

    const existing = getWorkspace(id);
    if (!existing) throw new UserError("Workspace not found", 404);

    const normalizedPatch: Record<string, unknown> = {};

    if (patch.label !== undefined) {
      normalizedPatch.label = sanitizeInput(patch.label);
    }
    if (patch.color !== undefined) {
      normalizedPatch.color = patch.color;
    }
    if (patch.folder_path !== undefined) {
      normalizedPatch.folder_path = patch.folder_path;
    }
    if (patch.access_mode !== undefined) {
      normalizedPatch.access_mode = patch.access_mode;
    }

    const workspace = updateWorkspace(
      id,
      normalizedPatch as Parameters<typeof updateWorkspace>[1]
    );

    logActivity({
      id: uuidv4(),
      type: "workspace_updated",
      message: `Workspace "${existing.label}" (${id}) updated`,
      workspace_id: id,
      metadata: { changes: Object.keys(normalizedPatch) },
    });

    return NextResponse.json({ workspace });
  } catch (error) {
    return handleApiError(error, "Failed to update workspace");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const { id } = parseOrThrow(deleteWorkspaceQuerySchema, {
      id: searchParams.get("id"),
    });

    // Protect the default workspace from deletion
    if (id === DEFAULT_WORKSPACE) {
      throw new UserError(
        `Cannot delete the default workspace "${DEFAULT_WORKSPACE}"`,
        403,
        "FORBIDDEN"
      );
    }

    const existing = getWorkspace(id);
    if (!existing) throw new UserError("Workspace not found", 404);

    deleteWorkspace(id);

    logActivity({
      id: uuidv4(),
      type: "workspace_deleted",
      message: `Workspace "${existing.label}" (${id}) deleted`,
      metadata: { deleted_workspace_id: id },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete workspace");
  }
}, ApiGuardPresets.write);
