import "./tokens-CFv3Qu_v.js";
import { o as listDescendantRunsForRequester } from "./subagent-registry-read-0y5BjaUV.js";
import { n as readLatestAssistantReply, o as waitForAgentRunsToDrain } from "./run-wait-BlZoP48F.js";
import { n as isLikelyInterimCronMessage } from "./subagent-followup-hints-Q6xOcQiu.js";
//#region src/cron/isolated-agent/subagent-followup.ts
function resolveCronSubagentTimings() {
	const fastTestMode = process.env.OPENCLAW_TEST_FAST === "1";
	return {
		waitMinMs: fastTestMode ? 10 : 3e4,
		finalReplyGraceMs: fastTestMode ? 50 : 5e3,
		gracePollMs: fastTestMode ? 8 : 200
	};
}
async function readDescendantSubagentFallbackReply(params) {
	const descendants = listDescendantRunsForRequester(params.sessionKey).filter((entry) => typeof entry.endedAt === "number" && entry.endedAt >= params.runStartedAt && entry.childSessionKey.trim().length > 0).toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
	if (descendants.length === 0) return;
	const latestByChild = /* @__PURE__ */ new Map();
	for (const entry of descendants) {
		const childKey = entry.childSessionKey.trim();
		if (!childKey) continue;
		const current = latestByChild.get(childKey);
		if (!current || (entry.endedAt ?? 0) >= (current.endedAt ?? 0)) latestByChild.set(childKey, entry);
	}
	const replies = [];
	const latestRuns = [...latestByChild.values()].toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(-4);
	for (const entry of latestRuns) {
		let reply = (await readLatestAssistantReply({ sessionKey: entry.childSessionKey }))?.trim();
		if (!reply && typeof entry.frozenResultText === "string" && entry.frozenResultText.trim()) reply = entry.frozenResultText.trim();
		if (!reply || reply.toUpperCase() === "NO_REPLY".toUpperCase()) continue;
		replies.push(reply);
	}
	if (replies.length === 0) return;
	if (replies.length === 1) return replies[0];
	return replies.join("\n\n");
}
/**
* Waits for descendant subagents to complete using a push-based approach:
* each active descendant run is awaited via `agent.wait` (gateway RPC) instead
* of a busy-poll loop.  After all active runs settle, a short grace period
* polls the cron agent's session for a post-orchestration synthesis message.
*/
async function waitForDescendantSubagentSummary(params) {
	const timings = resolveCronSubagentTimings();
	const initialReply = params.initialReply?.trim();
	const deadline = Date.now() + Math.max(timings.waitMinMs, Math.floor(params.timeoutMs));
	const getActiveRuns = () => listDescendantRunsForRequester(params.sessionKey).filter((entry) => typeof entry.endedAt !== "number");
	const initialActiveRuns = getActiveRuns();
	if (!(params.observedActiveDescendants === true || initialActiveRuns.length > 0)) return initialReply;
	await waitForAgentRunsToDrain({
		deadlineAtMs: deadline,
		initialPendingRunIds: initialActiveRuns.map((entry) => entry.runId),
		getPendingRunIds: () => getActiveRuns().map((entry) => entry.runId)
	});
	const gracePeriodDeadline = Math.min(Date.now() + timings.finalReplyGraceMs, deadline);
	const resolveUsableLatestReply = async () => {
		const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
		if (latest && latest.toUpperCase() !== "NO_REPLY".toUpperCase() && (latest !== initialReply || !isLikelyInterimCronMessage(latest))) return latest;
	};
	while (Date.now() < gracePeriodDeadline) {
		const latest = await resolveUsableLatestReply();
		if (latest) return latest;
		await new Promise((resolve) => setTimeout(resolve, timings.gracePollMs));
	}
	const latest = await resolveUsableLatestReply();
	if (latest) return latest;
}
//#endregion
export { readDescendantSubagentFallbackReply, waitForDescendantSubagentSummary };
