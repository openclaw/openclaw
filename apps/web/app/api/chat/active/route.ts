/**
 * GET /api/chat/active
 *
 * Returns the session IDs of all currently running agent sessions.
 * Used by the sidebar to show streaming indicators.
 */
import { getRunningSessionIds } from "@/lib/active-runs";

export const runtime = "nodejs";

export function GET() {
	return Response.json({ sessionIds: getRunningSessionIds() });
}
