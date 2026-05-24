import { randomUUID } from "node:crypto";
//#region src/kernel/metrics.ts
var MetricsCollector = class {
	constructor(maxSamples = 1e3) {
		this.counters = /* @__PURE__ */ new Map();
		this.histograms = /* @__PURE__ */ new Map();
		this.startTime = Date.now();
		this.maxSamples = maxSamples;
	}
	increment(name, labels) {
		const key = makeKey(name, labels);
		this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
	}
	incrementBy(name, amount, labels) {
		const key = makeKey(name, labels);
		this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
	}
	getCounter(name, labels) {
		return this.counters.get(makeKey(name, labels)) ?? 0;
	}
	recordDuration(name, durationMs, labels) {
		const key = makeKey(name, labels);
		let hist = this.histograms.get(key);
		if (!hist) {
			hist = [];
			this.histograms.set(key, hist);
		}
		hist.push(durationMs);
		if (hist.length > this.maxSamples) hist.shift();
	}
	getHistogramStats(name, labels) {
		const values = this.histograms.get(makeKey(name, labels));
		if (!values || values.length === 0) return void 0;
		return computeStats(values);
	}
	snapshot() {
		const histSnap = {};
		for (const [key, values] of this.histograms) if (values.length > 0) histSnap[key] = computeStats(values);
		return {
			uptime_ms: Date.now() - this.startTime,
			counters: Object.fromEntries(this.counters),
			histograms: histSnap,
			captured_at: (/* @__PURE__ */ new Date()).toISOString()
		};
	}
	/** Reset all metrics (useful for tests) */
	reset() {
		this.counters.clear();
		this.histograms.clear();
	}
};
function makeKey(name, labels) {
	if (!labels || Object.keys(labels).length === 0) return name;
	return `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`).join(",")}}`;
}
function computeStats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	const percentile = (p) => sorted[Math.floor(sorted.length * p)] ?? 0;
	return {
		count: sorted.length,
		avg: sorted.length > 0 ? Math.round(sum / sorted.length) : 0,
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
		p50: percentile(.5),
		p95: percentile(.95),
		p99: percentile(.99)
	};
}
/** Process-level metrics collector. Import and use directly in hot paths. */
const globalMetrics = new MetricsCollector();
//#endregion
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
	const uptime = runtimeUptimeSeconds();
	const snap = globalMetrics.snapshot();
	const lines = [
		"# HELP claworks_uptime_seconds Process uptime in seconds",
		"# TYPE claworks_uptime_seconds gauge",
		`claworks_uptime_seconds{robot="${robotName}"} ${uptime}`,
		"# HELP claworks_decision_log_entries Number of entries in the in-memory decision log",
		"# TYPE claworks_decision_log_entries gauge",
		`claworks_decision_log_entries ${decisionLog.length}`,
		"# HELP claworks_observation_events Number of entries in the in-memory observation event log",
		"# TYPE claworks_observation_events gauge",
		`claworks_observation_events ${observationEvents.length}`
	];
	const counterEntries = Object.entries(snap.counters);
	if (counterEntries.length > 0) {
		lines.push("# HELP claworks_counter_total Runtime event / capability / playbook counters", "# TYPE claworks_counter_total counter");
		for (const [key, value] of counterEntries) {
			const safeKey = key.replace(/[^a-zA-Z0-9_{}"=,. ]/g, "_");
			lines.push(`claworks_counter_total{name="${safeKey}"} ${value}`);
		}
	}
	const histEntries = Object.entries(snap.histograms);
	if (histEntries.length > 0) {
		lines.push("# HELP claworks_duration_p95_ms p95 duration in milliseconds", "# TYPE claworks_duration_p95_ms gauge");
		for (const [key, stats] of histEntries) {
			const safeKey = key.replace(/[^a-zA-Z0-9_{}"=,. ]/g, "_");
			lines.push(`claworks_duration_p95_ms{name="${safeKey}"} ${stats.p95}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}
//#endregion
//#region src/interfaces/a2a/client.ts
var A2aClient = class {
	constructor(opts) {
		const url = opts.baseUrl.replace(/\/$/, "");
		if (opts.requireHttps && !url.startsWith("https://")) throw new Error(`A2A peer URL must use HTTPS in production (requireHttps=true): ${url}`);
		this.baseUrl = url;
		this.fetchFn = opts.fetch ?? globalThis.fetch;
		this.headers = opts.headers ?? {};
		this.requestTimeoutMs = opts.requestTimeoutMs ?? 1e4;
		this.requireHttps = opts.requireHttps ?? false;
	}
	/** AbortSignal-backed timeout wrapper */
	async fetchWithTimeout(url, init) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		try {
			return await this.fetchFn(url, {
				...init,
				signal: controller.signal
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") throw new Error(`A2A request timed out after ${this.requestTimeoutMs}ms: ${url}`);
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}
	async fetchAgentCard() {
		const res = await this.fetchWithTimeout(`${this.baseUrl}/.well-known/agent.json`, { headers: this.headers });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`A2A agent card failed: ${res.status} ${body}`);
		}
		return await res.json();
	}
	async sendTask(req, opts) {
		const idempotencyKey = opts?.idempotencyKey ?? randomUUID();
		const res = await this.fetchWithTimeout(`${this.baseUrl}/a2a/tasks/send`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Idempotency-Key": idempotencyKey,
				...this.headers
			},
			body: JSON.stringify(req)
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`A2A send failed: ${res.status} ${body}`);
		}
		return await res.json();
	}
	async getTask(taskId) {
		const res = await this.fetchWithTimeout(`${this.baseUrl}/a2a/tasks/${taskId}`, { headers: this.headers });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`A2A get task failed: ${res.status} ${body}`);
		}
		return await res.json();
	}
	async sendAndWait(req, opts) {
		const pollMs = opts?.pollMs ?? 500;
		const timeoutMs = opts?.timeoutMs ?? 6e4;
		const idempotencyKey = opts?.idempotencyKey ?? randomUUID();
		const task = await this.sendTask(req, { idempotencyKey });
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const current = await this.getTask(task.id);
			if (current.status === "completed" || current.status === "failed" || current.status === "canceled") return current;
			const elapsed = Date.now() - (deadline - timeoutMs);
			const nextPoll = Math.min(pollMs * Math.ceil(elapsed / 5e3 + 1), 2e3);
			await new Promise((r) => setTimeout(r, nextPoll));
		}
		throw new Error(`A2A task timed out after ${timeoutMs}ms: ${task.id}`);
	}
};
//#endregion
//#region src/planes/data/kb-types.ts
function isDocumentKnowledgeBase(kb) {
	return typeof kb.ingestDocument === "function";
}
//#endregion
export { listDecisionLog as a, prometheusMetricsText as c, appendObservationEvent as i, runtimeUptimeSeconds as l, A2aClient as n, listObservationEvents as o, appendDecisionLog as r, markRuntimeStarted as s, isDocumentKnowledgeBase as t, globalMetrics as u };
