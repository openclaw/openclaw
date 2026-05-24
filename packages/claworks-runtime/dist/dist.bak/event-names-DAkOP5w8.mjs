import { n as A2aClient, r as appendDecisionLog, t as isDocumentKnowledgeBase } from "./kb-types-JeIAB0Dq.mjs";
import { randomUUID } from "node:crypto";
//#region src/claworks/a2a-peers.ts
/** Resolve playbook ``target`` (URL or configured peer name) to an A2A base URL. */
function resolveA2aTarget(target, peers = []) {
	const trimmed = target.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
	const peer = peers.find((p) => p.name === trimmed);
	if (!peer) throw new Error(`Unknown A2A peer "${trimmed}". Configure plugins.entries.claworks-robot.config.a2a.peers or use an http(s) URL.`);
	return peer.url.replace(/\/$/, "");
}
function listA2aPeerNames(peers = []) {
	return peers.map((p) => p.name);
}
//#endregion
//#region src/kernel/llm-context-builder.ts
function inferContextLevel(input) {
	if (input.context_level) return input.context_level;
	if (input.task_type === "classify") return "fast";
	if (input.task_type === "analyze" || input.task_type === "generate") return "rich";
	return "standard";
}
function buildEntitySummary(packet) {
	if (!packet.entities?.length) return null;
	return `关联实体: ${packet.entities.slice(0, 5).map((e) => `${e.type}:${e.name ?? e.id}`).join(", ")}`;
}
function buildMetaStatusSummary(meta) {
	const pendingRuns = meta.pending_runs;
	const playbookCount = meta.playbook_count;
	const hasPending = typeof pendingRuns === "number";
	const hasPlaybooks = typeof playbookCount === "number";
	if (!hasPending && !hasPlaybooks) return null;
	const parts = [];
	if (hasPending) parts.push(`运行中 Playbook ${pendingRuns} 个`);
	if (hasPlaybooks) parts.push(`共 ${playbookCount} 个 Playbook`);
	return `系统状态: ${parts.join(", ")}`;
}
/**
* 构建增强后的 LLM 上下文提示。
*
* 在 context_level=fast 时直接透传；
* standard/rich 时按能力逐步注入领域知识、案例、实体信息、格式要求。
*/
async function buildLlmContext(input, deps = {}) {
	const contextLevel = inferContextLevel(input);
	const domain = input.domain ?? input.event_context?.inferred_domain;
	if (contextLevel === "fast") {
		deps.logger?.(`[llm-ctx] fast mode, no injection. domain=${domain ?? "none"}`);
		return {
			enriched_prompt: input.prompt,
			injected_cases: 0,
			recommended_model_tier: "fast",
			effective_context_level: "fast"
		};
	}
	const injectedParts = [];
	if (input.event_context?.pre_summary) injectedParts.push(`事件摘要: ${input.event_context.pre_summary}`);
	else if (contextLevel === "rich" && input.event_context?.meta) {
		const metaSummary = buildMetaStatusSummary(input.event_context.meta);
		if (metaSummary) injectedParts.push(metaSummary);
	}
	if (input.event_context) {
		const entitySummary = buildEntitySummary(input.event_context);
		if (entitySummary) injectedParts.push(entitySummary);
	}
	if (contextLevel === "rich" && domain && deps.fetchDomainKnowledge) try {
		const knowledge = await deps.fetchDomainKnowledge(domain);
		if (knowledge) injectedParts.push(`领域知识 [${domain}]: ${knowledge}`);
	} catch {
		deps.logger?.(`[llm-ctx] fetchDomainKnowledge failed, skipping.`);
	}
	let injectedCases = 0;
	if (contextLevel === "rich" && deps.fetchCases) {
		const query = [input.prompt.slice(0, 200), input.event_context?.keywords?.slice(0, 5).join(" ") ?? ""].filter(Boolean).join(" ");
		try {
			const cases = await deps.fetchCases(query, 3);
			if (cases.length > 0) {
				injectedCases = cases.length;
				injectedParts.push(`参考案例 (${cases.length}):\n${cases.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`);
			}
		} catch {
			deps.logger?.(`[llm-ctx] fetchCases failed, skipping.`);
		}
	}
	if (input.output_fields?.length) injectedParts.push(`期望输出字段: ${input.output_fields.join(", ")}`);
	let enrichedPrompt = input.prompt;
	if (injectedParts.length > 0) enrichedPrompt = `${injectedParts.join("\n")}\n\n---\n\n${input.prompt}`;
	const recommendedModelTier = injectedCases >= 2 ? "default" : contextLevel === "rich" ? "strong" : "default";
	deps.logger?.(`[llm-ctx] level=${contextLevel} domain=${domain ?? "none"} cases=${injectedCases} tier=${recommendedModelTier}`);
	return {
		enriched_prompt: enrichedPrompt,
		injected_cases: injectedCases,
		recommended_model_tier: recommendedModelTier,
		effective_context_level: contextLevel
	};
}
//#endregion
//#region src/planes/orch/function-executor.ts
async function executeFunction(apiName, params, deps) {
	const name = apiName.trim();
	if (name === "noop") return {
		status: "ok",
		noop: true,
		...params
	};
	if (name === "append_decision_log") {
		appendDecisionLog({
			kind: String(params.kind ?? "playbook_function"),
			playbookId: deps.playbookId,
			runId: deps.runId,
			stepId: deps.stepId,
			summary: String(params.summary ?? ""),
			detail: params.detail ?? {}
		});
		return {
			status: "ok",
			logged: true
		};
	}
	if (name === "publish_event_from_intent") {
		const intent = String(params.intent ?? "none");
		const extracted = params.extracted ?? {};
		const extraFields = params.extra_fields ?? {};
		const source = String(params.source ?? "im-bridge:intent");
		const correlationId = params.correlation_id ? String(params.correlation_id) : void 0;
		const SYSTEM_INTENT_MAP = {
			hitl_approve: "hitl.approve_requested",
			pack_reload: "system.pack_reload_requested",
			kb_query: "kb.query_requested",
			query_kb: "kb.query_requested",
			knowledge_query: "kb.query_requested",
			kb_ingest: "kb.ingest_requested",
			create_task: "task.create_requested",
			task_create: "task.create_requested",
			list_tasks: "task.list_requested",
			task_query: "task.query_requested",
			approve_request: "approval.create_requested",
			approval_create: "approval.create_requested",
			approval_decide: "approval.decision_input",
			alarm_report: "alarm.report_requested",
			workorder_create: "workorder.create_requested",
			workorder_query: "workorder.query_requested",
			equipment_status: "equipment.status_requested",
			report_request: "report.generate_requested",
			daily_report_submit: "daily_report.submit_requested",
			meeting_create: "meeting.created",
			announcement: "announcement.publish",
			quote_request: "quote.create_requested",
			bid_request: "bid.create_requested",
			incident_report: "incident.created",
			shift_handover: "shift.handover_requested",
			maintenance_query: "maintenance.query_requested",
			safety_alert: "safety.alert_reported",
			chat: "none",
			help: "none",
			unknown: "none"
		};
		const registryMapping = deps.intentRegistry?.resolve(intent);
		const eventType = registryMapping?.eventType ?? SYSTEM_INTENT_MAP[intent] ?? `intent.${intent}`;
		if (intent === "none" || eventType === "none") return {
			status: "skipped",
			intent,
			reason: "non-business intent, no event published"
		};
		if (!registryMapping && !SYSTEM_INTENT_MAP[intent]) deps.logger?.(`[claworks:function] unmapped intent '${intent}' — routing to generic event '${eventType}'`);
		if (deps.publishEvent) {
			await deps.publishEvent(eventType, source, {
				...extracted,
				...extraFields,
				_intent: intent
			}, correlationId);
			return {
				status: "published",
				eventType,
				source,
				intent
			};
		}
		return {
			status: "stub",
			eventType,
			source,
			intent
		};
	}
	if (name === "DiagnoseEquipment" || name === "diagnose_equipment") {
		const equipmentId = String(params.equipment?.id ?? params.equipment_id ?? params.alarm_id ?? "");
		if (deps.llmComplete) {
			const prompt = [
				"You are an industrial equipment diagnostician.",
				`Equipment: ${equipmentId}`,
				`Alarm: ${params.alarm_id ?? "unknown"}`,
				`Context: ${JSON.stringify(params.reading_values ?? {})}`,
				"Respond with JSON: {\"confidence\":0.0-1.0,\"summary\":\"...\"}"
			].join("\n");
			try {
				const parsed = tryParseJson((await deps.llmComplete({ prompt })).text);
				if (parsed) {
					appendDecisionLog({
						kind: "llm_diagnose",
						playbookId: deps.playbookId,
						runId: deps.runId,
						stepId: deps.stepId,
						summary: String(parsed.summary ?? "LLM diagnosis"),
						detail: parsed
					});
					return {
						status: "ok",
						...parsed
					};
				}
			} catch (err) {
				deps.logger?.(`[claworks:function] LLM diagnose failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return {
			status: "ok",
			confidence: .82,
			summary: `Automated diagnosis for equipment ${equipmentId || "unknown"}`,
			diagnosis_summary: `Review alarm ${params.alarm_id ?? ""} and recent readings.`
		};
	}
	if (name === "object_map") {
		const source = params.source ?? {};
		const mappings = params.mappings ?? {};
		const result = { ...source };
		for (const [oldKey, newKey] of Object.entries(mappings)) if (oldKey in source) {
			result[newKey] = source[oldKey];
			if (newKey !== oldKey) delete result[oldKey];
		}
		return {
			status: "ok",
			result,
			mapped: Object.keys(mappings).length
		};
	}
	if (name === "object_merge") {
		const base = params.base ?? {};
		const extra = params.extra ?? {};
		return {
			status: "ok",
			result: {
				...base,
				...extra
			}
		};
	}
	if (name === "object_pick") {
		const source = params.source ?? {};
		const keys = Array.isArray(params.keys) ? params.keys : [];
		const result = {};
		for (const k of keys) if (k in source) result[k] = source[k];
		return {
			status: "ok",
			result
		};
	}
	if (name === "object_omit") {
		const source = params.source ?? {};
		const keys = new Set(Array.isArray(params.keys) ? params.keys : []);
		const result = {};
		for (const [k, v] of Object.entries(source)) if (!keys.has(k)) result[k] = v;
		return {
			status: "ok",
			result
		};
	}
	if (name === "string_format" || name === "format_string") {
		const template = String(params.template ?? params.format ?? "");
		const values = params.values ?? params;
		return {
			status: "ok",
			result: template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""))
		};
	}
	if (name === "conditional") {
		const condition = params.condition;
		const passed = condition === true || condition === "true" || condition !== false && condition !== "false" && condition !== "" && condition !== null && condition !== void 0 && condition !== 0;
		return {
			status: "ok",
			passed,
			result: passed
		};
	}
	deps.logger?.(`[claworks:function] unknown function "${name}" — ${deps.productionMode ? "throwing" : "returning stub"}`);
	deps.publishAnomaly?.({
		kind: "unknown_function",
		function: name,
		params
	});
	if (deps.productionMode) throw new Error(`未知 function: "${name}"，请检查 Playbook 配置或注册对应 Pack`);
	return {
		status: "stub",
		function: name,
		params
	};
}
function tryParseJson(text) {
	const trimmed = text.trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(trimmed.slice(start, end + 1));
	} catch {
		return null;
	}
}
//#endregion
//#region src/kernel/glob.ts
/** Minimal glob matcher for event type patterns (`alarm.*`, `workorder.#`). */
function matchGlob(pattern, value) {
	if (pattern === value) return true;
	return globToRegExp(pattern).test(value);
}
function globToRegExp(pattern) {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") re += ".*";
		else if (ch === "#") re += "[^.]+";
		else if (ch === "?") re += ".";
		else if (/[.+^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
		else re += ch;
	}
	re += "$";
	return new RegExp(re);
}
//#endregion
//#region src/kernel/playbook-matcher.ts
function createPlaybookMatcher() {
	let rules = [];
	/**
	* 精确匹配索引：eventType → 规则列表（无通配符 pattern 才入索引）。
	* 热路径从 O(n) 全量遍历降为 O(1) + 少量通配符扫描。
	* 语义回退（semantic fallback）仍需扫描全量规则，但仅在无 glob 命中时执行。
	*/
	const exactIndex = /* @__PURE__ */ new Map();
	let wildcardRules = [];
	function buildIndex(newRules) {
		exactIndex.clear();
		wildcardRules = [];
		for (const rule of newRules) {
			if (rule.trigger.kind !== "event") continue;
			const p = rule.trigger.pattern;
			if (!p.includes("*") && !p.includes("?")) {
				const bucket = exactIndex.get(p);
				if (bucket) bucket.push(rule);
				else exactIndex.set(p, [rule]);
			} else wildcardRules.push(rule);
		}
	}
	return {
		load(playbooks) {
			rules = playbooks.filter((p) => p.trigger.kind === "event").map((p) => ({
				playbookId: p.id,
				trigger: p.trigger,
				priority: p.priority
			}));
			buildIndex(rules);
		},
		match(event) {
			const matches = [];
			const semanticCandidates = [];
			const exactHits = exactIndex.get(event.type) ?? [];
			const exactHitSet = new Set(exactHits);
			const hotCandidates = exactHits.length > 0 ? [...exactHits, ...wildcardRules] : wildcardRules;
			for (const rule of hotCandidates) {
				if (rule.trigger.kind !== "event") continue;
				if (!(exactHitSet.has(rule) || matchGlob(rule.trigger.pattern, event.type))) continue;
				if (rule.trigger.filter && !matchesFilter(rule.trigger.filter, event.payload)) continue;
				if (rule.trigger.condition && !evaluateCondition(rule.trigger.condition, event.payload)) continue;
				matches.push({
					event,
					playbookId: rule.playbookId,
					priority: rule.priority,
					input: {
						...event.payload,
						_event: event
					}
				});
			}
			if (matches.length === 0) {
				for (const rule of rules) {
					if (rule.trigger.kind !== "event") continue;
					if (matchGlob(rule.trigger.pattern, event.type)) continue;
					if (semanticFallbackScore(rule.trigger.pattern, event.type) < .5) continue;
					if (rule.trigger.filter && !matchesFilter(rule.trigger.filter, event.payload)) continue;
					if (rule.trigger.condition && !evaluateCondition(rule.trigger.condition, event.payload)) continue;
					semanticCandidates.push({
						event,
						playbookId: rule.playbookId,
						priority: rule.priority,
						input: {
							...event.payload,
							_event: event
						}
					});
				}
				if (semanticCandidates.length > 0) {
					semanticCandidates.sort((a, b) => b.priority - a.priority);
					matches.push(semanticCandidates[0]);
				}
			}
			matches.sort((a, b) => b.priority - a.priority);
			return matches;
		}
	};
}
/** Token overlap fallback when glob patterns miss (e.g. alarm.triggered ≈ alarm.created). */
function semanticFallbackScore(pattern, eventType) {
	const a = tokenizeEventKey(pattern);
	const b = tokenizeEventKey(eventType);
	if (a.size === 0 || b.size === 0) return 0;
	let overlap = 0;
	for (const t of a) if (b.has(t)) overlap += 1;
	return overlap / Math.max(a.size, b.size);
}
function tokenizeEventKey(value) {
	return new Set(value.toLowerCase().split(/[.*_\-/]+/).map((s) => s.trim()).filter((s) => s.length > 1 && s !== "*"));
}
function matchesFilter(filter, payload) {
	for (const [key, expected] of Object.entries(filter)) if (payload[key] !== expected) return false;
	return true;
}
/** Best-effort translation of Python-style pack conditions. */
function evaluateCondition(condition, payload) {
	const trimmed = condition.trim();
	const inList = trimmed.match(/payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s+in\s+\(([^)]+)\)/);
	if (inList) {
		const value = String(payload[inList[1]] ?? "");
		return inList[2].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).includes(value);
	}
	if (trimmed.includes(" and ")) return trimmed.split(/\s+and\s+/).every((part) => evaluateCondition(part.trim(), payload));
	const getMatch = trimmed.match(/payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)/);
	if (getMatch) {
		const key = getMatch[1];
		if (trimmed.startsWith("bool(") || trimmed.includes("bool(payload")) return Boolean(payload[key]);
		return payload[key] != null;
	}
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	return true;
}
//#endregion
//#region src/planes/orch/template-resolve.ts
function parseSlice(spec) {
	const m = spec.match(/^\[:(\d+)\]$/);
	if (m) return {
		start: 0,
		end: Number(m[1])
	};
	return { start: 0 };
}
/** Resolve `steps['a']['result'].get('b', [])[:5]` style expressions to JS values. */
function resolveStepsExpression(expr, vars) {
	const trimmed = expr.trim();
	const steps = vars.steps ?? {};
	const match = trimmed.match(/^steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*([^)]+))?\s*\)(.*)$/);
	if (!match) return;
	const stepId = match[1];
	const field = match[2];
	const fallbackRaw = match[3]?.trim();
	const sliceSpec = match[4]?.trim() ?? "";
	let fallback = [];
	if (fallbackRaw === "[]") fallback = [];
	else if (fallbackRaw?.startsWith("'") || fallbackRaw?.startsWith("\"")) fallback = fallbackRaw.slice(1, -1);
	else if (fallbackRaw && fallbackRaw !== "None") fallback = fallbackRaw;
	let value = (steps[stepId]?.result ?? {})[field] ?? fallback;
	if (sliceSpec) {
		const slice = parseSlice(sliceSpec);
		if (Array.isArray(value)) value = value.slice(slice.start, slice.end);
	}
	return value;
}
function resolveLenExpression(expr, vars) {
	const m = expr.trim().match(/^len\((.+)\)$/);
	if (!m) return null;
	const value = resolveStepsExpression(m[1].trim(), vars);
	if (Array.isArray(value)) return value.length;
	if (value && typeof value === "object" && "count" in value) return Number(value.count);
	return 0;
}
const FOR_LOOP_RE = /\{%\s*for\s+(\w+)\s+in\s+([^%]+?)\s*%}([\s\S]*?)\{%\s*endfor\s*%}/g;
function renderForBody(body, itemVar, item, index) {
	return body.replace(/\{\{\s*loop\.index\s*\}\}/g, String(index + 1)).replace(new RegExp(`\\{\\{\\s*${itemVar}\\.get\\(\\s*['"](\\w+)['"]\\s*(?:,\\s*[^)]+)?\\s*\\)\\s*\\}\\}`, "g"), (_, key) => String(item[key] ?? ""));
}
/** Expand Jinja-style `{% for x in expr %}...{% endfor %}` using step result arrays. */
function expandJinjaForLoops(template, vars) {
	return template.replace(FOR_LOOP_RE, (_full, itemVar, listExpr, body) => {
		const items = resolveStepsExpression(String(listExpr), vars);
		if (!Array.isArray(items) || items.length === 0) return "";
		return items.map((entry, index) => {
			return renderForBody(String(body), String(itemVar), entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { value: entry }, index);
		}).join("");
	});
}
//#endregion
//#region src/planes/orch/step-conditions.ts
/** Evaluate pack YAML step/trigger conditions (Python-style subset). */
function evaluatePlaybookCondition(condition, variables) {
	if (!condition?.trim()) return true;
	const interpolated = interpolate(condition.trim(), variables);
	if (!interpolated.includes("{{")) {
		if (interpolated === "" || interpolated === "false" || interpolated === "0") return false;
		if (condition.trim().startsWith("{{") && !/[><=!]/.test(interpolated)) return true;
	}
	const expr = interpolated.trim();
	const payload = variables.payload ?? variables;
	const steps = variables.steps ?? {};
	if (/ or /.test(expr)) return expr.split(/ or /).some((part) => evaluatePlaybookCondition(part.trim(), variables));
	if (/ and /.test(expr)) return expr.split(/ and /).every((part) => evaluatePlaybookCondition(part.trim(), variables));
	if (/^not\s+/.test(expr)) return !evaluatePlaybookCondition(expr.slice(4).trim(), variables);
	const inList = expr.match(/payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s+in\s+\(([^)]+)\)/);
	if (inList) {
		const value = String(payload[inList[1]] ?? "");
		return inList[2].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).includes(value);
	}
	const floatCmp = expr.match(/float\(\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*\)\s*(>|>=|<|<=|==|!=)\s*([\d.]+)/);
	if (floatCmp) {
		const raw = (steps[floatCmp[1]]?.result ?? {})[floatCmp[2]];
		const fallback = Number.parseFloat(floatCmp[3]);
		const left = Number.parseFloat(String(raw ?? fallback));
		const op = floatCmp[4];
		const right = Number.parseFloat(floatCmp[5]);
		if (op === ">") return left > right;
		if (op === ">=") return left >= right;
		if (op === "<") return left < right;
		if (op === "<=") return left <= right;
		if (op === "==") return left === right;
		if (op === "!=") return left !== right;
	}
	const stepsStatus = expr.match(/steps\.get\(\s*['"](\w+)['"]\s*,\s*\{\}\)\.get\(\s*['"]status['"]\s*\)\s*==\s*['"](\w+)['"]/);
	if (stepsStatus) return steps[stepsStatus[1]]?.status === stepsStatus[2];
	const lenGt = expr.match(/^len\((.+)\)\s*>\s*(\d+)$/);
	if (lenGt) {
		const length = resolveLenExpression(`len(${lenGt[1]})`, variables);
		return length != null && length > Number(lenGt[2]);
	}
	const stepsChoice = expr.match(/steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*(==|!=)\s*['"]([^'"]*)['"]/);
	if (stepsChoice) {
		const result = steps[stepsChoice[1]]?.result ?? {};
		const actual = String(result[stepsChoice[2]] ?? "");
		return stepsChoice[3] === "==" ? actual === stepsChoice[4] : actual !== stepsChoice[4];
	}
	const simpleCmp = expr.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
	if (simpleCmp) {
		const lhs = simpleCmp[1].trim().replace(/^['"]|['"]$/g, "");
		const op = simpleCmp[2];
		const rhs = simpleCmp[3].trim().replace(/^['"]|['"]$/g, "");
		const lNum = Number(lhs);
		const rNum = Number(rhs);
		if (!Number.isNaN(lNum) && !Number.isNaN(rNum)) {
			if (op === ">") return lNum > rNum;
			if (op === ">=") return lNum >= rNum;
			if (op === "<") return lNum < rNum;
			if (op === "<=") return lNum <= rNum;
			if (op === "==") return lNum === rNum;
			if (op === "!=") return lNum !== rNum;
		}
		if (op === "==") return lhs === rhs;
		if (op === "!=") return lhs !== rhs;
	}
	if (expr.includes("payload.")) return evaluateCondition(expr, payload);
	return true;
}
//#endregion
//#region src/planes/orch/step-executor.ts
var HitlSuspendedError = class extends Error {
	constructor(token, stepId) {
		super(`HITL suspended: ${token}`);
		this.token = token;
		this.stepId = stepId;
		this.name = "HitlSuspendedError";
	}
};
var StepFailedError = class extends Error {
	constructor(message, stepId, policy) {
		super(message);
		this.stepId = stepId;
		this.policy = policy;
		this.name = "StepFailedError";
	}
};
function recordStepResult(ctx, stepId, output, status = "ok") {
	const steps = ctx.variables.steps ?? {};
	steps[stepId] = {
		status,
		result: output && typeof output === "object" && !Array.isArray(output) ? output : { value: output }
	};
	ctx.variables.steps = steps;
}
function resolveParams(params, ctx) {
	return resolveParamsDeep(params, ctx.variables);
}
function resolveParamsDeep(value, vars) {
	if (typeof value === "string") return interpolate(value, vars);
	if (Array.isArray(value)) return value.map((item) => resolveParamsDeep(item, vars));
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, child] of Object.entries(value)) out[key] = resolveParamsDeep(child, vars);
		return out;
	}
	return value;
}
async function executePlaybookStep(step, ctx, run, deps) {
	const meta = step;
	if (meta.condition && !evaluatePlaybookCondition(meta.condition, ctx.variables)) {
		const skipLog = {
			stepId: step.id,
			status: "skipped",
			startedAt: /* @__PURE__ */ new Date(),
			completedAt: /* @__PURE__ */ new Date(),
			input: step,
			output: {
				skipped: true,
				reason: "condition"
			}
		};
		run.steps.push(skipLog);
		return;
	}
	const log = {
		stepId: step.id,
		status: "running",
		startedAt: /* @__PURE__ */ new Date(),
		input: step
	};
	run.steps.push(log);
	try {
		if (step.kind === "notification") {
			const msg = interpolate(step.message, ctx.variables);
			const channelField = step.channel;
			const resolvedChannels = (step.channels ?? (channelField ? [channelField] : void 0))?.map((c) => interpolate(c, ctx.variables)).filter(Boolean);
			if (deps.notify) await deps.notify({
				message: msg,
				channels: resolvedChannels
			});
			else deps.logger?.(`[claworks:notify] ${msg} channels=${resolvedChannels?.join(",") ?? "log"}`);
			log.output = {
				message: msg,
				channels: resolvedChannels
			};
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "action") {
			const actionStart = Date.now();
			const slowTimer = setTimeout(() => {
				ctx.publishEvent?.("playbook.step_slow", "step-executor", {
					playbook_id: ctx.playbookId,
					run_id: ctx.runId,
					step_id: step.id,
					step_name: step.name ?? step.id,
					action: step.action ?? step.id,
					elapsed_ms: Date.now() - actionStart,
					requester_channel: ctx.variables.requester_channel ?? ctx.variables.channel ?? "",
					user_id: ctx.variables.user_id ?? ""
				}, ctx.runId).catch(() => {});
			}, 5e3);
			try {
				log.output = await executeActionStep(step, ctx, deps);
			} finally {
				clearTimeout(slowTimer);
			}
			recordStepResult(ctx, step.id, log.output);
			await maybeHitlAfterStep(step, ctx, run, deps, log.output);
		} else if (step.kind === "function") {
			const params = resolveParams(step.params, ctx);
			const result = await executeFunction(step.functionApiName, params, {
				kb: deps.kb,
				llmComplete: deps.llmComplete,
				publishEvent: ctx.publishEvent,
				intentRegistry: deps.intentRegistry,
				logger: deps.logger,
				playbookId: ctx.playbookId,
				runId: ctx.runId,
				stepId: step.id,
				productionMode: deps.productionMode,
				publishAnomaly: deps.publishAnomaly
			});
			log.output = result;
			if (step.output) ctx.variables[step.output] = result;
			recordStepResult(ctx, step.id, result);
		} else if (step.kind === "connector") {
			if (!deps.connectorInvoke) throw new Error("connector step requires connector runtime");
			await deps.connectorInvoke(step.connectorId, step.method, step.params);
			log.output = { invoked: true };
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "playbook") {
			if (!deps.triggerPlaybook) throw new Error("playbook step requires triggerPlaybook");
			const child = await deps.triggerPlaybook(step.playbookId, {
				...step.input,
				parent_run_id: ctx.runId
			});
			log.output = {
				run_id: child.id,
				status: child.status
			};
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "atomic") {
			log.output = await executeAtomic(step.fn, step.params, ctx, deps);
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "hitl") {
			const token = deps.hitl.suspend(run, step.id, step.message, step.options, step.timeout_seconds, step.on_timeout);
			if (deps.notify) {
				const timeoutNote = step.timeout_seconds ? ` (${step.timeout_seconds}s 后自动${step.on_timeout === "abort" ? "终止" : `选择「${step.on_timeout ?? step.options[0]}」`})` : "";
				await deps.notify({
					message: `[HITL] ${interpolate(step.message, ctx.variables)}${timeoutNote} (run=${run.id} step=${step.id})`,
					channels: step.channel ? [step.channel] : void 0
				});
			}
			run.status = "waiting_hitl";
			log.status = "waiting";
			log.output = {
				hitl_token: token,
				timeout_seconds: step.timeout_seconds
			};
			throw new HitlSuspendedError(token, step.id);
		} else if (step.kind === "llm") {
			const rawPrompt = interpolate(step.prompt, ctx.variables);
			const eventCtx = ctx.variables["_ctx"];
			const ctxResult = await buildLlmContext({
				prompt: rawPrompt,
				task_type: step.task_type,
				context_level: step.context_level,
				domain: step.domain,
				output_fields: step.output_fields,
				event_context: eventCtx
			}, {
				logger: deps.logger,
				fetchCases: async (query, limit) => {
					return (await deps.kb.search(query, { limit })).map((r) => r.title ? `[${r.title}] ${r.text}` : r.text);
				},
				fetchDomainKnowledge: async (domain) => {
					const results = await deps.kb.search(domain + " 领域知识", {
						limit: 3,
						namespace: "domain"
					});
					if (!results.length) return null;
					return results.map((r) => r.text).join("\n---\n");
				}
			});
			const prompt = ctxResult.enriched_prompt;
			let model;
			if (step.model?.trim()) model = step.model.trim();
			else if (deps.modelRouter) {
				const taskForRouter = step.task_type === "classify" ? "classify" : step.task_type === "analyze" || ctxResult.recommended_model_tier === "strong" ? "reason" : ctxResult.recommended_model_tier === "fast" ? "classify" : "chat";
				model = deps.modelRouter.resolveForTask(taskForRouter);
			}
			if (deps.llmComplete) if (step.output_schema) {
				const { createStructuredOutputEngine } = await import("./structured-output-Bpgf9Lxr.mjs");
				const engine = createStructuredOutputEngine(async (p) => deps.llmComplete({
					prompt: p.prompt,
					model
				}));
				if (step.output_voting) {
					const { data, vote_counts, votes_cast } = await engine.completeWithVoting(prompt, step.output_schema, {
						votes: step.output_voting.votes,
						voteField: step.output_voting.field
					});
					log.output = {
						...data,
						_vote_counts: vote_counts,
						_votes_cast: votes_cast
					};
				} else {
					const { data } = await engine.complete(prompt, step.output_schema);
					log.output = data;
				}
				ctx.variables[step.output] = log.output;
			} else {
				const result = await deps.llmComplete({
					prompt,
					model
				});
				log.output = { text: result.text };
				ctx.variables[step.output] = result.text;
			}
			else if (deps.productionMode) throw new StepFailedError("LLM bridge 未配置（production_mode=true 时 stub 不可用）", step.id, "abort");
			else {
				log.output = {
					stub: true,
					prompt: rawPrompt
				};
				ctx.variables[step.output] = rawPrompt;
				deps.logger?.(`[claworks:llm] stub（无 LLM bridge）: ${rawPrompt.slice(0, 80)}...`);
				deps.publishAnomaly?.({
					kind: "stub_step",
					stepKind: "llm",
					stepId: step.id
				});
			}
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "a2a_delegate") {
			const targetRaw = interpolate(step.target, ctx.variables);
			const peers = deps.a2aPeers ?? ctx.a2aPeers ?? [];
			const delegateResource = `a2a:${targetRaw}`;
			if (deps.rbacCheck) {
				const rbac = deps.rbacCheck({
					action: "a2a.delegate",
					resource: delegateResource,
					subjectType: "system",
					subjectId: deps.robot.name
				});
				if (!rbac.allowed) throw new StepFailedError(rbac.reason ?? "a2a.delegate denied", step.id, "abort");
			}
			const targetUrl = resolveA2aTarget(targetRaw, peers);
			const message = interpolate(step.task, ctx.variables);
			const client = new A2aClient({ baseUrl: targetUrl });
			if (step.waitResult !== false) {
				const task = await client.sendAndWait({ message: {
					role: "user",
					parts: [{
						type: "text",
						text: message
					}]
				} });
				log.output = {
					task_id: task.id,
					status: task.status,
					result: task.result
				};
			} else {
				const task = await client.sendTask({ message: {
					role: "user",
					parts: [{
						type: "text",
						text: message
					}]
				} });
				log.output = {
					task_id: task.id,
					status: task.status
				};
			}
			if (step.output) ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "subagent") {
			const rawSubPrompt = interpolate(step.prompt, ctx.variables);
			const subEventCtx = ctx.variables["_ctx"];
			const subCtxResult = await buildLlmContext({
				prompt: rawSubPrompt,
				task_type: step.task_type,
				context_level: step.context_level,
				domain: step.domain,
				event_context: subEventCtx
			}, {
				logger: deps.logger,
				fetchCases: async (query, limit) => {
					return (await deps.kb.search(query, { limit })).map((r) => r.title ? `[${r.title}] ${r.text}` : r.text);
				},
				fetchDomainKnowledge: async (domain) => {
					const results = await deps.kb.search(domain + " 领域知识", {
						limit: 3,
						namespace: "domain"
					});
					if (!results.length) return null;
					return results.map((r) => r.text).join("\n---\n");
				}
			});
			const subPrompt = subCtxResult.enriched_prompt;
			let subModel;
			if (step.model?.trim()) subModel = step.model.trim();
			else if (deps.modelRouter) {
				const subTaskType = step.task_type === "classify" ? "classify" : subCtxResult.recommended_model_tier === "strong" ? "reason" : "chat";
				subModel = deps.modelRouter.resolveForTask(subTaskType);
			}
			if (deps.subagentRun) log.output = { text: (await deps.subagentRun({
				prompt: subPrompt,
				model: subModel
			})).text };
			else if (deps.llmComplete) log.output = { text: (await deps.llmComplete({
				prompt: subPrompt,
				model: subModel
			})).text };
			else if (deps.productionMode) throw new StepFailedError("subagent bridge 未配置（production_mode=true 时 stub 不可用）", step.id, "abort");
			else {
				log.output = {
					stub: true,
					prompt: rawSubPrompt
				};
				deps.logger?.(`[claworks:subagent] stub（无 bridge）: ${rawSubPrompt.slice(0, 80)}...`);
				deps.publishAnomaly?.({
					kind: "stub_step",
					stepKind: "subagent",
					stepId: step.id
				});
			}
			if (step.output) ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "skill") {
			const input = step.input ? resolveParamsDeep(step.input, ctx.variables) : {};
			if (deps.skillRun) log.output = await deps.skillRun({
				skillId: step.skillId,
				input
			});
			else if (deps.productionMode) throw new StepFailedError(`skill bridge 未配置（production_mode=true 时 stub 不可用），skillId=${step.skillId}`, step.id, "abort");
			else {
				log.output = {
					stub: true,
					skillId: step.skillId,
					input
				};
				deps.logger?.(`[claworks:skill] stub（无 skillRun）skill=${step.skillId}`);
				deps.publishAnomaly?.({
					kind: "stub_step",
					stepKind: "skill",
					stepId: step.id,
					skillId: step.skillId
				});
			}
			if (step.output) ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "script") {
			const input = step.input ? resolveParamsDeep(step.input, ctx.variables) : {};
			if (deps.scriptRun) log.output = await deps.scriptRun({
				scriptId: step.scriptId,
				input
			});
			else if (deps.productionMode) throw new StepFailedError(`scriptRun 未配置（production_mode=true 时 stub 不可用），scriptId=${step.scriptId}`, step.id, "abort");
			else {
				log.output = {
					stub: true,
					scriptId: step.scriptId,
					input
				};
				deps.logger?.(`[claworks:script] stub（无 scriptRun）scriptId=${step.scriptId}`);
				deps.publishAnomaly?.({
					kind: "stub_step",
					stepKind: "script",
					stepId: step.id,
					scriptId: step.scriptId
				});
			}
			if (step.output) ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "call_playbook") {
			const resolvedId = interpolate(step.playbookId, ctx.variables);
			const params = step.params ? resolveParams(step.params, ctx) : {};
			if (deps.callPlaybook) {
				const result = await deps.callPlaybook(resolvedId, params, ctx.runId);
				log.output = result;
				if (step.storeResultAs) ctx.variables[step.storeResultAs] = result.output ?? result;
			} else if (deps.triggerPlaybook) {
				const child = await deps.triggerPlaybook(resolvedId, {
					...params,
					parent_run_id: ctx.runId
				});
				log.output = {
					run_id: child.id,
					status: child.status,
					output: child.output
				};
				if (step.storeResultAs) ctx.variables[step.storeResultAs] = child.output ?? {};
			} else if (deps.productionMode) throw new StepFailedError(`callPlaybook bridge 未配置（production_mode=true 时 stub 不可用），playbookId=${resolvedId}`, step.id, "abort");
			else {
				log.output = {
					stub: true,
					playbookId: resolvedId
				};
				if (step.storeResultAs) ctx.variables[step.storeResultAs] = {};
				deps.logger?.(`[claworks:call_playbook] stub（无 bridge）playbookId=${resolvedId}`);
				deps.publishAnomaly?.({
					kind: "stub_step",
					stepKind: "call_playbook",
					stepId: step.id,
					playbookId: resolvedId
				});
			}
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "condition") {
			const pass = evaluatePlaybookCondition(step.if, ctx.variables);
			const branch = pass ? step.then : step.else ?? [];
			for (const child of branch) await executePlaybookStep(child, ctx, run, deps);
			log.output = { branch: pass ? "then" : "else" };
		} else if (step.kind === "memory_read") {
			const subject = interpolate(String(step.subject), ctx.variables);
			const key = interpolate(String(step.key), ctx.variables);
			const memId = `mem:${subject}:${key}`;
			const existing = await ctx.objectStore.get("RobotMemory", memId).catch(() => null);
			if (existing) log.output = {
				found: true,
				value: existing.value,
				confidence: existing.confidence,
				subject,
				key
			};
			else log.output = {
				found: false,
				value: void 0,
				subject,
				key
			};
			ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "memory_write") {
			const subject = interpolate(String(step.subject), ctx.variables);
			const key = interpolate(String(step.key), ctx.variables);
			const rawValue = step.value;
			const value = typeof rawValue === "string" ? interpolate(rawValue, ctx.variables) : rawValue;
			const memId = `mem:${subject}:${key}`;
			const memObj = {
				id: memId,
				subject,
				key,
				value: String(value),
				category: step.category ?? "learned_pattern",
				confidence: step.confidence ?? .9,
				source: step.source ? interpolate(String(step.source), ctx.variables) : `playbook:${ctx.playbookId}`,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			await ctx.objectStore.upsert("RobotMemory", memId, memObj);
			log.output = {
				written: true,
				id: memId,
				subject,
				key,
				value: memObj.value
			};
			if (step.output) ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "publish_event") {
			if (!ctx.publishEvent) {
				if (deps.productionMode) throw new StepFailedError(`publishEvent 未配置（production_mode=true），eventType=${step.eventType}`, step.id, "abort");
				log.output = {
					stub: true,
					eventType: step.eventType
				};
				deps.logger?.(`[claworks:publish_event] no publishEvent fn, stub eventType=${step.eventType}`);
				deps.publishAnomaly?.({
					kind: "stub_step",
					stepKind: "publish_event",
					stepId: step.id,
					eventType: step.eventType
				});
			} else {
				const eventType = interpolate(step.eventType, ctx.variables);
				const source = step.source ? interpolate(step.source, ctx.variables) : `playbook:${ctx.playbookId}`;
				const resolvedPayload = step.payload ? resolveParamsDeep(step.payload, ctx.variables) : {};
				await ctx.publishEvent(eventType, source, resolvedPayload, ctx.runId);
				log.output = {
					published: true,
					eventType,
					source
				};
				deps.logger?.(`[claworks:publish_event] published ${eventType} from ${source}`);
			}
			if (step.output) ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "parallel") {
			const ps = step;
			const timeoutMs = (ps.timeout_seconds ?? 30) * 1e3;
			const branchPromises = ps.branches.map(async (branch, idx) => {
				let isolatedVars;
				try {
					isolatedVars = JSON.parse(JSON.stringify(ctx.variables));
				} catch {
					isolatedVars = {
						...ctx.variables,
						steps: { ...ctx.variables.steps ?? {} }
					};
				}
				const branchCtx = {
					...ctx,
					variables: isolatedVars
				};
				try {
					for (const s of branch) await executePlaybookStep(s, branchCtx, run, deps);
					return {
						idx,
						success: true,
						vars: branchCtx.variables
					};
				} catch (e) {
					if (ps.on_branch_failure === "abort_all") throw e;
					return {
						idx,
						success: false,
						error: e instanceof Error ? e.message : String(e)
					};
				}
			});
			const results = (await Promise.race([Promise.allSettled(branchPromises), new Promise((_, rej) => setTimeout(() => rej(/* @__PURE__ */ new Error("parallel timeout")), timeoutMs))])).map((r) => r.status === "fulfilled" ? r.value : {
				idx: -1,
				success: false,
				error: "rejected"
			});
			log.output = { branches: results };
			if (ps.store_result_as) ctx.variables[ps.store_result_as] = results;
			recordStepResult(ctx, step.id, log.output);
		}
		if (log.status === "running") log.status = "completed";
	} catch (err) {
		if (err instanceof HitlSuspendedError) throw err;
		log.status = "failed";
		log.error = err instanceof Error ? err.message : String(err);
		recordStepResult(ctx, step.id, { error: log.error }, "failed");
		const policy = meta.onFailure ?? "abort";
		throw new StepFailedError(log.error, step.id, policy);
	} finally {
		if (log.status === "running") log.status = "completed";
		log.completedAt = /* @__PURE__ */ new Date();
	}
}
async function maybeHitlAfterStep(step, ctx, run, deps, _output) {
	const hitl = step.hitl;
	if (!hitl?.requiredIf) return;
	if (hitl.autoApproveIf && evaluatePlaybookCondition(hitl.autoApproveIf, ctx.variables)) return;
	if (!evaluatePlaybookCondition(hitl.requiredIf, ctx.variables)) return;
	const message = `Approve action ${step.actionApiName} for run ${run.id}?`;
	const token = deps.hitl.suspend(run, `${step.id}_hitl`, message, ["approve", "reject"]);
	if (deps.notify) await deps.notify({
		message: `[HITL] ${message}`,
		channels: void 0
	});
	run.status = "waiting_hitl";
	throw new HitlSuspendedError(token, step.id);
}
async function executeActionStep(step, ctx, deps) {
	const params = resolveParams(step.params, ctx);
	const action = step.actionApiName;
	if (deps.actionRegistry?.has(action)) {
		const reg = deps.actionRegistry.get(action);
		deps.logger?.(`[claworks:action] dispatching '${action}' to pack '${reg.packId}'`);
		return await reg.handler(params, ctx);
	}
	if (step.objectType && step.objectId) return await ctx.objectStore.executeAction(step.objectType, interpolate(step.objectId, ctx.variables), action, params, ctx);
	if (action === "reload_packs") {
		if (!ctx.reloadPacks) throw new Error("reload_packs requires ClaWorks pack runtime");
		const packs = (await ctx.reloadPacks()).packs ?? [];
		return {
			status: "ok",
			total: packs.length,
			loaded: packs.length,
			pack_ids: packs.map((p) => p.manifest.id)
		};
	}
	if (action === "update_object" || action === "patch_object") {
		const typeName = String(params.type ?? params.object_type ?? "");
		const id = String(params.id ?? params.object_id ?? "");
		if (!typeName || !id) return {
			status: "error",
			reason: "type and id are required"
		};
		const { type: _t, object_type: _ot, id: _id, object_id: _oid, ...fields } = params;
		const { id: _updId, ...rest } = await ctx.objectStore.update(typeName, id, fields);
		return {
			status: "ok",
			id,
			...rest
		};
	}
	const mappedType = {
		create_work_order: "WorkOrder",
		create_task: "Task",
		create_approval_request: "ApprovalRequest",
		create_incident: "Incident",
		create_meeting: "Meeting",
		broadcast_announcement: "Announcement"
	}[action];
	if (action === "create_work_order" || mappedType) {
		const typeName = mappedType ?? String(params.type ?? params.object_type ?? "WorkOrder");
		const created = await ctx.objectStore.create(typeName, params, ctx);
		if (ctx.publishEvent) {
			const evType = {
				Task: "task.created",
				ApprovalRequest: "approval.created",
				Incident: "incident.created",
				Meeting: "meeting.created",
				Announcement: "announcement.publish"
			}[typeName];
			if (evType) await ctx.publishEvent(evType, "playbook-action", { ...created }, ctx.triggerEvent?.correlationId);
		}
		const { id: createdId, ...createdRest } = created;
		return {
			status: "ok",
			id: createdId,
			...createdRest
		};
	}
	if (action.startsWith("create_")) {
		const typeName = String(params.type ?? params.object_type ?? "WorkOrder");
		const { id: createdId2, ...createdRest2 } = await ctx.objectStore.create(typeName, params, ctx);
		return {
			status: "ok",
			id: createdId2,
			...createdRest2
		};
	}
	if (action === "search_kb") {
		const query = String(params.query ?? "");
		const limit = typeof params.limit === "number" ? params.limit : 5;
		const namespace = typeof params.namespace === "string" ? params.namespace : void 0;
		const results = await ctx.kb.search(query, {
			limit,
			namespace
		});
		return {
			results,
			count: results.length
		};
	}
	if (action === "ingest_kb_text" || action === "ingest_kb") {
		const text = String(params.text ?? params.content ?? "");
		const namespace = typeof params.namespace === "string" ? params.namespace : void 0;
		await ctx.kb.ingest(text, { namespace });
		return { ingested: true };
	}
	if (action === "ingest_document") {
		if (!isDocumentKnowledgeBase(ctx.kb)) return {
			status: "error",
			reason: "ingest_document requires DocumentKnowledgeBase"
		};
		const doc = await ctx.kb.ingestDocument({
			text: String(params.text ?? params.content ?? ""),
			source: typeof params.source === "string" ? params.source : void 0,
			namespace: typeof params.namespace === "string" ? params.namespace : void 0,
			title: typeof params.title === "string" ? params.title : void 0,
			auto_publish: params.auto_publish === true
		});
		return {
			document_id: doc.id,
			document: doc
		};
	}
	if (action === "lint_document") {
		if (!isDocumentKnowledgeBase(ctx.kb)) return {
			ok: false,
			reason: "lint_document requires DocumentKnowledgeBase"
		};
		const id = String(params.document_id ?? params.id ?? "");
		if (!id) return {
			ok: false,
			reason: "document_id required"
		};
		return ctx.kb.lintDocument(id);
	}
	return await ctx.objectStore.executeAction(String(params.type ?? params.object_type ?? "WorkOrder"), String(params.id ?? randomUUID()), action, params, ctx);
}
async function executeAtomic(fn, params, ctx, deps) {
	if (fn === "objects.create" || fn.startsWith("create_")) {
		const typeName = String(params.type ?? params.object_type ?? "WorkOrder");
		return ctx.objectStore.create(typeName, params, ctx);
	}
	if (fn === "kb.search") return ctx.kb.search(String(params.query ?? ""));
	if (fn === "kb.ingest") {
		await ctx.kb.ingest(String(params.text ?? ""), { namespace: params.namespace ? String(params.namespace) : void 0 });
		return { ingested: true };
	}
	if (fn === "connector.invoke") {
		if (!deps.connectorInvoke) throw new Error("connector.invoke requires ClaWorks connector runtime");
		await deps.connectorInvoke(String(params.connector_id ?? params.connector ?? ""), String(params.method ?? ""), params.params ?? params.args);
		return { invoked: true };
	}
	if (fn === "a2a.send") {
		const targetRaw = String(params.target_url ?? params.url ?? params.target ?? "");
		if (!targetRaw) throw new Error("a2a.send requires target_url or target (peer name)");
		const task = await new A2aClient({ baseUrl: resolveA2aTarget(targetRaw, deps.a2aPeers ?? []) }).sendAndWait({
			message: {
				role: "user",
				parts: [{
					type: "text",
					text: String(params.message ?? "")
				}]
			},
			metadata: params.metadata && typeof params.metadata === "object" ? params.metadata : void 0
		});
		return {
			task_id: task.id,
			status: task.status,
			result: task.result
		};
	}
	deps.logger?.(`[claworks:atomic] unknown fn="${fn}" — step returned stub output`);
	return {
		fn,
		params,
		_stub: true,
		_warning: `atomic fn "${fn}" is not implemented`
	};
}
function stepResultField(steps, stepId, field, fallback = "") {
	const value = steps[stepId]?.result?.[field];
	return value != null && value !== "" ? String(value) : fallback;
}
/** 解析 Jinja 表达式中的字面量值（用于过滤器管道中的 default 参数和 get() 默认值）。 */
function parseLiteralExpr(expr) {
	const s = expr.trim();
	if (s === "null" || s === "None") return null;
	if (s === "[]") return [];
	if (s === "{}") return {};
	if (s === "true" || s === "True") return true;
	if (s === "false" || s === "False") return false;
	const strMatch = s.match(/^(['"])(.*)\1$/s);
	if (strMatch) return strMatch[2];
	const n = Number(s);
	if (!Number.isNaN(n) && s !== "") return n;
}
function interpolate(template, vars) {
	const payload = vars.payload ?? vars;
	const steps = vars.steps ?? {};
	const expanded = expandJinjaForLoops(template, vars);
	const applyFilters = (value, filterStr) => {
		let result = value;
		const filters = filterStr.split(/\s*\|\s*(?=[a-z_A-Z])/);
		for (const f of filters) {
			const filterName = f.match(/^(\w+)/)?.[1] ?? "";
			const argStr = f.match(/\(([^)]*)\)/)?.[1];
			switch (filterName) {
				case "lower":
					result = String(result ?? "").toLowerCase();
					break;
				case "upper":
					result = String(result ?? "").toUpperCase();
					break;
				case "trim":
					result = String(result ?? "").trim();
					break;
				case "length":
					result = Array.isArray(result) ? result.length : String(result ?? "").length;
					break;
				case "default": {
					const dflt = argStr?.replace(/^['"]|['"]$/g, "") ?? "";
					if (result == null || result === "" || result === false) result = dflt;
					break;
				}
				case "tojson":
					try {
						result = JSON.stringify(result);
					} catch {
						result = "{}";
					}
					break;
				case "fromjson":
					try {
						result = JSON.parse(String(result ?? "{}"));
					} catch {
						result = {};
					}
					break;
				case "int":
					result = parseInt(String(result ?? "0"), 10) || 0;
					break;
				case "float":
					result = parseFloat(String(result ?? "0")) || 0;
					break;
				case "string":
					result = String(result ?? "");
					break;
				case "replace": {
					const parts = argStr?.match(/['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/);
					if (parts) result = String(result ?? "").split(parts[1]).join(parts[2]);
					break;
				}
				case "join": {
					const sep = argStr?.replace(/^['"]|['"]$/g, "") ?? ", ";
					result = Array.isArray(result) ? result.join(sep) : String(result ?? "");
					break;
				}
				case "split": {
					const sep = argStr?.replace(/^['"]|['"]$/g, "") ?? " ";
					result = String(result ?? "").split(sep);
					break;
				}
				case "first":
					result = Array.isArray(result) ? result[0] : String(result ?? "")[0];
					break;
				case "last":
					result = Array.isArray(result) ? result[result.length - 1] : String(result ?? "").slice(-1);
					break;
				case "regex_search": {
					const pattern = argStr?.replace(/^['"]|['"]$/g, "") ?? "";
					try {
						result = new RegExp(pattern, "i").test(String(result ?? "")) ? "true" : "";
					} catch {
						result = "";
					}
					break;
				}
				case "capitalize":
					result = String(result ?? "").charAt(0).toUpperCase() + String(result ?? "").slice(1);
					break;
				case "abs":
					result = Math.abs(Number(result ?? 0));
					break;
				case "round":
					result = Math.round(Number(result ?? 0));
					break;
				case "list":
					result = Array.isArray(result) ? result : [result];
					break;
				case "unique":
					result = Array.isArray(result) ? [...new Set(result)] : result;
					break;
				case "sort":
					result = Array.isArray(result) ? [...result].sort() : result;
					break;
				case "reverse":
					result = Array.isArray(result) ? [...result].reverse() : String(result ?? "").split("").reverse().join("");
					break;
				default: break;
			}
		}
		return typeof result === "object" ? JSON.stringify(result) : String(result ?? "");
	};
	let out = expanded.replace(/\{\{\s*([^{}|]+?)\s*\|\s*([^{}]+?)\s*\}\}/g, (match, exprPart, filtersPart) => {
		const trimmedExpr = exprPart.trim();
		let baseValue = void 0;
		const pathMatch = trimmedExpr.match(/^([\w.]+)$/);
		if (pathMatch) {
			const parts = pathMatch[1].split(".");
			let cur = vars;
			for (const part of parts) if (cur && typeof cur === "object") cur = cur[part];
			else {
				cur = void 0;
				break;
			}
			baseValue = cur;
		}
		const pgm = trimmedExpr.match(/^payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)$/);
		if (pgm) baseValue = payload[pgm[1]];
		if (baseValue === void 0) {
			const stepsGetMatch = trimmedExpr.match(/^steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*([^)]+))?\s*\)$/);
			if (stepsGetMatch) {
				const [, stepId, field, defaultExprRaw] = stepsGetMatch;
				const stepResult = steps[stepId]?.result;
				const dflt = defaultExprRaw ? parseLiteralExpr(defaultExprRaw.trim()) : void 0;
				baseValue = stepResult != null ? stepResult[field] ?? dflt : dflt;
			}
		}
		if (baseValue === void 0) if (trimmedExpr === "null") baseValue = null;
		else if (trimmedExpr === "[]") baseValue = [];
		else if (trimmedExpr === "{}") baseValue = {};
		else {
			const literalStr = trimmedExpr.match(/^(['"])(.*)\1$/s);
			if (literalStr) baseValue = literalStr[2];
			else if (trimmedExpr !== "" && !trimmedExpr.includes(" ") && !Number.isNaN(Number(trimmedExpr))) baseValue = Number(trimmedExpr);
		}
		if (baseValue === void 0) return applyFilters(match.replace(/\s*\|[^}]+$/, " }}"), filtersPart);
		return applyFilters(baseValue, filtersPart);
	}).replace(/\{\{\s*payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g, (_, key) => String(payload[key] ?? "")).replace(/\{\{\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)\s*\)\s*\}\}/g, (_, stepId, fieldA, stepId2, fieldB, literalFallback) => {
		const sid = stepId === stepId2 ? stepId : stepId;
		return stepResultField(steps, sid, fieldA, stepResultField(steps, sid, fieldB, literalFallback));
	}).replace(/\{\{\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g, (_, stepId, field) => stepResultField(steps, stepId, field)).replace(/\{\{\s*steps\.get\(\s*['"](\w+)['"]\s*,\s*\{\}\)\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g, (_, stepId, field) => {
		const step = steps[stepId];
		if (field === "status") return String(step?.status ?? "");
		return stepResultField(steps, stepId, field);
	}).replace(/\{\{\s*(\w+)\s+or\s+['"]([^'"]*)['"]\s*\}\}/g, (_, key, fallback) => {
		const v = vars[key];
		return v != null && v !== "" ? String(v) : fallback;
	}).replace(/\{\{\s*([\w]+(?:\.[\w]+)+)\s*\}\}/g, (_, path) => {
		const parts = path.split(".");
		let cur = vars;
		for (const part of parts) if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = cur[part];
		else {
			cur = void 0;
			break;
		}
		return cur != null ? typeof cur === "object" ? JSON.stringify(cur) : String(cur) : "";
	}).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
	out = out.replace(/\{\{\s*round\(\s*float\(\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*\)\s*\*\s*100\s*\)\s*\}\}/g, (_, stepId, field) => {
		const raw = steps[stepId]?.result?.[field];
		return String(Math.round(Number.parseFloat(String(raw ?? 0)) * 100));
	});
	out = out.replace(/\{\{\s*time\.now\(\s*\)\s*\}\}/g, () => (/* @__PURE__ */ new Date()).toISOString()).replace(/\{\{\s*time\.now_ms\(\s*\)\s*\}\}/g, () => String(Date.now())).replace(/\{\{\s*uuid\(\s*\)\s*\}\}/g, () => randomUUID());
	return out;
}
//#endregion
//#region src/kernel/event-names.ts
/**
* ClaWorks 标准事件名常量
*
* 所有 kernel.publish / subscribe / Playbook trigger.pattern 应使用这些常量，
* 避免事件名拼写错误导致的静默 bug。
*
* 命名约定：
*   CW_EVENTS.*  → 由 ClaWorks kernel/planes 发布的内部事件
*   外部 IM 消息、报警等由各 bridge/plugin 注入，在适配层使用对应常量。
*/
const CW_EVENTS = {
	SYSTEM_STARTUP: "system.startup",
	SYSTEM_STARTUP_WARNINGS: "system.startup_warnings",
	SYSTEM_READY: "system.ready",
	SYSTEM_RUNTIME_STARTED: "system.runtime.started",
	SYSTEM_RUNTIME_STOPPED: "system.runtime.stopped",
	SYSTEM_PACKS_RELOADED: "system.packs_reloaded",
	SYSTEM_ONBOARDING_STARTED: "system.onboarding_started",
	SYSTEM_ANOMALY: "system.anomaly",
	SYSTEM_SCHEDULE_FIRED: "system.schedule.fired",
	/** im-bridge 收到用户 IM 消息后发布 */
	IM_MESSAGE_RECEIVED: "im.message.received",
	INTENT_CLASSIFIED: "intent.classified",
	INTENT_LOW_CONFIDENCE: "intent.low_confidence",
	PLAYBOOK_STARTED: "playbook.started",
	PLAYBOOK_COMPLETED: "playbook.completed",
	PLAYBOOK_FAILED: "playbook.failed",
	PLAYBOOK_STEP_SLOW: "playbook.step_slow",
	/** 内部：playbook 运行完成（evolve-engine 订阅） */
	PLAYBOOK_RUN_COMPLETED: "playbook.run.completed",
	/** 内部：playbook 运行失败（evolve-engine 订阅） */
	PLAYBOOK_RUN_FAILED: "playbook.run.failed",
	PLAYBOOK_TRIGGER: "playbook.trigger",
	/** 外部系统（domain-operations、业务 pack 等）发布新报警记录时使用。 */
	ALARM_CREATED: "alarm.created",
	/** 保留：语义同 ALARM_CREATED，供已有代码向后兼容。 */
	ALARM_TRIGGERED: "alarm.triggered",
	ALARM_ACKNOWLEDGED: "alarm.acknowledged",
	ALARM_RESOLVED: "alarm.resolved",
	WORK_ORDER_CREATED: "work_order.created",
	WORK_ORDER_STATUS_CHANGED: "work_order.status_changed",
	WORK_ORDER_CLOSED: "work_order.closed",
	TASK_CREATED: "task.created",
	TASK_COMPLETED: "task.completed",
	TASK_STATUS_CHANGED: "task.status_changed",
	TASK_ASSIGNED: "task.assigned",
	TASK_CANCELLED: "task.cancelled",
	APPROVAL_CREATED: "approval.created",
	APPROVAL_APPROVED: "approval.approved",
	APPROVAL_REJECTED: "approval.rejected",
	APPROVAL_HITL_REQUESTED: "approval.hitl_requested",
	HITL_APPROVAL_REQUESTED: "hitl.approval_requested",
	AGENT_TASK_COMPLETED: "agent.task_completed",
	AGENT_TASK_FAILED: "agent.task_failed",
	A2A_DELEGATE_STARTED: "a2a.delegate_started",
	EVOLUTION_PACK_IMPORTED: "evolution.pack_imported",
	EVOLVE_PLAYBOOK_DEPLOYED: "evolve.playbook_deployed",
	EVOLVE_PLAYBOOK_DRAFTED: "evolve.playbook_drafted",
	EVOLVE_SUGGESTIONS_READY: "evolve.suggestions_ready",
	CAPABILITY_FEEDBACK_RECEIVED: "capability.feedback_received",
	LEARN_FEEDBACK_RECORDED: "learn.feedback_recorded",
	LEARN_OBSERVATION_RECORDED: "learn.observation_recorded",
	LEARN_INTERFACE_REQUESTED: "learn.interface.requested",
	PACK_INSTALLED: "pack.installed",
	PACK_LOADED: "pack.loaded",
	COMMS_BROADCAST_SENT: "comms.broadcast_sent",
	COMMS_STREAM_STARTED: "comms.stream_started",
	COMMS_STREAM_COMPLETED: "comms.stream_completed",
	COMMS_STREAM_FAILED: "comms.stream_failed",
	NOTIFICATION_SEND_REQUESTED: "notification.send_requested",
	MONITOR_WATCH_REGISTERED: "monitor.watch_registered",
	RESEARCH_MONITOR_UPDATE: "research.monitor_update",
	CONNECT_APPLIED: "connect.applied",
	CONNECT_APPLY_REQUESTED: "connect.apply_requested",
	CONNECTOR_INVOKE_STARTED: "connector.invoke_started",
	ENVIRONMENT_SCAN_COMPLETED: "environment.scan_completed",
	SCHEDULE_JOB_REGISTERED: "schedule.job_registered",
	RBAC_DENIED: "rbac.denied",
	SWARM_ANNOUNCED: "swarm.announced",
	SWARM_PEER_DISCOVERED: "swarm.peer_discovered",
	SWARM_PEER_LOST: "swarm.peer_lost",
	SWARM_SYNC_COMPLETED: "swarm.sync_completed",
	REPORT_GENERATED: "report.generated",
	HARNESS_SYNC_COMPLETED: "harness.sync_completed",
	USER_FIRST_INTERACTION: "user.first_interaction",
	/**
	* 机器人自主巡逻心跳（周期性自动触发，默认每 5 分钟一次）。
	*
	* Pack 可以注册 trigger.event = "robot.patrol" 的 Playbook 来实现：
	*   - 检查未处理的告警/工单
	*   - 发送定期报告
	*   - 监控系统状态
	*   - 主动推送关键通知
	*
	* 这是机器人"自主性"的核心机制：不依赖外部触发，主动感知业务状态。
	*/
	ROBOT_PATROL: "robot.patrol"
};
//#endregion
export { interpolate as a, evaluateCondition as c, executeFunction as d, tryParseJson as f, executePlaybookStep as i, semanticFallbackScore as l, resolveA2aTarget as m, HitlSuspendedError as n, evaluatePlaybookCondition as o, listA2aPeerNames as p, StepFailedError as r, createPlaybookMatcher as s, CW_EVENTS as t, matchGlob as u };
