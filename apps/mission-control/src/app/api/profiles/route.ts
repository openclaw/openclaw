import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  listProfileWorkspaces,
  logActivity,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import {
  createProfileSchema,
  updateProfileSchema,
  deleteProfileQuerySchema,
  parseOrThrow,
} from "@/lib/schemas";

export const GET = withApiGuard(async () => {
  try {
    const profiles = listProfiles().map((profile) => ({
      ...profile,
      workspaces: listProfileWorkspaces(profile.id),
    }));
    return NextResponse.json({ profiles });
  } catch (error) {
    return handleApiError(error, "Failed to list profiles");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(createProfileSchema, await request.json());

    const profile = createProfile({
      id: `profile-${uuidv4().slice(0, 8)}`,
      name: sanitizeInput(payload.name),
      avatar_color: payload.avatar_color,
      avatar_emoji: payload.avatar_emoji,
    });

    logActivity({
      id: uuidv4(),
      type: "profile_created",
      message: `Profile "${profile.name}" (${profile.id}) created`,
      metadata: { profile_id: profile.id },
    });

    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to create profile");
  }
}, ApiGuardPresets.write);

export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const { id, ...patch } = parseOrThrow(
      updateProfileSchema,
      await request.json()
    );

    const existing = getProfile(id);
    if (!existing) throw new UserError("Profile not found", 404);

    const normalizedPatch: Record<string, unknown> = {};

    if (patch.name !== undefined) {
      normalizedPatch.name = sanitizeInput(patch.name);
    }
    if (patch.avatar_color !== undefined) {
      normalizedPatch.avatar_color = patch.avatar_color;
    }
    if (patch.avatar_emoji !== undefined) {
      normalizedPatch.avatar_emoji = patch.avatar_emoji;
    }

    const profile = updateProfile(
      id,
      normalizedPatch as Parameters<typeof updateProfile>[1]
    );

    logActivity({
      id: uuidv4(),
      type: "profile_updated",
      message: `Profile "${existing.name}" (${id}) updated`,
      metadata: { changes: Object.keys(normalizedPatch) },
    });

    return NextResponse.json({ profile });
  } catch (error) {
    return handleApiError(error, "Failed to update profile");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const { id } = parseOrThrow(deleteProfileQuerySchema, {
      id: searchParams.get("id"),
    });

    const existing = getProfile(id);
    if (!existing) throw new UserError("Profile not found", 404);

    // Prevent deleting the last profile
    if (listProfiles().length <= 1) {
      throw new UserError(
        "Cannot delete the last profile",
        403,
        "FORBIDDEN"
      );
    }

    deleteProfile(id);

    logActivity({
      id: uuidv4(),
      type: "profile_deleted",
      message: `Profile "${existing.name}" (${id}) deleted`,
      metadata: { deleted_profile_id: id },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete profile");
  }
}, ApiGuardPresets.write);
