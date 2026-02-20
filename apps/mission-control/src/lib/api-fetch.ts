"use client";

/**
 * Thin wrapper around fetch() that automatically attaches the active
 * profile ID header (X-Profile-Id) to all API requests.
 *
 * Usage:
 *   import { apiFetch } from "@/lib/api-fetch";
 *   const res = await apiFetch("/api/tasks?workspace_id=golden");
 */

const STORAGE_KEY = "oc-active-profile";

export async function apiFetch(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    const profileId =
        typeof window !== "undefined"
            ? localStorage.getItem(STORAGE_KEY)
            : null;

    const headers = new Headers(init?.headers);

    if (profileId) {
        headers.set("x-profile-id", profileId);
    }

    return fetch(input, {
        ...init,
        headers,
    });
}
