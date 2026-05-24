import { u as globalMetrics } from "./kb-types-JeIAB0Dq.mjs";
import { i as executePlaybookStep, n as HitlSuspendedError, r as StepFailedError, t as CW_EVENTS } from "./event-names-DAkOP5w8.mjs";
import { randomUUID } from "node:crypto";
//#region src/kernel/event-context.ts
const DOMAIN_PATTERNS = [
	{
		re: /alarm|报警|告警|故障|设备异常/i,
		domain: "alarm"
	},
	{
		re: /quality|质量|检测|不良|缺陷|良品/i,
		domain: "quality"
	},
	{
		re: /maintenance|维修|保养|维护|巡检/i,
		domain: "maintenance"
	},
	{
		re: /logistics|物流|发货|收货|运输|仓储/i,
		domain: "logistics"
	},
	{
		re: /energy|能耗|电力|用电|水耗|gas|燃气/i,
		domain: "energy"
	},
	{
		re: /safety|安全|事故|危险|隐患/i,
		domain: "safety"
	},
	{
		re: /hr|人事|员工|考勤|绩效|招聘/i,
		domain: "hr"
	},
	{
		re: /it|系统|网络|服务器|数据库|接口/i,
		domain: "it"
	},
	{
		re: /production|生产|排产|工单|产线|工序/i,
		domain: "production"
	}
];
const CRITICAL_RE = /critical|紧急|P0|严重|重大|danger|危急|大量/i;
const WARNING_RE = /warning|警告|P1|异常|超标|偏差|注意/i;
const RECOVERY_RE = /recovery|恢复|解除|resolved|正常|已处理/i;
/** 从 payload 中提取文本用于分析 */
function extractText(payload) {
	return [
		"content",
		"text",
		"message",
		"description",
		"body",
		"summary"
	].map((k) => typeof payload[k] === "string" ? payload[k] : "").join(" ").trim();
}
/** 根据事件类型前缀快速推断领域 */
function domainFromEventType(eventType) {
	if (eventType.startsWith("alarm.")) return "alarm";
	if (eventType.startsWith("work_order.")) return "production";
	if (eventType.startsWith("task.")) return void 0;
	if (eventType.startsWith("report.")) return void 0;
}
/** 从文本内容推断领域 */
function domainFromText(text) {
	for (const { re, domain } of DOMAIN_PATTERNS) if (re.test(text)) return domain;
}
/** 推断情感/严重程度 */
function inferSentiment(payload, text) {
	const severity = String(payload["severity"] ?? payload["level"] ?? payload["priority"] ?? "");
	if (/critical|p0|high|紧急|严重/i.test(severity) || CRITICAL_RE.test(text)) return "critical";
	if (/warning|p1|medium|警告|异常/i.test(severity) || WARNING_RE.test(text)) return "warning";
	if (RECOVERY_RE.test(text) || RECOVERY_RE.test(severity)) return "recovery";
	return "normal";
}
/** 从 payload 已知字段提取业务实体 */
function extractEntities(payload) {
	const entities = [];
	const add = (type, idKey, nameKey) => {
		const id = payload[idKey];
		if (typeof id === "string" && id) entities.push({
			type,
			id,
			name: nameKey && typeof payload[nameKey] === "string" ? payload[nameKey] : void 0
		});
	};
	add("device", "device_id", "device_name");
	add("line", "line_id", "line_name");
	add("order", "order_id", "order_no");
	add("user", "user_id", "user_name");
	add("user", "sender_id", "sender_name");
	add("location", "location_id", "location");
	return entities;
}
/** 从文本提取关键词（粗粒度，仅去重+截断） */
function extractKeywords(text, limit = 10) {
	const tokens = text.split(/[\s,，。！？、：；\n\r]+/).map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 20);
	return [...new Set(tokens)].slice(0, limit);
}
/**
* 从原始 Playbook 触发 payload 自动预计算 ContextPacket。
*
* 纯函数：无 I/O、无副作用，在 Playbook 初始化时同步执行。
* 摄入层若已携带 `_ctx` 字段，则直接沿用（优先显式）。
*
* @param payload  Playbook 触发的原始输入对象
* @param eventType  触发事件类型（如 "alarm.created"），可选
*/
function buildEventContext(payload, eventType) {
	if (payload["_ctx"] && typeof payload["_ctx"] === "object") return payload["_ctx"];
	const text = extractText(payload);
	const entities = extractEntities(payload);
	const keywords = extractKeywords(text);
	const inferred_domain = (typeof payload["domain"] === "string" ? payload["domain"] : void 0) ?? (eventType ? domainFromEventType(eventType) : void 0) ?? domainFromText(text);
	const pendingRuns = typeof payload.pending_runs === "number" ? payload.pending_runs : void 0;
	const playbookCount = typeof payload.playbook_count === "number" ? payload.playbook_count : void 0;
	let sentiment = inferSentiment(payload, text);
	if (sentiment === "normal" && pendingRuns !== void 0 && pendingRuns > 5) sentiment = "warning";
	const source_id = (typeof payload["source"] === "string" ? payload["source"] : void 0) ?? (typeof payload["channel_id"] === "string" ? payload["channel_id"] : void 0) ?? (typeof payload["source_id"] === "string" ? payload["source_id"] : void 0);
	const raw_ts = payload["timestamp"] ?? payload["ts"] ?? payload["event_ts"];
	const event_ts = typeof raw_ts === "number" ? raw_ts : typeof raw_ts === "string" ? Date.parse(raw_ts) || void 0 : void 0;
	const ctx = {};
	if (inferred_domain) ctx.inferred_domain = inferred_domain;
	if (sentiment !== "normal") ctx.sentiment = sentiment;
	if (source_id) ctx.source_id = source_id;
	if (event_ts) ctx.event_ts = event_ts;
	if (entities.length) ctx.entities = entities;
	if (keywords.length) ctx.keywords = keywords;
	if (pendingRuns !== void 0 || playbookCount !== void 0) ctx.meta = {
		pending_runs: pendingRuns,
		playbook_count: playbookCount
	};
	return ctx;
}
//#endregion
//#region src/planes/orch/playbook-engine.ts
function createPlaybookEngine(deps) {
	const playbooks = /* @__PURE__ */ new Map();
	const runs = /* @__PURE__ */ new Map();
	const suspended = /* @__PURE__ */ new Map();
	const concurrencyMap = /* @__PURE__ */ new Map();
	const MAX_CONCURRENT_PER_PLAYBOOK = 8;
	const db = deps.db;
	let llmComplete = deps.llmComplete;
	let notify = deps.notify;
	let connectorInvoke = deps.connectorInvoke;
	const publishEvent = deps.publishEvent;
	const ontology = deps.ontology;
	const reloadPacks = deps.reloadPacks;
	const reloadPackById = deps.reloadPackById;
	const a2aPeers = deps.a2aPeers ?? [];
	const modelRouter = deps.modelRouter;
	let subagentRun = deps.subagentRun;
	let skillRun = deps.skillRun;
	let scriptRun = deps.scriptRun;
	const productionMode = deps.productionMode ?? false;
	let publishAnomaly = deps.publishAnomaly;
	const upsertRun = db.prepare(`
    INSERT INTO cw_playbook_runs (id, playbook_id, status, input, output, error, steps, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      output = excluded.output,
      error = excluded.error,
      steps = excluded.steps,
      completed_at = excluded.completed_at
  `);
	const selectRun = db.prepare("SELECT * FROM cw_playbook_runs WHERE id = ?");
	const selectWaitingHitl = db.prepare("SELECT * FROM cw_playbook_runs WHERE status = 'waiting_hitl'");
	function storeSuspended(runId, data) {
		suspended.set(runId, data);
	}
	function clearSuspended(runId) {
		suspended.delete(runId);
	}
	async function triggerInternal(playbookId, input, partialCtx) {
		const def = playbooks.get(playbookId);
		if (!def) throw new Error(`Playbook not found: ${playbookId}`);
		if (def.required_role) {
			const roleOrder = [
				"viewer",
				"operator",
				"admin"
			];
			const requiredIdx = roleOrder.indexOf(def.required_role);
			const userRole = String(input.user_role ?? "");
			if (roleOrder.indexOf(userRole) < requiredIdx) {
				deps.logger?.(`[claworks:playbook] role denied for '${playbookId}': need ${def.required_role}, got '${userRole}'`);
				return {
					id: `denied-${Date.now()}`,
					playbookId,
					status: "failed",
					startedAt: /* @__PURE__ */ new Date(),
					completedAt: /* @__PURE__ */ new Date(),
					input,
					steps: [],
					error: `权限不足：需要 ${def.required_role} 角色`
				};
			}
		}
		const currentConcurrency = concurrencyMap.get(playbookId) ?? 0;
		if (currentConcurrency >= MAX_CONCURRENT_PER_PLAYBOOK) {
			deps.logger?.(`[claworks:playbook] concurrency limit reached for '${playbookId}' (${currentConcurrency}/${MAX_CONCURRENT_PER_PLAYBOOK}) — dropping run`);
			return {
				id: `dropped-${Date.now()}`,
				playbookId,
				status: "failed",
				startedAt: /* @__PURE__ */ new Date(),
				completedAt: /* @__PURE__ */ new Date(),
				input,
				steps: [],
				error: `concurrency_limit_exceeded: ${playbookId}`
			};
		}
		concurrencyMap.set(playbookId, currentConcurrency + 1);
		const runId = randomUUID();
		const _pbStartMs = Date.now();
		const run = {
			id: runId,
			playbookId,
			status: "running",
			startedAt: /* @__PURE__ */ new Date(),
			input,
			steps: []
		};
		runs.set(runId, run);
		persistRun(upsertRun, run, suspended.get(runId));
		globalMetrics.increment(CW_EVENTS.PLAYBOOK_STARTED, { playbook_id: playbookId });
		const ctx = {
			runId,
			playbookId,
			variables: {
				...input,
				payload: input,
				trigger: input,
				event: { payload: input },
				_now: (/* @__PURE__ */ new Date()).toISOString(),
				_now_ts: Date.now(),
				_now_date: (/* @__PURE__ */ new Date()).toLocaleDateString("zh-CN"),
				_now_weekday: [
					"周日",
					"周一",
					"周二",
					"周三",
					"周四",
					"周五",
					"周六"
				][(/* @__PURE__ */ new Date()).getDay()],
				_robot_name: deps.robot.name,
				_robot_id: deps.robot.id ?? deps.robot.name,
				steps: {},
				_session: buildSessionContext(String(input.session_id ?? input.sessionId ?? ""), deps.contextEngine),
				_ctx: buildEventContext(input, def.trigger.kind === "event" ? def.trigger.pattern : void 0)
			},
			objectStore: deps.objectStore,
			kb: deps.kb,
			robot: deps.robot,
			publishEvent,
			ontology,
			reloadPacks,
			a2aPeers,
			connectorInvoke: deps.connectorInvoke,
			logger: deps.logger,
			...partialCtx
		};
		try {
			const playbookTimeoutMs = (def.timeout_seconds ?? 300) * 1e3;
			const timeoutHandle = setTimeout(() => {
				if (run.status === "running") {
					run.status = "failed";
					run.error = `Playbook exceeded global timeout of ${def.timeout_seconds ?? 300}s`;
					run.completedAt = /* @__PURE__ */ new Date();
					publishEvent?.(CW_EVENTS.PLAYBOOK_FAILED, "playbook-engine", {
						playbook_id: playbookId,
						run_id: runId,
						error: run.error,
						timeout: true
					}).catch(() => {});
				}
			}, playbookTimeoutMs);
			await runSteps(def, run, ctx, 0).finally(() => clearTimeout(timeoutHandle));
		} catch (err) {
			if (err instanceof HitlSuspendedError) {
				const stepIndex = def.steps.findIndex((s) => s.id === err.stepId);
				storeSuspended(runId, {
					playbookId,
					input,
					variables: { ...ctx.variables },
					nextStepIndex: stepIndex >= 0 ? stepIndex + 1 : def.steps.length,
					hitlStepId: err.stepId
				});
				run.status = "waiting_hitl";
				persistRun(upsertRun, run, suspended.get(runId));
				return run;
			}
			run.status = "failed";
			run.error = err instanceof Error ? err.message : String(err);
			run.completedAt = /* @__PURE__ */ new Date();
			clearSuspended(runId);
			globalMetrics.increment(CW_EVENTS.PLAYBOOK_FAILED, { playbook_id: playbookId });
			globalMetrics.recordDuration("playbook.duration_ms", Date.now() - _pbStartMs, {
				playbook_id: playbookId,
				status: "failed"
			});
			publishEvent?.(CW_EVENTS.PLAYBOOK_FAILED, "playbook-engine", {
				playbook_id: playbookId,
				run_id: runId,
				error: run.error,
				user_id: String(input.user_id ?? input.sender_id ?? ""),
				original_text: String(input.text ?? input.message ?? ""),
				failed_at: run.completedAt.toISOString()
			}).catch(() => {});
			publishEvent?.(CW_EVENTS.PLAYBOOK_RUN_FAILED, "playbook-engine", {
				playbook_id: playbookId,
				run_id: runId,
				error: run.error,
				steps: run.steps.length,
				duration_ms: Date.now() - _pbStartMs
			}).catch(() => {});
		}
		if (run.status === "completed") {
			run.output = summarizeRunOutput(ctx.variables);
			globalMetrics.increment(CW_EVENTS.PLAYBOOK_COMPLETED, { playbook_id: playbookId });
			globalMetrics.recordDuration("playbook.duration_ms", Date.now() - _pbStartMs, {
				playbook_id: playbookId,
				status: "completed"
			});
			publishEvent?.(CW_EVENTS.PLAYBOOK_RUN_COMPLETED, "playbook-engine", {
				playbook_id: playbookId,
				run_id: runId,
				steps: run.steps.length,
				duration_ms: Date.now() - _pbStartMs
			}).catch(() => {});
			const sessionId = String(input.session_id ?? input.sessionId ?? "").trim();
			if (sessionId && deps.contextEngine) {
				const replyText = extractResponseText(ctx.variables);
				if (replyText) deps.contextEngine.append(sessionId, "assistant", replyText, {
					playbook_id: playbookId,
					run_id: runId
				});
			}
		}
		runs.set(runId, run);
		persistRun(upsertRun, run, suspended.get(runId));
		if (run.status !== "running") releaseConcurrency(playbookId);
		return run;
	}
	function releaseConcurrency(playbookId) {
		const cur = concurrencyMap.get(playbookId) ?? 1;
		if (cur <= 1) concurrencyMap.delete(playbookId);
		else concurrencyMap.set(playbookId, cur - 1);
	}
	async function runSteps(def, run, ctx, fromIndex) {
		for (let i = fromIndex; i < def.steps.length; i++) try {
			await executePlaybookStep(def.steps[i], ctx, run, stepDeps());
		} catch (err) {
			if (err instanceof HitlSuspendedError) throw err;
			if (err instanceof StepFailedError && err.policy === "continue") {
				deps.logger?.(`[claworks:playbook] step ${err.stepId} failed (continue): ${err.message}`);
				continue;
			}
			throw err;
		}
		if (run.status === "running") {
			run.status = "completed";
			run.completedAt = /* @__PURE__ */ new Date();
			run.output = summarizeRunOutput(ctx.variables);
		}
	}
	function stepDeps() {
		return {
			objectStore: deps.objectStore,
			kb: deps.kb,
			robot: deps.robot,
			hitl: deps.hitl,
			llmComplete,
			notify,
			connectorInvoke,
			subagentRun,
			skillRun,
			scriptRun,
			a2aPeers,
			modelRouter,
			rbacCheck: deps.rbacCheck,
			triggerPlaybook: (playbookId, input) => triggerInternal(playbookId, input),
			callPlaybook: async (playbookId, params, parentRunId) => {
				const child = await triggerInternal(playbookId, {
					...params,
					parent_run_id: parentRunId
				});
				return {
					output: child.output,
					status: child.status
				};
			},
			actionRegistry: deps.actionRegistry,
			intentRegistry: deps.intentRegistry,
			logger: deps.logger,
			productionMode,
			publishAnomaly
		};
	}
	function queryRunsFromDb(opts) {
		const conditions = [];
		const params = [];
		if (opts.playbookId) {
			conditions.push("playbook_id = ?");
			params.push(opts.playbookId);
		}
		if (opts.status) {
			conditions.push("status = ?");
			params.push(opts.status);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		params.push(opts.limit);
		const sql = `SELECT * FROM cw_playbook_runs ${where} ORDER BY started_at DESC LIMIT ?`;
		return db.prepare(sql).all(...params).map(rowToRun);
	}
	return {
		async loadFromPacks(packs) {
			playbooks.clear();
			for (const pack of packs) for (const pb of pack.playbooks) if (pb.id) playbooks.set(pb.id, pb);
		},
		load(playbook) {
			if (playbook.id) playbooks.set(playbook.id, playbook);
		},
		unload(id) {
			playbooks.delete(id);
		},
		list() {
			return [...playbooks.values()];
		},
		listPlaybooks() {
			return [...playbooks.values()];
		},
		setLlmComplete(fn) {
			llmComplete = fn;
		},
		setNotify(fn) {
			notify = fn;
		},
		setConnectorInvoke(fn) {
			connectorInvoke = fn;
		},
		setPublishAnomaly(fn) {
			publishAnomaly = fn;
		},
		setContextEngine(engine) {
			deps.contextEngine = engine;
		},
		async trigger(playbookId, input, partialCtx) {
			return triggerInternal(playbookId, input, partialCtx);
		},
		async getRun(runId) {
			if (runs.has(runId)) return runs.get(runId);
			const row = selectRun.get(runId);
			if (!row) return null;
			const run = rowToRun(row);
			const { suspended: susp } = parseStepsPersistence(row.steps);
			if (susp && run.status === "waiting_hitl") suspended.set(runId, susp);
			runs.set(runId, run);
			return run;
		},
		async listRuns(opts) {
			const limit = opts.limit ?? 50;
			const dbRuns = queryRunsFromDb({
				playbookId: opts.playbookId,
				status: opts.status,
				limit: limit * 2
			});
			const byId = /* @__PURE__ */ new Map();
			for (const run of dbRuns) byId.set(run.id, run);
			for (const run of runs.values()) {
				if (opts.playbookId && run.playbookId !== opts.playbookId) continue;
				if (opts.status && run.status !== opts.status) continue;
				byId.set(run.id, run);
			}
			return [...byId.values()].toSorted((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, limit);
		},
		async hydrateSuspendedRuns() {
			const rows = selectWaitingHitl.all();
			let count = 0;
			for (const row of rows) {
				const run = rowToRun(row);
				const { suspended: susp } = parseStepsPersistence(row.steps);
				if (!susp) {
					deps.logger?.(`[claworks:playbook] waiting_hitl run ${row.id} missing suspended metadata`);
					continue;
				}
				runs.set(run.id, run);
				suspended.set(run.id, susp);
				count += 1;
			}
			return count;
		},
		async expireStaleHitl() {
			const expired = deps.hitl.expireStale?.() ?? [];
			let count = 0;
			for (const { pending, decision } of expired) {
				const { runId, stepId } = pending;
				try {
					deps.logger?.(`[claworks:hitl] auto-expire run=${runId} step=${stepId} decision=${decision}`);
					if (decision === "abort") {
						const run = await this.getRun(runId);
						if (run) {
							run.status = "failed";
							run.error = `HITL timeout: step '${stepId}' expired with on_timeout=abort`;
							run.completedAt = /* @__PURE__ */ new Date();
						}
						if (deps.notify) await deps.notify({ message: `[HITL 超时] Playbook ${runId} 步骤 ${stepId} 超时后已终止（on_timeout=abort）` });
					} else await this.submitHitlDecision(runId, stepId, decision, "auto-escalated by timeout");
					count += 1;
				} catch (err) {
					deps.logger?.(`[claworks:hitl] expiry failed for run=${runId}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return count;
		},
		async reloadPack(packId) {
			if (reloadPackById) {
				if (!await reloadPackById(packId)) throw new Error(`Pack not found: ${packId}`);
				return;
			}
			if (reloadPacks) {
				await reloadPacks();
				return;
			}
			throw new Error("Pack reload is not configured");
		},
		async submitHitlDecision(runId, stepId, decision, comment) {
			const run = await this.getRun(runId);
			if (!run) throw new Error(`Run not found: ${runId}`);
			const pending = suspended.get(runId);
			if (!pending) throw new Error(`Run ${runId} is not waiting for HITL`);
			const step = run.steps.find((s) => s.stepId === stepId);
			if (step) {
				step.status = "completed";
				step.completedAt = /* @__PURE__ */ new Date();
				step.output = {
					decision,
					comment
				};
			}
			const def = playbooks.get(pending.playbookId);
			if (!def) throw new Error(`Playbook not found: ${pending.playbookId}`);
			const ctx = {
				runId,
				playbookId: pending.playbookId,
				variables: {
					...pending.variables,
					payload: pending.input,
					steps: pending.variables.steps ?? {},
					hitl_decision: decision,
					hitl_comment: comment ?? ""
				},
				objectStore: deps.objectStore,
				kb: deps.kb,
				robot: deps.robot,
				publishEvent,
				ontology,
				reloadPacks,
				a2aPeers
			};
			run.status = "running";
			clearSuspended(runId);
			try {
				await runSteps(def, run, ctx, pending.nextStepIndex);
			} catch (err) {
				if (err instanceof HitlSuspendedError) {
					const stepIndex = def.steps.findIndex((s) => s.id === err.stepId);
					storeSuspended(runId, {
						playbookId: pending.playbookId,
						input: pending.input,
						variables: { ...ctx.variables },
						nextStepIndex: stepIndex >= 0 ? stepIndex + 1 : def.steps.length,
						hitlStepId: err.stepId
					});
					run.status = "waiting_hitl";
				} else {
					run.status = "failed";
					run.error = err instanceof Error ? err.message : String(err);
					run.completedAt = /* @__PURE__ */ new Date();
					clearSuspended(runId);
				}
			}
			runs.set(runId, run);
			persistRun(upsertRun, run, suspended.get(runId));
			return run;
		}
	};
}
function summarizeRunOutput(variables) {
	const { steps: _steps, payload, ...rest } = variables;
	return {
		...rest,
		payload
	};
}
/**
* 从 Playbook 最终变量中提取机器人回复文本，用于写入对话历史。
* 按约定优先级查找：reply > response > answer > message > output > result
*/
function extractResponseText(variables) {
	for (const key of [
		"reply",
		"response",
		"answer",
		"message",
		"output",
		"result"
	]) {
		const val = variables[key];
		if (typeof val === "string" && val.trim()) return val.trim();
	}
	return null;
}
function parseStepsPersistence(raw) {
	const parsed = JSON.parse(raw);
	if (Array.isArray(parsed)) return { logs: reviveStepLogs(parsed) };
	return {
		logs: reviveStepLogs(parsed.logs ?? []),
		suspended: parsed.suspended
	};
}
function reviveStepLogs(logs) {
	return logs.map((log) => ({
		...log,
		startedAt: log.startedAt instanceof Date ? log.startedAt : new Date(log.startedAt),
		completedAt: log.completedAt ? log.completedAt instanceof Date ? log.completedAt : new Date(log.completedAt) : void 0
	}));
}
/** JSON.stringify with circular reference protection. */
function safeJsonStringify(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	return JSON.stringify(value, (_key, val) => {
		if (typeof val === "object" && val !== null) {
			if (seen.has(val)) return "[Circular]";
			seen.add(val);
		}
		return val;
	});
}
function persistRun(stmt, run, susp) {
	const stepsJson = susp != null ? safeJsonStringify({
		logs: run.steps,
		suspended: susp
	}) : safeJsonStringify(run.steps);
	stmt.run(run.id, run.playbookId, run.status, safeJsonStringify(run.input), run.output ? safeJsonStringify(run.output) : null, run.error ?? null, stepsJson, run.startedAt.getTime(), run.completedAt?.getTime() ?? null);
}
function rowToRun(row) {
	const { logs } = parseStepsPersistence(row.steps);
	return {
		id: row.id,
		playbookId: row.playbook_id,
		status: row.status,
		startedAt: new Date(row.started_at),
		completedAt: row.completed_at ? new Date(row.completed_at) : void 0,
		input: JSON.parse(row.input),
		output: row.output ? JSON.parse(row.output) : void 0,
		error: row.error ?? void 0,
		steps: logs
	};
}
/**
* 从 ContextEngine 构建会话上下文摘要，注入为 _session 变量。
*
* 数据形态（Playbook 中可直接访问）：
*   {{_session.session_id}}        — 会话 ID
*   {{_session.turn_count}}        — 历史轮次数
*   {{_session.history_text}}      — 可直接粘贴进 Prompt 的文本格式历史
*   {{_session.history}}           — 原始轮次数组（role/content/timestamp）
*/
function buildSessionContext(sessionId, contextEngine) {
	if (!sessionId || !contextEngine) return {
		session_id: sessionId,
		turn_count: 0,
		history: [],
		history_text: ""
	};
	const turns = contextEngine.getRecent(sessionId, 10);
	const historyText = turns.map((t) => `[${t.role === "user" ? "用户" : "机器人"}] ${t.content}`).join("\n");
	return {
		session_id: sessionId,
		turn_count: turns.length,
		history: turns,
		history_text: historyText
	};
}
//#endregion
export { createPlaybookEngine as t };
