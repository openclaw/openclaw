import { NextRequest, NextResponse } from "next/server";
import {
  getProfile,
  getWorkspace,
  listProfileWorkspaces,
  linkProfileWorkspace,
  unlinkProfileWorkspace,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  profileWorkspaceLinkSchema,
  profileWorkspaceUnlinkSchema,
  parseOrThrow,
} from "@/lib/schemas";

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const profileId = searchParams.get("profile_id");

    if (!profileId) {
      throw new UserError("profile_id query parameter is required", 400);
    }

    const profile = getProfile(profileId);
    if (!profile) throw new UserError("Profile not found", 404);

    const workspaces = listProfileWorkspaces(profileId);
    return NextResponse.json({ workspaces });
  } catch (error) {
    return handleApiError(error, "Failed to list profile workspaces");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(
      profileWorkspaceLinkSchema,
      await request.json()
    );

    const profile = getProfile(payload.profile_id);
    if (!profile) throw new UserError("Profile not found", 404);

    const workspace = getWorkspace(payload.workspace_id);
    if (!workspace) throw new UserError("Workspace not found", 404);

    linkProfileWorkspace(
      payload.profile_id,
      payload.workspace_id,
      payload.role ?? "owner"
    );

    const workspaces = listProfileWorkspaces(payload.profile_id);
    return NextResponse.json({ workspaces }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to link workspace to profile");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const { profile_id, workspace_id } = parseOrThrow(
      profileWorkspaceUnlinkSchema,
      {
        profile_id: searchParams.get("profile_id"),
        workspace_id: searchParams.get("workspace_id"),
      }
    );

    unlinkProfileWorkspace(profile_id, workspace_id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to unlink workspace from profile");
  }
}, ApiGuardPresets.write);
