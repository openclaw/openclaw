import { n as StepFailedError, r as executePlaybookStep, t as HitlSuspendedError } from "./step-executor-Dgu_uWbI.mjs";
import { randomUUID } from "node:crypto";
//#region src/planes/orch/playbook-engine.ts
function createPlaybookEngine(deps) {
	const playbooks = /* @__PURE__ */ new Map();
	const runs = /* @__PURE__ */ new Map();
	const suspended = /* @__PURE__ */ new Map();
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
		const runId = randomUUID();
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
		const ctx = {
			runId,
			playbookId,
			variables: {
				...input,
				payload: input,
				trigger: input,
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
				steps: {}
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
			await runSteps(def, run, ctx, 0);
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
			publishEvent?.("playbook.failed", "playbook-engine", {
				playbook_id: playbookId,
				run_id: runId,
				error: run.error,
				user_id: String(input.user_id ?? input.sender_id ?? ""),
				original_text: String(input.text ?? input.message ?? ""),
				failed_at: run.completedAt.toISOString()
			}).catch(() => {});
		}
		if (run.status === "completed") run.output = summarizeRunOutput(ctx.variables);
		runs.set(runId, run);
		persistRun(upsertRun, run, suspended.get(runId));
		return run;
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
			a2aPeers,
			modelRouter,
			rbacCheck: deps.rbacCheck,
			triggerPlaybook: (playbookId, input) => triggerInternal(playbookId, input),
			actionRegistry: deps.actionRegistry,
			intentRegistry: deps.intentRegistry,
			logger: deps.logger
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
//#endregion
export { createPlaybookEngine as t };
