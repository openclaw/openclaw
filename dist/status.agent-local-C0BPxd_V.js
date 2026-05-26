import { T as pathExists } from "./fs-safe-DpJlqO1z.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { n as readSessionStoreReadOnly, t as listGatewayAgentsBasic } from "./agent-list-CGTod7sP.js";
import path from "node:path";
//#region src/commands/status.agent-local.ts
async function getAgentLocalStatuses(cfg) {
	const agentList = listGatewayAgentsBasic(cfg);
	const now = Date.now();
	const statuses = [];
	for (const agent of agentList.agents) {
		const agentId = agent.id;
		const workspaceDir = (() => {
			try {
				return resolveAgentWorkspaceDir(cfg, agentId);
			} catch {
				return null;
			}
		})();
		const bootstrapPath = workspaceDir != null ? path.join(workspaceDir, "BOOTSTRAP.md") : null;
		const bootstrapPending = bootstrapPath != null ? await pathExists(bootstrapPath) : null;
		const sessionsPath = resolveStorePath(cfg.session?.store, { agentId });
		const store = readSessionStoreReadOnly(sessionsPath);
		const sessions = Object.entries(store).filter(([key]) => key !== "global" && key !== "unknown").map(([, entry]) => entry);
		const sessionsCount = sessions.length;
		const lastUpdatedAt = sessions.reduce((max, e) => Math.max(max, e?.updatedAt ?? 0), 0);
		const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
		const lastActiveAgeMs = resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null;
		statuses.push({
			id: agentId,
			name: agent.name,
			workspaceDir,
			bootstrapPending,
			sessionsPath,
			sessionsCount,
			lastUpdatedAt: resolvedLastUpdatedAt,
			lastActiveAgeMs
		});
	}
	const totalSessions = statuses.reduce((sum, s) => sum + s.sessionsCount, 0);
	const bootstrapPendingCount = statuses.reduce((sum, s) => sum + (s.bootstrapPending ? 1 : 0), 0);
	return {
		defaultId: agentList.defaultId,
		agents: statuses,
		totalSessions,
		bootstrapPendingCount
	};
}
//#endregion
export { getAgentLocalStatuses };
