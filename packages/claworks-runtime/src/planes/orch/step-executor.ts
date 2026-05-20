import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveA2aTarget, type A2aPeerConfig } from "../../claworks/a2a-peers.js";
import type { ModelRouter } from "../../claworks/model-router.js";
import type { RbacCheckInput, RbacCheckResult } from "../../claworks/robot-identity.js";
import { A2aClient } from "../../interfaces/a2a/client.js";
import type { KnowledgeBase, RobotInfo } from "../../kernel/types.js";
import type { ObjectStore } from "../data/object-store.js";
import { executeFunction } from "./function-executor.js";
import type { HitlGate } from "./hitl-gate.js";
import type {
  ActionStep,
  PlaybookRun,
  PlaybookStep,
  PlaybookStepContext,
  StepLog,
  StepMeta,
} from "./playbook-types.js";
import { evaluatePlaybookCondition } from "./step-conditions.js";

export class HitlSuspendedError extends Error {
  constructor(
    public readonly token: string,
    public readonly stepId: string,
  ) {
    super(`HITL suspended: ${token}`);
    this.name = "HitlSuspendedError";
  }
}

export class StepFailedError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    public readonly policy: "abort" | "continue",
  ) {
    super(message);
    this.name = "StepFailedError";
  }
}

export type LlmCompleteFn = (params: {
  prompt: string;
  model?: string;
}) => Promise<{ text: string }>;

export type NotifyFn = (params: { message: string; channels?: string[] }) => Promise<void>;

export type ConnectorInvokeFn = (
  connectorId: string,
  method: string,
  params?: Record<string, unknown>,
) => Promise<void>;

export type TriggerPlaybookFn = (
  playbookId: string,
  input: Record<string, unknown>,
) => Promise<PlaybookRun>;

export type SubagentRunFn = (params: {
  prompt: string;
  model?: string;
}) => Promise<{ text: string }>;

export type SkillRunFn = (params: {
  skillId: string;
  input?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

export type StepExecutorDeps = {
  objectStore: ObjectStore;
  kb: KnowledgeBase;
  robot: RobotInfo;
  hitl: HitlGate;
  llmComplete?: LlmCompleteFn;
  notify?: NotifyFn;
  connectorInvoke?: ConnectorInvokeFn;
  triggerPlaybook?: TriggerPlaybookFn;
  subagentRun?: SubagentRunFn;
  skillRun?: SkillRunFn;
  a2aPeers?: A2aPeerConfig[];
  modelRouter?: ModelRouter;
  rbacCheck?: (input: RbacCheckInput) => RbacCheckResult;
  logger?: (msg: string) => void;
};

function recordStepResult(
  ctx: PlaybookStepContext,
  stepId: string,
  output: unknown,
  status: string = "ok",
): void {
  const steps = (ctx.variables.steps ?? {}) as Record<
    string,
    { status: string; result: Record<string, unknown> }
  >;
  steps[stepId] = {
    status,
    result:
      output && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : { value: output },
  };
  ctx.variables.steps = steps;
}

function resolveParams(
  params: Record<string, unknown>,
  ctx: PlaybookStepContext,
): Record<string, unknown> {
  return resolveParamsDeep(params, ctx.variables) as Record<string, unknown>;
}

function resolveParamsDeep(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return interpolate(value, vars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveParamsDeep(item, vars));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveParamsDeep(child, vars);
    }
    return out;
  }
  return value;
}

export async function executePlaybookStep(
  step: PlaybookStep,
  ctx: PlaybookStepContext,
  run: PlaybookRun,
  deps: StepExecutorDeps,
): Promise<void> {
  const meta = step as StepMeta;
  if (meta.condition && !evaluatePlaybookCondition(meta.condition, ctx.variables)) {
    const skipLog: StepLog = {
      stepId: step.id,
      status: "skipped",
      startedAt: new Date(),
      completedAt: new Date(),
      input: step,
      output: { skipped: true, reason: "condition" },
    };
    run.steps.push(skipLog);
    return;
  }

  const log: StepLog = {
    stepId: step.id,
    status: "running",
    startedAt: new Date(),
    input: step,
  };
  run.steps.push(log);

  try {
    if (step.kind === "notification") {
      const msg = interpolate(step.message, ctx.variables);
      // 支持 channels: 数组 和 channel: 单字符串两种写法（均做模板插值）
      const channelField = (step as Record<string, unknown>).channel as string | undefined;
      const rawChannels = step.channels ?? (channelField ? [channelField] : undefined);
      const resolvedChannels = rawChannels
        ?.map((c) => interpolate(c, ctx.variables))
        .filter(Boolean);
      if (deps.notify) {
        await deps.notify({ message: msg, channels: resolvedChannels });
      } else {
        deps.logger?.(`[claworks:notify] ${msg} channels=${resolvedChannels?.join(",") ?? "log"}`);
      }
      log.output = { message: msg, channels: resolvedChannels };
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "action") {
      log.output = await executeActionStep(step, ctx, deps);
      recordStepResult(ctx, step.id, log.output);
      await maybeHitlAfterStep(step, ctx, run, deps, log.output);
    } else if (step.kind === "function") {
      const params = resolveParams(step.params, ctx);
      const result = await executeFunction(step.functionApiName, params, {
        kb: deps.kb,
        llmComplete: deps.llmComplete,
        publishEvent: ctx.publishEvent,
        logger: deps.logger,
        playbookId: ctx.playbookId,
        runId: ctx.runId,
        stepId: step.id,
      });
      log.output = result;
      if (step.output) {
        ctx.variables[step.output] = result;
      }
      recordStepResult(ctx, step.id, result);
    } else if (step.kind === "connector") {
      if (!deps.connectorInvoke) {
        throw new Error("connector step requires connector runtime");
      }
      await deps.connectorInvoke(step.connectorId, step.method, step.params);
      log.output = { invoked: true };
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "playbook") {
      if (!deps.triggerPlaybook) {
        throw new Error("playbook step requires triggerPlaybook");
      }
      const child = await deps.triggerPlaybook(step.playbookId, {
        ...(step.input ?? {}),
        parent_run_id: ctx.runId,
      });
      log.output = { run_id: child.id, status: child.status };
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "atomic") {
      log.output = await executeAtomic(step.fn, step.params, ctx, deps);
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "hitl") {
      const token = deps.hitl.suspend(run, step.id, step.message, step.options);
      if (deps.notify) {
        await deps.notify({
          message: `[HITL] ${interpolate(step.message, ctx.variables)} (run=${run.id} step=${step.id})`,
          channels: step.channel ? [step.channel] : undefined,
        });
      }
      run.status = "waiting_hitl";
      log.status = "waiting";
      log.output = { hitl_token: token };
      throw new HitlSuspendedError(token, step.id);
    } else if (step.kind === "llm") {
      const prompt = interpolate(step.prompt, ctx.variables);
      if (deps.llmComplete) {
        const model = deps.modelRouter?.resolve("llm", step.model) ?? step.model;
        const result = await deps.llmComplete({ prompt, model });
        log.output = { text: result.text };
        ctx.variables[step.output] = result.text;
      } else {
        log.output = { stub: true, prompt };
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
          subjectId: deps.robot.name,
        });
        if (!rbac.allowed) {
          throw new StepFailedError(rbac.reason ?? "a2a.delegate denied", step.id, "abort");
        }
      }
      const targetUrl = resolveA2aTarget(targetRaw, peers);
      const message = interpolate(step.task, ctx.variables);
      const client = new A2aClient({ baseUrl: targetUrl });
      if (step.waitResult !== false) {
        const task = await client.sendAndWait({
          message: { role: "user", parts: [{ type: "text", text: message }] },
        });
        log.output = { task_id: task.id, status: task.status, result: task.result };
      } else {
        const task = await client.sendTask({
          message: { role: "user", parts: [{ type: "text", text: message }] },
        });
        log.output = { task_id: task.id, status: task.status };
      }
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "subagent") {
      const prompt = interpolate(step.prompt, ctx.variables);
      const model = deps.modelRouter?.resolve("subagent", step.model) ?? step.model;
      if (deps.subagentRun) {
        const result = await deps.subagentRun({ prompt, model });
        log.output = { text: result.text };
      } else if (deps.llmComplete) {
        const result = await deps.llmComplete({ prompt, model });
        log.output = { text: result.text };
      } else {
        log.output = { stub: true, prompt };
        deps.logger?.(`[claworks:subagent] stub: ${prompt.slice(0, 80)}...`);
      }
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "skill") {
      const input = step.input
        ? (resolveParamsDeep(step.input, ctx.variables) as Record<string, unknown>)
        : {};
      if (deps.skillRun) {
        log.output = await deps.skillRun({ skillId: step.skillId, input });
      } else {
        log.output = { stub: true, skillId: step.skillId, input };
        deps.logger?.(`[claworks:skill] stub skill=${step.skillId}`);
      }
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "condition") {
      const pass = evaluatePlaybookCondition(step.if, ctx.variables);
      const branch = pass ? step.then : (step.else ?? []);
      for (const child of branch) {
        await executePlaybookStep(child, ctx, run, deps);
      }
      log.output = { branch: pass ? "then" : "else" };
    } else if (step.kind === "memory_read") {
      const subject = interpolate(String(step.subject), ctx.variables);
      const key = interpolate(String(step.key), ctx.variables);
      const memId = `mem:${subject}:${key}`;
      const existing = await ctx.objectStore.get("RobotMemory", memId).catch(() => null);
      if (existing) {
        log.output = {
          found: true,
          value: existing.value,
          confidence: existing.confidence,
          subject,
          key,
        };
      } else {
        log.output = { found: false, value: undefined, subject, key };
      }
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
        confidence: step.confidence ?? 0.9,
        source: step.source
          ? interpolate(String(step.source), ctx.variables)
          : `playbook:${ctx.playbookId}`,
        updatedAt: new Date().toISOString(),
      };
      await ctx.objectStore.upsert("RobotMemory", memId, memObj);
      log.output = { written: true, id: memId, subject, key, value: memObj.value };
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "publish_event") {
      if (!ctx.publishEvent) {
        log.output = { stub: true, eventType: step.eventType };
        deps.logger?.(
          `[claworks:publish_event] no publishEvent fn, stub eventType=${step.eventType}`,
        );
      } else {
        const eventType = interpolate(step.eventType, ctx.variables);
        const source = step.source
          ? interpolate(step.source, ctx.variables)
          : `playbook:${ctx.playbookId}`;
        const resolvedPayload = step.payload
          ? (resolveParamsDeep(step.payload, ctx.variables) as Record<string, unknown>)
          : {};
        await ctx.publishEvent(eventType, source, resolvedPayload, ctx.runId);
        log.output = { published: true, eventType, source };
        deps.logger?.(`[claworks:publish_event] published ${eventType} from ${source}`);
      }
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    }
    if (log.status === "running") {
      log.status = "completed";
    }
  } catch (err) {
    if (err instanceof HitlSuspendedError) {
      throw err;
    }
    log.status = "failed";
    log.error = err instanceof Error ? err.message : String(err);
    recordStepResult(ctx, step.id, { error: log.error }, "failed");
    const policy = meta.onFailure ?? "abort";
    throw new StepFailedError(log.error, step.id, policy);
  } finally {
    if (log.status === "running") {
      log.status = "completed";
    }
    log.completedAt = new Date();
  }
}

async function maybeHitlAfterStep(
  step: ActionStep,
  ctx: PlaybookStepContext,
  run: PlaybookRun,
  deps: StepExecutorDeps,
  output: unknown,
): Promise<void> {
  const hitl = step.hitl;
  if (!hitl?.requiredIf) {
    return;
  }
  if (hitl.autoApproveIf && evaluatePlaybookCondition(hitl.autoApproveIf, ctx.variables)) {
    return;
  }
  if (!evaluatePlaybookCondition(hitl.requiredIf, ctx.variables)) {
    return;
  }
  const message = `Approve action ${step.actionApiName} for run ${run.id}?`;
  const token = deps.hitl.suspend(run, `${step.id}_hitl`, message, ["approve", "reject"]);
  if (deps.notify) {
    await deps.notify({ message: `[HITL] ${message}`, channels: undefined });
  }
  run.status = "waiting_hitl";
  throw new HitlSuspendedError(token, step.id);
}

async function executeActionStep(
  step: ActionStep,
  ctx: PlaybookStepContext,
  deps: StepExecutorDeps,
): Promise<Record<string, unknown>> {
  const params = resolveParams(step.params, ctx);
  const action = step.actionApiName;

  if (step.objectType && step.objectId) {
    return await ctx.objectStore.executeAction(
      step.objectType,
      interpolate(step.objectId, ctx.variables),
      action,
      params,
      ctx,
    );
  }

  if (action === "mes_production_dispatch") {
    return await ctx.objectStore.executeAction("_mes", "_virtual", action, params, ctx);
  }

  if (action === "reload_packs") {
    if (!ctx.reloadPacks) {
      throw new Error("reload_packs requires ClaWorks pack runtime");
    }
    const result = await ctx.reloadPacks();
    const packs = (result.packs as Array<{ manifest: { id: string } }> | undefined) ?? [];
    return {
      status: "ok",
      total: packs.length,
      loaded: packs.length,
      pack_ids: packs.map((p) => p.manifest.id),
    };
  }

  // ── update_object / patch_object — 通用对象字段更新 ──────────────────
  if (action === "update_object" || action === "patch_object") {
    const typeName = String(params.type ?? params.object_type ?? "");
    const id = String(params.id ?? params.object_id ?? "");
    if (!typeName || !id) return { status: "error", reason: "type and id are required" };
    const { type: _t, object_type: _ot, id: _id, object_id: _oid, ...fields } = params;
    const updated = await ctx.objectStore.update(typeName, id, fields);
    return { status: "ok", id, ...updated };
  }

  // ── create_quote / create_bid_project / create_bid_document ─────────
  if (action === "create_quote") {
    const quoteNo = `Q-${Date.now().toString(36).toUpperCase()}`;
    const created = await ctx.objectStore.create(
      "Quote",
      { ...params, quote_no: quoteNo, status: "draft" },
      ctx,
    );
    if (ctx.publishEvent) {
      await ctx.publishEvent(
        "quote.created",
        "playbook-action",
        { ...created },
        ctx.triggerEvent?.correlationId,
      );
    }
    return { status: "ok", id: created.id, quote_no: quoteNo, ...created };
  }

  if (action === "create_bid_project") {
    const created = await ctx.objectStore.create("BidProject", { ...params, status: "draft" }, ctx);
    if (ctx.publishEvent) {
      await ctx.publishEvent(
        "bid_project.created",
        "playbook-action",
        { ...created },
        ctx.triggerEvent?.correlationId,
      );
    }
    return { status: "ok", id: created.id, ...created };
  }

  if (action === "create_bid_document") {
    const wordCount = typeof params.content === "string" ? (params.content as string).length : 0;
    const created = await ctx.objectStore.create(
      "BidDocument",
      { ...params, word_count: wordCount, status: "draft" },
      ctx,
    );
    if (ctx.publishEvent) {
      await ctx.publishEvent(
        "bid_document.created",
        "playbook-action",
        { id: created.id, bid_project_id: params.bid_project_id, doc_type: params.doc_type },
        ctx.triggerEvent?.correlationId,
      );
    }
    return { status: "ok", id: created.id, ...created };
  }

  if (action === "create_customer") {
    const created = await ctx.objectStore.create(
      "Customer",
      { ...params, status: params.status ?? "prospect" },
      ctx,
    );
    return { status: "ok", id: created.id, ...created };
  }

  if (action === "create_product") {
    const created = await ctx.objectStore.create("Product", { ...params, status: "active" }, ctx);
    return { status: "ok", id: created.id, ...created };
  }

  // ── 通用 create_* 动作：按 objectType 推断或从 params 中读取 ──────────
  const actionTypeMap: Record<string, string> = {
    create_work_order: "WorkOrder",
    create_task: "Task",
    create_approval_request: "ApprovalRequest",
    create_incident: "Incident",
    create_meeting: "Meeting",
    broadcast_announcement: "Announcement",
  };
  const mappedType = actionTypeMap[action];

  if (action === "create_work_order" || mappedType) {
    const typeName = mappedType ?? String(params.type ?? params.object_type ?? "WorkOrder");
    const created = await ctx.objectStore.create(typeName, params, ctx);
    // 发布对应的领域事件，让 EventKernel 触发下游 Playbook
    if (ctx.publishEvent) {
      const eventMap: Record<string, string> = {
        Task: "task.created",
        ApprovalRequest: "approval.created",
        Incident: "incident.created",
        Meeting: "meeting.created",
        Announcement: "announcement.publish",
      };
      const evType = eventMap[typeName];
      if (evType) {
        await ctx.publishEvent(
          evType,
          "playbook-action",
          { ...created },
          ctx.triggerEvent?.correlationId,
        );
      }
    }
    return { status: "ok", id: created.id, ...created };
  }

  if (action.startsWith("create_")) {
    const typeName = String(params.type ?? params.object_type ?? "WorkOrder");
    const created = await ctx.objectStore.create(typeName, params, ctx);
    return { status: "ok", id: created.id, ...created };
  }

  // ── update / resolve 动作：patch ObjectStore 对象 + 可选发布后续事件 ──
  if (action === "update_task_status") {
    const id = String(params.task_id ?? params.id ?? "");
    if (!id) return { status: "error", reason: "task_id required" };
    const updated = await ctx.objectStore.update("Task", id, {
      status: params.status,
      ...(params.comment ? { last_comment: params.comment } : {}),
    });
    if (ctx.publishEvent) {
      await ctx.publishEvent(
        "task.status_changed",
        "playbook-action",
        { id, status: params.status },
        ctx.triggerEvent?.correlationId,
      );
    }
    return { status: "ok", id, ...updated };
  }

  if (action === "resolve_approval") {
    const id = String(params.request_id ?? params.id ?? "");
    if (!id) return { status: "error", reason: "request_id required" };
    const updated = await ctx.objectStore.update("ApprovalRequest", id, {
      status: params.status,
      decision_reason: params.decision_reason ?? "",
      decided_at: new Date().toISOString(),
    });
    if (ctx.publishEvent) {
      await ctx.publishEvent(
        "approval.decided",
        "playbook-action",
        { id, ...updated },
        ctx.triggerEvent?.correlationId,
      );
    }
    return { status: "ok", id, ...updated };
  }

  if (action === "resolve_incident") {
    const id = String(params.incident_id ?? params.id ?? "");
    if (!id) return { status: "error", reason: "incident_id required" };
    const updated = await ctx.objectStore.update("Incident", id, {
      status: "resolved",
      root_cause: params.root_cause ?? "",
      resolution: params.resolution ?? "",
      resolved_at: new Date().toISOString(),
    });
    if (ctx.publishEvent) {
      await ctx.publishEvent(
        "incident.resolved",
        "playbook-action",
        { id, ...updated },
        ctx.triggerEvent?.correlationId,
      );
    }
    return { status: "ok", id, ...updated };
  }

  if (action === "update_robot_owner") {
    await ctx.objectStore.upsert("RobotOwner", `owner:${params.owner_id}`, {
      owner_id: params.owner_id,
      channel_id: params.channel_id,
      ...(params.handover_note ? { handover_note: params.handover_note } : {}),
    });
    return { status: "ok", owner_id: params.owner_id, channel_id: params.channel_id };
  }

  // ── 查询动作：返回 ObjectStore 列表（供 Playbook 变量引用）────────────
  if (action === "query_overdue_tasks") {
    const now = new Date().toISOString();
    const { items } = await ctx.objectStore.query("Task", { limit: 50 });
    const statuses = (params.status_filter as string[] | undefined) ?? ["open", "in_progress"];
    const overdue = items.filter(
      (t) => statuses.includes(String(t.status)) && typeof t.due_at === "string" && t.due_at < now,
    );
    return { status: "ok", items: overdue, count: overdue.length };
  }

  if (action === "query_user_tasks") {
    const userId = String(params.user_id ?? "");
    const { items } = await ctx.objectStore.query("Task", { limit: Number(params.limit ?? 10) });
    const userTasks = userId ? items.filter((t) => t.assignee_id === userId) : items;
    return { status: "ok", items: userTasks, count: userTasks.length };
  }

  if (action === "query_daily_stats") {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const iso = todayStart.toISOString();

    const [tasks, incidents, approvals] = await Promise.all([
      ctx.objectStore.query("Task", { limit: 200 }),
      ctx.objectStore.query("Incident", { limit: 200 }),
      ctx.objectStore.query("ApprovalRequest", { limit: 200 }),
    ]);

    const todayTasks = tasks.items.filter((t) => String(t._createdAt ?? "") >= iso);
    const stats = {
      tasks_created: todayTasks.length,
      tasks_done: todayTasks.filter((t) => t.status === "done").length,
      tasks_in_progress: tasks.items.filter((t) => t.status === "in_progress").length,
      tasks_overdue: tasks.items.filter(
        (t) =>
          t.status !== "done" &&
          t.status !== "cancelled" &&
          typeof t.due_at === "string" &&
          t.due_at < new Date().toISOString(),
      ).length,
      incidents_created: incidents.items.filter((i) => String(i._createdAt ?? "") >= iso).length,
      incidents_resolved: incidents.items.filter(
        (i) => i.status === "resolved" && String(i._updatedAt ?? "") >= iso,
      ).length,
      incidents_open: incidents.items.filter((i) =>
        ["open", "investigating"].includes(String(i.status)),
      ).length,
      approvals_pending: approvals.items.filter((a) => a.status === "pending").length,
      approvals_decided: approvals.items.filter(
        (a) => String(a._updatedAt ?? "") >= iso && a.status !== "pending",
      ).length,
    };
    return { status: "ok", date: params.date ?? "today", ...stats };
  }

  if (action === "search_kb") {
    const query = String(params.query ?? "");
    const limit = Number(params.limit ?? 5);
    const results = await ctx.kb.search(query, { limit });
    return { status: "ok", results, count: results.length };
  }

  if (action === "ingest_kb_text") {
    const text = String(params.text ?? "");
    if (!text) return { status: "error", reason: "text is required" };
    await ctx.kb.ingest(text, {
      namespace: params.namespace ? String(params.namespace) : undefined,
      source: params.source ? String(params.source) : undefined,
    });
    return { status: "ok", ingested: true };
  }

  if (action === "ingest_folder") {
    const folderPath = String(params.folder_path ?? "");
    if (!folderPath) return { status: "error", reason: "folder_path is required" };
    const ns = params.namespace ? String(params.namespace) : undefined;
    const srcPrefix = params.source_prefix ? String(params.source_prefix) : undefined;
    const recursive = params.recursive !== false;
    const allowedExts = new Set<string>(
      Array.isArray(params.file_types)
        ? (params.file_types as string[]).map((e) => (e.startsWith(".") ? e : `.${e}`))
        : [".txt", ".md", ".markdown", ".json", ".csv", ".yaml", ".yml"],
    );
    const collect = (dir: string): string[] => {
      try {
        return readdirSync(dir).flatMap((entry) => {
          const full = join(dir, entry);
          try {
            const st = statSync(full);
            if (st.isDirectory() && recursive) return collect(full);
            if (st.isFile() && allowedExts.has(extname(entry).toLowerCase())) return [full];
          } catch {
            /* skip */
          }
          return [];
        });
      } catch {
        return [];
      }
    };
    const files = collect(folderPath);
    let ok = 0;
    let errors = 0;
    for (const file of files) {
      try {
        const text = readFileSync(file, "utf-8");
        const source = srcPrefix ? `${srcPrefix}/${file.slice(folderPath.length + 1)}` : file;
        await ctx.kb.ingest(text, { namespace: ns, source });
        ok++;
      } catch {
        errors++;
      }
    }
    if (ctx.publishEvent) {
      await ctx.publishEvent(
        "kb.folder_ingested",
        "playbook-action",
        { folder_path: folderPath, namespace: ns, total: files.length, ok, errors },
        ctx.triggerEvent?.correlationId,
      );
    }
    return { status: "ok", total: files.length, ingested: ok, errors };
  }

  return await ctx.objectStore.executeAction(
    String(params.type ?? params.object_type ?? "WorkOrder"),
    String(params.id ?? randomUUID()),
    action,
    params,
    ctx,
  );
}

async function executeAtomic(
  fn: string,
  params: Record<string, unknown>,
  ctx: PlaybookStepContext,
  deps: StepExecutorDeps,
): Promise<unknown> {
  if (fn === "objects.create" || fn.startsWith("create_")) {
    const typeName = String(params.type ?? params.object_type ?? "WorkOrder");
    return ctx.objectStore.create(typeName, params, ctx);
  }
  if (fn === "kb.search") {
    return ctx.kb.search(String(params.query ?? ""));
  }
  if (fn === "kb.ingest") {
    await ctx.kb.ingest(String(params.text ?? ""), {
      namespace: params.namespace ? String(params.namespace) : undefined,
    });
    return { ingested: true };
  }
  if (fn === "connector.invoke") {
    if (!deps.connectorInvoke) {
      throw new Error("connector.invoke requires ClaWorks connector runtime");
    }
    await deps.connectorInvoke(
      String(params.connector_id ?? params.connector ?? ""),
      String(params.method ?? ""),
      (params.params ?? params.args) as Record<string, unknown> | undefined,
    );
    return { invoked: true };
  }
  if (fn === "a2a.send") {
    const targetRaw = String(params.target_url ?? params.url ?? params.target ?? "");
    if (!targetRaw) {
      throw new Error("a2a.send requires target_url or target (peer name)");
    }
    const targetUrl = resolveA2aTarget(targetRaw, deps.a2aPeers ?? []);
    const client = new A2aClient({ baseUrl: targetUrl });
    const task = await client.sendAndWait({
      message: {
        role: "user",
        parts: [{ type: "text", text: String(params.message ?? "") }],
      },
      metadata:
        params.metadata && typeof params.metadata === "object"
          ? (params.metadata as Record<string, unknown>)
          : undefined,
    });
    return { task_id: task.id, status: task.status, result: task.result };
  }
  return { fn, params };
}

function stepResultField(
  steps: Record<string, { status?: string; result?: Record<string, unknown> }>,
  stepId: string,
  field: string,
  fallback = "",
): string {
  const value = steps[stepId]?.result?.[field];
  return value != null && value !== "" ? String(value) : fallback;
}

export function interpolate(template: string, vars: Record<string, unknown>): string {
  const payload = (vars.payload ?? vars) as Record<string, unknown>;
  const steps = (vars.steps ?? {}) as Record<
    string,
    { status?: string; result?: Record<string, unknown> }
  >;

  let out = template
    .replace(/\{\{\s*payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g, (_, key) =>
      String(payload[key] ?? ""),
    )
    .replace(
      /\{\{\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)\s*\)\s*\}\}/g,
      (_, stepId, fieldA, stepId2, fieldB, literalFallback) => {
        const sid = stepId === stepId2 ? stepId : stepId;
        return stepResultField(
          steps,
          sid,
          fieldA,
          stepResultField(steps, sid, fieldB, literalFallback),
        );
      },
    )
    .replace(
      /\{\{\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g,
      (_, stepId, field) => stepResultField(steps, stepId, field),
    )
    .replace(
      /\{\{\s*steps\.get\(\s*['"](\w+)['"]\s*,\s*\{\}\)\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*\}\}/g,
      (_, stepId, field) => {
        const step = steps[stepId];
        if (field === "status") {
          return String(step?.status ?? "");
        }
        return stepResultField(steps, stepId, field);
      },
    )
    .replace(/\{\{\s*(\w+)\s+or\s+['"]([^'"]*)['"]\s*\}\}/g, (_, key, fallback) => {
      const v = vars[key];
      return v != null && v !== "" ? String(v) : fallback;
    })
    .replace(/\{\{\s*(\w+)\.(\w+)\s*\}\}/g, (_, obj, field) => {
      const objVal = vars[obj];
      if (objVal && typeof objVal === "object" && !Array.isArray(objVal)) {
        return String((objVal as Record<string, unknown>)[field] ?? "");
      }
      return "";
    })
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));

  out = out.replace(
    /\{\{\s*round\(\s*float\(\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*\)\s*\*\s*100\s*\)\s*\}\}/g,
    (_, stepId, field) => {
      const raw = steps[stepId]?.result?.[field];
      const n = Number.parseFloat(String(raw ?? 0));
      return String(Math.round(n * 100));
    },
  );

  return out;
}
