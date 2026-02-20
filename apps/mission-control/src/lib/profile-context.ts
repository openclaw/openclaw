import { NextRequest } from "next/server";
import { getProfile, listProfileWorkspaces } from "@/lib/db";
import { apiErrorResponse } from "@/lib/errors";

/**
 * Extract the active profile ID from the request.
 * Checks X-Profile-Id header first, then falls back to cookie.
 */
export function getRequestProfileId(request: NextRequest): string | null {
    return (
        request.headers.get("x-profile-id") ||
        request.cookies.get("oc-active-profile")?.value ||
        null
    );
}

/**
 * Validate that a profile ID exists in the database.
 * Returns the profile if found, null otherwise.
 */
export function validateProfile(profileId: string) {
    return getProfile(profileId) ?? null;
}

/**
 * Check whether a profile is authorized to access a given workspace.
 * Returns true if the profile has a link in profile_workspaces.
 */
export function profileOwnsWorkspace(
    profileId: string,
    workspaceId: string
): boolean {
    const links = listProfileWorkspaces(profileId);
    return links.some((link) => link.workspace_id === workspaceId);
}

/**
 * Full authorization check: extract profile, validate it, and verify
 * workspace access. Returns a NextResponse error if unauthorized, or null
 * if authorized.
 *
 * @param request - The incoming request
 * @param workspaceId - The workspace being accessed (optional — if omitted,
 *   only profile existence is checked)
 * @param requestId - Request tracing ID
 */
export function requireProfileWorkspaceAccess(
    request: NextRequest,
    workspaceId: string | undefined | null,
    requestId?: string
): Response | null {
    const profileId = getRequestProfileId(request);

    // If no profile header is sent, allow the request (backward compatibility
    // for programmatic / gateway callers that don't have a profile concept).
    if (!profileId) return null;

    const profile = validateProfile(profileId);
    if (!profile) {
        return apiErrorResponse({
            message: "Profile not found",
            status: 403,
            code: "INVALID_PROFILE",
            requestId,
        });
    }

    // If a workspace_id is provided, verify the profile owns it
    if (workspaceId) {
        if (!profileOwnsWorkspace(profileId, workspaceId)) {
            return apiErrorResponse({
                message: "Profile does not have access to this workspace",
                status: 403,
                code: "WORKSPACE_ACCESS_DENIED",
                requestId,
            });
        }
    }

    return null; // Authorized
}
