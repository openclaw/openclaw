import { f as __exportAll } from "./ontology-engine-DYitirop.mjs";
import { n as appendDecisionLog, t as A2aClient } from "./client-sSruxTff.mjs";
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
//#region src/planes/orch/function-executor.ts
var function_executor_exports = /* @__PURE__ */ __exportAll({
	executeFunction: () => executeFunction,
	tryParseJson: () => tryParseJson
});
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
		const source = String(params.source ?? "im-bridge:intent");
		const correlationId = params.correlation_id ? String(params.correlation_id) : void 0;
		const SYSTEM_INTENT_MAP = {
			hitl_approve: "hitl.approve_requested",
			kb_query: "kb.query_requested",
			pack_reload: "system.pack_reload_requested"
		};
		const registryMapping = deps.intentRegistry?.resolve(intent);
		const eventType = registryMapping?.eventType ?? SYSTEM_INTENT_MAP[intent] ?? `intent.${intent}`;
		if (intent === "none") return {
			status: "skipped",
			intent,
			reason: "no matching business event"
		};
		if (!registryMapping && !SYSTEM_INTENT_MAP[intent]) deps.logger?.(`[claworks:function] unmapped intent '${intent}' — routing to generic event '${eventType}'`);
		if (deps.publishEvent) {
			await deps.publishEvent(eventType, source, {
				...extracted,
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
	deps.logger?.(`[claworks:function] unknown function "${name}" — returning stub`);
	return {
		status: "ok",
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
	return {
		load(playbooks) {
			rules = playbooks.filter((p) => p.trigger.kind === "event").map((p) => ({
				playbookId: p.id,
				trigger: p.trigger,
				priority: p.priority
			}));
		},
		match(event) {
			const matches = [];
			const semanticCandidates = [];
			for (const rule of rules) {
				if (rule.trigger.kind !== "event") continue;
				const globHit = matchGlob(rule.trigger.pattern, event.type);
				const semanticHit = !globHit && semanticFallbackScore(rule.trigger.pattern, event.type) >= .5;
				if (!globHit && !semanticHit) continue;
				if (rule.trigger.filter && !matchesFilter(rule.trigger.filter, event.payload)) continue;
				if (rule.trigger.condition && !evaluateCondition(rule.trigger.condition, event.payload)) continue;
				const entry = {
					event,
					playbookId: rule.playbookId,
					priority: rule.priority,
					input: {
						...event.payload,
						_event: event
					}
				};
				if (globHit) matches.push(entry);
				else semanticCandidates.push(entry);
			}
			if (matches.length === 0 && semanticCandidates.length > 0) {
				semanticCandidates.sort((a, b) => b.priority - a.priority);
				matches.push(semanticCandidates[0]);
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
//#region src/planes/orch/step-conditions.ts
/** Evaluate pack YAML step/trigger conditions (Python-style subset). */
function evaluatePlaybookCondition(condition, variables) {
	if (!condition?.trim()) return true;
	const interpolated = interpolate(condition.trim(), variables);
	if (!interpolated.includes("{{")) {
		if (interpolated === "" || interpolated === "false" || interpolated === "0") return false;
		if (condition.trim().startsWith("{{")) return true;
	}
	const expr = interpolated.trim();
	const payload = variables.payload ?? variables;
	const steps = variables.steps ?? {};
	const inList = expr.match(/payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s+in\s+\(([^)]+)\)/);
	if (inList) {
		const value = String(payload[inList[1]] ?? "");
		return inList[2].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).includes(value);
	}
	const floatCmp = expr.match(/float\(\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*\)\s*(>|>=|<|<=|==)\s*([\d.]+)/);
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
	}
	const stepsStatus = expr.match(/steps\.get\(\s*['"](\w+)['"]\s*,\s*\{\}\)\.get\(\s*['"]status['"]\s*\)\s*==\s*['"](\w+)['"]/);
	if (stepsStatus) return steps[stepsStatus[1]]?.status === stepsStatus[2];
	if (expr.includes(" and ")) return expr.split(/\s+and\s+/).every((part) => evaluatePlaybookCondition(part.trim(), variables));
	if (expr.includes("payload.")) return evaluateCondition(expr, payload);
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
				stepId: step.id
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
			const prompt = interpolate(step.prompt, ctx.variables);
			if (deps.llmComplete) {
				const model = deps.modelRouter?.resolve("llm", step.model) ?? step.model;
				const result = await deps.llmComplete({
					prompt,
					model
				});
				log.output = { text: result.text };
				ctx.variables[step.output] = result.text;
			} else {
				log.output = {
					stub: true,
					prompt
				};
				ctx.variables[step.output] = prompt;
				deps.logger?.(`[claworks:llm] stub: ${prompt.slice(0, 80)}...`);
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
			const prompt = interpolate(step.prompt, ctx.variables);
			const model = deps.modelRouter?.resolve("subagent", step.model) ?? step.model;
			if (deps.subagentRun) log.output = { text: (await deps.subagentRun({
				prompt,
				model
			})).text };
			else if (deps.llmComplete) log.output = { text: (await deps.llmComplete({
				prompt,
				model
			})).text };
			else {
				log.output = {
					stub: true,
					prompt
				};
				deps.logger?.(`[claworks:subagent] stub: ${prompt.slice(0, 80)}...`);
			}
			if (step.output) ctx.variables[step.output] = log.output;
			recordStepResult(ctx, step.id, log.output);
		} else if (step.kind === "skill") {
			const input = step.input ? resolveParamsDeep(step.input, ctx.variables) : {};
			if (deps.skillRun) log.output = await deps.skillRun({
				skillId: step.skillId,
				input
			});
			else {
				log.output = {
					stub: true,
					skillId: step.skillId,
					input
				};
				deps.logger?.(`[claworks:skill] stub skill=${step.skillId}`);
			}
			if (step.output) ctx.variables[step.output] = log.output;
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
				log.output = {
					stub: true,
					eventType: step.eventType
				};
				deps.logger?.(`[claworks:publish_event] no publishEvent fn, stub eventType=${step.eventType}`);
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
	return {
		fn,
		params
	};
}
function stepResultField(steps, stepId, field, fallback = "") {
	const value = steps[stepId]?.result?.[field];
	return value != null && value !== "" ? String(value) : fallback;
}
function interpolate(template, vars) {
	const payload = vars.payload ?? vars;
	const steps = vars.steps ?? {};
	let out = expandJinjaForLoops(template, vars).replace(/\{\{\s*payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g, (_, key) => String(payload[key] ?? "")).replace(/\{\{\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)\s*\)\s*\}\}/g, (_, stepId, fieldA, stepId2, fieldB, literalFallback) => {
		const sid = stepId === stepId2 ? stepId : stepId;
		return stepResultField(steps, sid, fieldA, stepResultField(steps, sid, fieldB, literalFallback));
	}).replace(/\{\{\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g, (_, stepId, field) => stepResultField(steps, stepId, field)).replace(/\{\{\s*steps\.get\(\s*['"](\w+)['"]\s*,\s*\{\}\)\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g, (_, stepId, field) => {
		const step = steps[stepId];
		if (field === "status") return String(step?.status ?? "");
		return stepResultField(steps, stepId, field);
	}).replace(/\{\{\s*(\w+)\s+or\s+['"]([^'"]*)['"]\s*\}\}/g, (_, key, fallback) => {
		const v = vars[key];
		return v != null && v !== "" ? String(v) : fallback;
	}).replace(/\{\{\s*(\w+)\.(\w+)\s*\}\}/g, (_, obj, field) => {
		const objVal = vars[obj];
		if (objVal && typeof objVal === "object" && !Array.isArray(objVal)) return String(objVal[field] ?? "");
		return "";
	}).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
	out = out.replace(/\{\{\s*round\(\s*float\(\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*\)\s*\*\s*100\s*\)\s*\}\}/g, (_, stepId, field) => {
		const raw = steps[stepId]?.result?.[field];
		return String(Math.round(Number.parseFloat(String(raw ?? 0)) * 100));
	});
	return out;
}
//#endregion
export { evaluatePlaybookCondition as a, semanticFallbackScore as c, function_executor_exports as d, listA2aPeerNames as f, interpolate as i, matchGlob as l, StepFailedError as n, createPlaybookMatcher as o, resolveA2aTarget as p, executePlaybookStep as r, evaluateCondition as s, HitlSuspendedError as t, executeFunction as u };
