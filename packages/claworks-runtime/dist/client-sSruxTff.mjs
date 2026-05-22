//#region src/claworks/observability.ts
const decisionLog = [];
const observationEvents = [];
const MAX = 500;
let startedAt = Date.now();
function markRuntimeStarted() {
	startedAt = Date.now();
}
function runtimeUptimeSeconds() {
	return Math.floor((Date.now() - startedAt) / 1e3);
}
function appendDecisionLog(entry) {
	decisionLog.unshift({
		id: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		...entry
	});
	if (decisionLog.length > MAX) decisionLog.length = MAX;
}
function listDecisionLog(limit = 50) {
	return decisionLog.slice(0, limit);
}
function appendObservationEvent(source, type, payload) {
	observationEvents.unshift({
		id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		source,
		type,
		payload
	});
	if (observationEvents.length > MAX) observationEvents.length = MAX;
}
function listObservationEvents(limit = 50) {
	return observationEvents.slice(0, limit);
}
function prometheusMetricsText(robotName) {
	return [
		"# HELP claworks_uptime_seconds Process uptime",
		"# TYPE claworks_uptime_seconds gauge",
		`claworks_uptime_seconds{robot="${robotName}"} ${runtimeUptimeSeconds()}`,
		"# HELP claworks_decision_log_entries Decision log size",
		"# TYPE claworks_decision_log_entries gauge",
		`claworks_decision_log_entries ${decisionLog.length}`,
		""
	].join("\n");
}
//#endregion
//#region src/interfaces/a2a/client.ts
var A2aClient = class {
	constructor(opts) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, "");
		this.fetchFn = opts.fetch ?? globalThis.fetch;
		this.headers = opts.headers ?? {};
	}
	async fetchAgentCard() {
		const res = await this.fetchFn(`${this.baseUrl}/.well-known/agent.json`, { headers: this.headers });
		if (!res.ok) throw new Error(`A2A agent card failed: ${res.status}`);
		return await res.json();
	}
	async sendTask(req) {
		const res = await this.fetchFn(`${this.baseUrl}/a2a/tasks/send`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...this.headers
			},
			body: JSON.stringify(req)
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`A2A send failed: ${res.status} ${body}`);
		}
		return await res.json();
	}
	async getTask(taskId) {
		const res = await this.fetchFn(`${this.baseUrl}/a2a/tasks/${taskId}`, { headers: this.headers });
		if (!res.ok) throw new Error(`A2A get task failed: ${res.status}`);
		return await res.json();
	}
	async sendAndWait(req, opts) {
		const pollMs = opts?.pollMs ?? 200;
		const timeoutMs = opts?.timeoutMs ?? 6e4;
		const task = await this.sendTask(req);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const current = await this.getTask(task.id);
			if (current.status === "completed" || current.status === "failed" || current.status === "canceled") return current;
			await new Promise((r) => setTimeout(r, pollMs));
		}
		throw new Error(`A2A task timed out: ${task.id}`);
	}
};
//#endregion
export { listObservationEvents as a, runtimeUptimeSeconds as c, listDecisionLog as i, appendDecisionLog as n, markRuntimeStarted as o, appendObservationEvent as r, prometheusMetricsText as s, A2aClient as t };
