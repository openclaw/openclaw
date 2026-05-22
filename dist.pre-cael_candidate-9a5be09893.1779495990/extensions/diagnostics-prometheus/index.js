import { s as redactSensitiveText } from "../../redact-Dt7UuSgF.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../api-CcSuiG1s.js";
//#region extensions/diagnostics-prometheus/src/service.ts
const DURATION_BUCKETS_SECONDS = [
	.005,
	.01,
	.025,
	.05,
	.1,
	.25,
	.5,
	1,
	2.5,
	5,
	10,
	30,
	60,
	120,
	300,
	600
];
const TOKEN_BUCKETS = [
	1,
	4,
	16,
	64,
	256,
	1024,
	4096,
	16384,
	65536,
	262144,
	1048576
];
const BYTE_BUCKETS = [
	1024,
	4096,
	16384,
	65536,
	262144,
	1048576,
	4194304,
	16777216,
	67108864,
	268435456,
	1073741824,
	4294967296,
	17179869184
];
const LOW_CARDINALITY_VALUE_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const MAX_PROMETHEUS_SERIES = 2048;
const DROPPED_SERIES_COUNTER_NAME = "openclaw_prometheus_series_dropped_total";
function lowCardinalityLabel(value, fallback = "unknown") {
	if (!value) return fallback;
	const redacted = redactSensitiveText(value.trim());
	return LOW_CARDINALITY_VALUE_RE.test(redacted) ? redacted : fallback;
}
function numericValue(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function seconds(ms) {
	const value = numericValue(ms);
	return value === void 0 ? void 0 : value / 1e3;
}
function sortedLabels(labels) {
	return Object.entries(labels).toSorted(([left], [right]) => left.localeCompare(right));
}
function metricKey(name, labels) {
	return `${name}|${JSON.stringify(sortedLabels(labels))}`;
}
function escapeHelp(value) {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function escapeLabelValue(value) {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}
function formatLabels(labels) {
	const entries = sortedLabels(labels);
	if (entries.length === 0) return "";
	return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}
function formatPrometheusNumber(value) {
	if (!Number.isFinite(value)) return "0";
	return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}
function createPrometheusMetricStore() {
	const counters = /* @__PURE__ */ new Map();
	const gauges = /* @__PURE__ */ new Map();
	const histograms = /* @__PURE__ */ new Map();
	let droppedSeries = 0;
	const canCreateSeries = (map, key, metricName) => {
		if (map.has(key)) return true;
		if (metricName === DROPPED_SERIES_COUNTER_NAME) return true;
		if (counters.size + gauges.size + histograms.size < MAX_PROMETHEUS_SERIES) return true;
		droppedSeries += 1;
		return false;
	};
	const counter = (name, help, labels, amount = 1) => {
		if (!Number.isFinite(amount) || amount <= 0) return;
		const key = metricKey(name, labels);
		if (!canCreateSeries(counters, key, name)) return;
		const existing = counters.get(key);
		if (existing) {
			existing.value += amount;
			return;
		}
		counters.set(key, {
			help,
			labels,
			value: amount
		});
	};
	const gauge = (name, help, labels, value) => {
		if (value === void 0 || !Number.isFinite(value)) return;
		const key = metricKey(name, labels);
		if (!canCreateSeries(gauges, key, name)) return;
		gauges.set(key, {
			help,
			labels,
			value
		});
	};
	const histogram = (name, help, labels, value, buckets = DURATION_BUCKETS_SECONDS) => {
		if (value === void 0 || !Number.isFinite(value) || value < 0) return;
		const key = metricKey(name, labels);
		if (!canCreateSeries(histograms, key, name)) return;
		let sample = histograms.get(key);
		if (!sample) {
			sample = {
				buckets,
				counts: buckets.map(() => 0),
				count: 0,
				help,
				labels,
				sum: 0
			};
			histograms.set(key, sample);
		}
		sample.count += 1;
		sample.sum += value;
		for (let index = 0; index < sample.buckets.length; index += 1) {
			const bucket = sample.buckets[index];
			if (bucket !== void 0 && value <= bucket) sample.counts[index] = (sample.counts[index] ?? 0) + 1;
		}
	};
	const snapshot = () => {
		const counterSnapshot = new Map(counters);
		if (droppedSeries > 0) counterSnapshot.set(metricKey(DROPPED_SERIES_COUNTER_NAME, {}), {
			help: "Prometheus metric series dropped because the exporter series cap was reached.",
			labels: {},
			value: droppedSeries
		});
		return {
			counters: counterSnapshot,
			gauges: new Map(gauges),
			histograms: new Map(histograms)
		};
	};
	const reset = () => {
		counters.clear();
		gauges.clear();
		histograms.clear();
		droppedSeries = 0;
	};
	return {
		counter,
		gauge,
		histogram,
		reset,
		snapshot
	};
}
function safeErrorMessage(err) {
	return redactSensitiveText(err instanceof Error ? err.message ?? err.name : String(err)).replaceAll("\0", " ").replace(/[\r\n\t\u2028\u2029]/gu, " ").slice(0, 500);
}
function renderPrometheusMetrics(store) {
	const snapshot = store.snapshot();
	const lines = [];
	const emitted = /* @__PURE__ */ new Set();
	const emitHeader = (name, type, help) => {
		if (emitted.has(name)) return;
		emitted.add(name);
		lines.push(`# HELP ${name} ${escapeHelp(help)}`);
		lines.push(`# TYPE ${name} ${type}`);
	};
	const counterEntries = [...snapshot.counters.entries()].toSorted(([left], [right]) => left.localeCompare(right));
	for (const [key, sample] of counterEntries) {
		const name = key.split("|", 1)[0] ?? "";
		emitHeader(name, "counter", sample.help);
		lines.push(`${name}${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.value)}`);
	}
	const gaugeEntries = [...snapshot.gauges.entries()].toSorted(([left], [right]) => left.localeCompare(right));
	for (const [key, sample] of gaugeEntries) {
		const name = key.split("|", 1)[0] ?? "";
		emitHeader(name, "gauge", sample.help);
		lines.push(`${name}${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.value)}`);
	}
	const histogramEntries = [...snapshot.histograms.entries()].toSorted(([left], [right]) => left.localeCompare(right));
	for (const [key, sample] of histogramEntries) {
		const name = key.split("|", 1)[0] ?? "";
		emitHeader(name, "histogram", sample.help);
		for (let index = 0; index < sample.buckets.length; index += 1) {
			const bucket = sample.buckets[index];
			if (bucket === void 0) continue;
			lines.push(`${name}_bucket${formatLabels({
				...sample.labels,
				le: String(bucket)
			})} ${formatPrometheusNumber(sample.counts[index] ?? 0)}`);
		}
		lines.push(`${name}_bucket${formatLabels({
			...sample.labels,
			le: "+Inf"
		})} ${formatPrometheusNumber(sample.count)}`);
		lines.push(`${name}_sum${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.sum)}`);
		lines.push(`${name}_count${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.count)}`);
	}
	lines.push("");
	return lines.join("\n");
}
function runLabels(evt) {
	return {
		...evt.blockedBy ? { blocked_by: lowCardinalityLabel(evt.blockedBy) } : {},
		channel: lowCardinalityLabel(evt.channel),
		model: lowCardinalityLabel(evt.model),
		outcome: lowCardinalityLabel(evt.outcome, "unknown"),
		provider: lowCardinalityLabel(evt.provider),
		trigger: lowCardinalityLabel(evt.trigger)
	};
}
function modelCallLabels(evt) {
	return {
		api: lowCardinalityLabel(evt.api),
		error_category: evt.type === "model.call.error" ? lowCardinalityLabel(evt.errorCategory, "other") : "none",
		model: lowCardinalityLabel(evt.model),
		outcome: evt.type === "model.call.error" ? "error" : "completed",
		provider: lowCardinalityLabel(evt.provider),
		transport: lowCardinalityLabel(evt.transport)
	};
}
function toolExecutionLabels(evt) {
	return {
		error_category: evt.type === "tool.execution.error" ? lowCardinalityLabel(evt.errorCategory, "other") : "none",
		outcome: evt.type === "tool.execution.error" ? "error" : "completed",
		params_kind: lowCardinalityLabel(evt.paramsSummary?.kind),
		tool: lowCardinalityLabel(evt.toolName, "tool")
	};
}
function harnessLabels(evt) {
	return {
		channel: lowCardinalityLabel(evt.channel),
		error_category: evt.type === "harness.run.error" ? lowCardinalityLabel(evt.errorCategory, "other") : "none",
		harness: lowCardinalityLabel(evt.harnessId),
		model: lowCardinalityLabel(evt.model),
		outcome: evt.type === "harness.run.error" ? "error" : lowCardinalityLabel(evt.outcome),
		phase: evt.type === "harness.run.error" ? lowCardinalityLabel(evt.phase) : "none",
		plugin: lowCardinalityLabel(evt.pluginId),
		provider: lowCardinalityLabel(evt.provider)
	};
}
function sessionRecoveryLabels(evt) {
	return {
		action: evt.type === "session.recovery.completed" ? lowCardinalityLabel(evt.action, "unknown") : evt.allowActiveAbort ? "abort" : "recover",
		active_work_kind: lowCardinalityLabel(evt.activeWorkKind, "none"),
		state: evt.state,
		status: evt.type === "session.recovery.completed" ? evt.status : "requested"
	};
}
function talkLabels(evt) {
	return {
		brain: lowCardinalityLabel(evt.brain),
		event_type: lowCardinalityLabel(evt.talkEventType),
		mode: lowCardinalityLabel(evt.mode),
		provider: lowCardinalityLabel(evt.provider),
		transport: lowCardinalityLabel(evt.transport)
	};
}
function recordModelUsage(store, evt) {
	const labels = {
		agent: lowCardinalityLabel(evt.agentId),
		channel: lowCardinalityLabel(evt.channel),
		model: lowCardinalityLabel(evt.model),
		provider: lowCardinalityLabel(evt.provider)
	};
	const usage = evt.usage;
	const recordTokens = (tokenType, value) => {
		const amount = numericValue(value);
		if (amount === void 0 || amount === 0) return;
		store.counter("openclaw_model_tokens_total", "Model tokens reported by diagnostic usage events.", {
			...labels,
			token_type: tokenType
		}, amount);
		if (tokenType === "input" || tokenType === "output") store.histogram("openclaw_gen_ai_client_token_usage", "GenAI token usage distribution for input and output tokens.", {
			model: labels.model,
			provider: labels.provider,
			token_type: tokenType
		}, amount, TOKEN_BUCKETS);
	};
	recordTokens("input", usage.input);
	recordTokens("output", usage.output);
	recordTokens("cache_read", usage.cacheRead);
	recordTokens("cache_write", usage.cacheWrite);
	recordTokens("prompt", usage.promptTokens);
	recordTokens("total", usage.total);
	store.counter("openclaw_model_cost_usd_total", "Estimated model cost in USD reported by diagnostic usage events.", labels, numericValue(evt.costUsd) ?? 0);
	store.histogram("openclaw_model_usage_duration_seconds", "Model usage event duration in seconds.", labels, seconds(evt.durationMs));
}
function recordDiagnosticEvent(store, evt, metadata) {
	if (!metadata.trusted) return;
	switch (evt.type) {
		case "model.usage":
			recordModelUsage(store, evt);
			return;
		case "run.completed":
			store.histogram("openclaw_run_duration_seconds", "Agent run duration in seconds.", runLabels(evt), seconds(evt.durationMs));
			store.counter("openclaw_run_completed_total", "Agent runs completed by outcome.", runLabels(evt));
			return;
		case "model.call.completed":
		case "model.call.error":
			store.histogram("openclaw_model_call_duration_seconds", "Provider model call duration in seconds.", modelCallLabels(evt), seconds(evt.durationMs));
			store.counter("openclaw_model_call_total", "Provider model calls completed by outcome.", modelCallLabels(evt));
			return;
		case "tool.execution.completed":
		case "tool.execution.error":
			store.histogram("openclaw_tool_execution_duration_seconds", "Tool execution duration in seconds.", toolExecutionLabels(evt), seconds(evt.durationMs));
			store.counter("openclaw_tool_execution_total", "Tool executions completed by outcome.", toolExecutionLabels(evt));
			return;
		case "harness.run.completed":
		case "harness.run.error":
			store.histogram("openclaw_harness_run_duration_seconds", "Agent harness run duration in seconds.", harnessLabels(evt), seconds(evt.durationMs));
			store.counter("openclaw_harness_run_total", "Agent harness runs completed by outcome.", harnessLabels(evt));
			return;
		case "message.processed":
			store.counter("openclaw_message_processed_total", "Inbound messages processed by outcome.", {
				channel: lowCardinalityLabel(evt.channel),
				outcome: evt.outcome,
				reason: lowCardinalityLabel(evt.reason, "none")
			});
			store.histogram("openclaw_message_processed_duration_seconds", "Inbound message processing duration in seconds.", {
				channel: lowCardinalityLabel(evt.channel),
				outcome: evt.outcome,
				reason: lowCardinalityLabel(evt.reason, "none")
			}, seconds(evt.durationMs));
			return;
		case "message.delivery.started":
			store.counter("openclaw_message_delivery_started_total", "Outbound message delivery attempts started.", {
				channel: lowCardinalityLabel(evt.channel),
				delivery_kind: lowCardinalityLabel(evt.deliveryKind, "other")
			});
			return;
		case "message.delivery.completed":
		case "message.delivery.error":
			store.counter("openclaw_message_delivery_total", "Outbound message delivery attempts by outcome.", {
				channel: lowCardinalityLabel(evt.channel),
				delivery_kind: lowCardinalityLabel(evt.deliveryKind, "other"),
				error_category: evt.type === "message.delivery.error" ? lowCardinalityLabel(evt.errorCategory, "other") : "none",
				outcome: evt.type === "message.delivery.error" ? "error" : "completed"
			});
			store.histogram("openclaw_message_delivery_duration_seconds", "Outbound message delivery duration in seconds.", {
				channel: lowCardinalityLabel(evt.channel),
				delivery_kind: lowCardinalityLabel(evt.deliveryKind, "other"),
				error_category: evt.type === "message.delivery.error" ? lowCardinalityLabel(evt.errorCategory, "other") : "none",
				outcome: evt.type === "message.delivery.error" ? "error" : "completed"
			}, seconds(evt.durationMs));
			return;
		case "talk.event":
			store.counter("openclaw_talk_event_total", "Talk events emitted by type.", talkLabels(evt));
			store.histogram("openclaw_talk_event_duration_seconds", "Talk event duration in seconds when reported.", talkLabels(evt), seconds(evt.durationMs));
			store.histogram("openclaw_talk_audio_bytes", "Talk audio frame byte lengths.", talkLabels(evt), numericValue(evt.byteLength), BYTE_BUCKETS);
			return;
		case "session.recovery.requested":
		case "session.recovery.completed":
			store.counter("openclaw_session_recovery_total", "Session recovery observations by status and action.", sessionRecoveryLabels(evt));
			store.histogram("openclaw_session_recovery_age_seconds", "Age of sessions selected for recovery in seconds.", sessionRecoveryLabels(evt), seconds(evt.ageMs));
			return;
		case "queue.lane.enqueue":
		case "queue.lane.dequeue":
			store.gauge("openclaw_queue_lane_size", "Current diagnostic queue lane size.", { lane: lowCardinalityLabel(evt.lane) }, numericValue(evt.queueSize));
			if (evt.type === "queue.lane.dequeue") store.histogram("openclaw_queue_lane_wait_seconds", "Queue lane wait time in seconds.", { lane: lowCardinalityLabel(evt.lane) }, seconds(evt.waitMs));
			return;
		case "session.state":
			store.counter("openclaw_session_state_total", "Session state observations.", {
				reason: lowCardinalityLabel(evt.reason, "none"),
				state: evt.state
			});
			if (evt.queueDepth !== void 0) store.gauge("openclaw_session_queue_depth", "Latest observed session queue depth.", { state: evt.state }, numericValue(evt.queueDepth));
			return;
		case "diagnostic.memory.sample":
			store.gauge("openclaw_memory_bytes", "Latest process memory usage by memory kind.", { kind: "rss" }, evt.memory.rssBytes);
			store.gauge("openclaw_memory_bytes", "Latest process memory usage by memory kind.", { kind: "heap_total" }, evt.memory.heapTotalBytes);
			store.gauge("openclaw_memory_bytes", "Latest process memory usage by memory kind.", { kind: "heap_used" }, evt.memory.heapUsedBytes);
			store.histogram("openclaw_memory_rss_bytes", "RSS memory sample distribution in bytes.", {}, numericValue(evt.memory.rssBytes), BYTE_BUCKETS);
			return;
		case "diagnostic.memory.pressure":
			store.counter("openclaw_memory_pressure_total", "Memory pressure events by level and reason.", {
				level: evt.level,
				reason: evt.reason
			});
			return;
		case "diagnostic.heartbeat":
		case "diagnostic.liveness.warning": return;
		case "telemetry.exporter":
			store.counter("openclaw_telemetry_exporter_total", "Telemetry exporter lifecycle events.", {
				exporter: lowCardinalityLabel(evt.exporter),
				reason: lowCardinalityLabel(evt.reason, "none"),
				signal: evt.signal,
				status: evt.status
			});
			return;
		default: return;
	}
}
function createMetricsHandler(store) {
	return (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.statusCode = 405;
			res.setHeader("Allow", "GET, HEAD");
			res.end("Method Not Allowed");
			return true;
		}
		const body = renderPrometheusMetrics(store);
		res.statusCode = 200;
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
		if (req.method === "HEAD") {
			res.end();
			return true;
		}
		res.end(body);
		return true;
	};
}
function createDiagnosticsPrometheusExporter() {
	const store = createPrometheusMetricStore();
	let unsubscribe;
	return {
		handler: createMetricsHandler(store),
		render: () => renderPrometheusMetrics(store),
		service: {
			id: "diagnostics-prometheus",
			start(ctx) {
				const subscribe = ctx.internalDiagnostics?.onEvent;
				if (!subscribe) {
					ctx.logger.error("diagnostics-prometheus: internal diagnostics capability unavailable");
					return;
				}
				unsubscribe = subscribe((event, metadata) => {
					try {
						recordDiagnosticEvent(store, event, metadata);
					} catch (err) {
						ctx.logger.error(`diagnostics-prometheus: event handler failed (${event.type}): ${safeErrorMessage(err)}`);
					}
				});
				ctx.internalDiagnostics?.emit({
					type: "telemetry.exporter",
					exporter: "diagnostics-prometheus",
					signal: "metrics",
					status: "started",
					reason: "configured"
				});
			},
			stop() {
				unsubscribe?.();
				unsubscribe = void 0;
				store.reset();
			}
		}
	};
}
//#endregion
//#region extensions/diagnostics-prometheus/index.ts
const exporter = createDiagnosticsPrometheusExporter();
var diagnostics_prometheus_default = definePluginEntry({
	id: "diagnostics-prometheus",
	name: "Diagnostics Prometheus",
	description: "Expose OpenClaw diagnostics metrics in Prometheus text format",
	register(api) {
		api.registerService(exporter.service);
		api.registerHttpRoute({
			path: "/api/diagnostics/prometheus",
			auth: "gateway",
			match: "exact",
			gatewayRuntimeScopeSurface: "trusted-operator",
			handler: exporter.handler
		});
	}
});
//#endregion
export { diagnostics_prometheus_default as default };
