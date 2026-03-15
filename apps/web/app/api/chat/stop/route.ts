/**
 * POST /api/chat/stop
 *
 * Abort an active agent run. Called by the Stop button.
 * Works for both parent sessions (by sessionId) and subagent sessions (by sessionKey).
 */
import { abortRun, getActiveRun } from "@/lib/active-runs";
import { listSubagentsForRequesterSession } from "@/lib/subagent-registry";
import { trackServer } from "@/lib/telemetry";
import { resolveActiveAgentId } from "@/lib/workspace";
import { resolveSessionKey } from "@/app/api/web-sessions/shared";

export const runtime = "nodejs";

export async function POST(req: Request) {
	const body: { sessionId?: string; sessionKey?: string; cascadeChildren?: boolean } = await req
		.json()
		.catch(() => ({}));

	const isSubagentSession = typeof body.sessionKey === "string" && body.sessionKey.includes(":subagent:");
	const runKey = isSubagentSession && body.sessionKey ? body.sessionKey : body.sessionId;

	if (!runKey) {
		return new Response("sessionId or subagent sessionKey required", { status: 400 });
	}

	const run = getActiveRun(runKey);
	const canAbort =
		run?.status === "running" || run?.status === "waiting-for-subagents";
	const aborted = canAbort ? abortRun(runKey) : false;
	let abortedChildren = 0;

	if (!isSubagentSession && body.sessionId && body.cascadeChildren) {
		const fallbackAgentId = resolveActiveAgentId();
		const requesterSessionKey = resolveSessionKey(body.sessionId, fallbackAgentId);
		for (const subagent of listSubagentsForRequesterSession(requesterSessionKey)) {
			const childRun = getActiveRun(subagent.childSessionKey);
			const canAbortChild =
				childRun?.status === "running" || childRun?.status === "waiting-for-subagents";
			if (canAbortChild && abortRun(subagent.childSessionKey)) {
				abortedChildren += 1;
			}
		}
	}
	if (aborted || abortedChildren > 0) {
		trackServer("chat_stopped");
	}
	return Response.json({ aborted, abortedChildren });
}
