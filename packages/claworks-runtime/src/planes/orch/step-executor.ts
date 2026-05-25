import { randomUUID } from "node:crypto";
import { resolveA2aTarget, type A2aPeerConfig } from "../../claworks/a2a-peers.js";
import type { ModelRouter } from "../../claworks/model-router.js";
import type { RbacCheckInput, RbacCheckResult } from "../../claworks/robot-identity.js";
import { A2aClient } from "../../interfaces/a2a/client.js";
import type { ActionRegistry } from "../../kernel/action-registry.js";
import type { ContextPacket } from "../../kernel/event-context.js";
import { buildLlmContext } from "../../kernel/llm-context-builder.js";
import { createChildTraceContext, formatTraceparent } from "../../kernel/trace-context.js";
import type { KnowledgeBase, RobotInfo } from "../../kernel/types.js";
import { isDocumentKnowledgeBase } from "../data/kb-types.js";
import type { ObjectStore } from "../data/object-store.js";
import { executeFunction } from "./function-executor.js";
import type { HitlGate } from "./hitl-gate.js";
import type {
  ActionStep,
  CallPlaybookStep,
  PlaybookRun,
  PlaybookStep,
  PlaybookStepContext,
  StepLog,
  StepMeta,
} from "./playbook-types.js";
import { evaluatePlaybookCondition } from "./step-conditions.js";
import { expandJinjaForLoops } from "./template-resolve.js";

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
  temperature?: number;
}) => Promise<{ text: string }>;

export type NotifyFn = (params: {
  message: string;
  channels?: string[];
  /**
   * 渠道原生富格式卡片数据（可选）。
   * key 为渠道 ID（如 "feishu"），value 为该渠道的原生卡片 JSON。
   * 由 comms.send 能力通过 CardBuilder.toAuto() 生成后传入；
   * notify 实现按渠道判断是否支持富格式，不支持则降级为纯文本。
   */
  cards?: Record<string, unknown>;
}) => Promise<void>;

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

/**
 * ScriptRunFn — 调用 ClaWorks 内置脚本（纯代码，不依赖 LLM）。
 * 对应 kind:script Playbook 步骤。
 */
export type ScriptRunFn = (params: {
  scriptId: string;
  input?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

/** Route Playbook action steps to CapabilityRegistry.invoke (e.g. perceive.intent). */
export type CapabilityInvokeFn = (
  capabilityId: string,
  params: Record<string, unknown>,
  ctx: PlaybookStepContext,
) => Promise<Record<string, unknown>>;

export type CallPlaybookFn = (
  playbookId: string,
  params: Record<string, unknown>,
  parentRunId: string,
) => Promise<{ output?: Record<string, unknown>; status: string }>;

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
  scriptRun?: ScriptRunFn;
  callPlaybook?: CallPlaybookFn;
  a2aPeers?: A2aPeerConfig[];
  modelRouter?: ModelRouter;
  rbacCheck?: (input: RbacCheckInput) => RbacCheckResult;
  logger?: (msg: string) => void;
  /**
   * Pack action registry — step-executor 优先在此查找处理器。
   * 找到时直接委托给 Pack 注册的 ActionHandler，无需修改 runtime。
   */
  actionRegistry?: ActionRegistry;
  /** Capability registry invoke bridge — routes actionApiName like perceive.intent */
  capabilityInvoke?: CapabilityInvokeFn;
  /** Whether capabilityId is registered (avoids misrouting snake_case CRUD actions) */
  capabilityHas?: (capabilityId: string) => boolean;
  /**
   * Pack intent registry — 传递给 function-executor 的 publish_event_from_intent。
   * 各 Pack 在 entry.ts 通过 PackContribution.intentMappings 注册。
   */
  intentRegistry?: import("../../kernel/intent-registry.js").IntentRegistry;
  /**
   * 生产模式：true 时 LLM/skill/subagent/script/call_playbook bridge 缺失时
   * 抛 StepFailedError 而非返回 stub 结果（fail-closed）。
   * 由 createClaworksRuntime 根据 config.production_mode 或
   * CLAWORKS_PRODUCTION env 注入。
   */
  productionMode?: boolean;
  /** 发布异常事件（供 Playbook 响应），由 runtime 注入 */
  publishAnomaly?: (payload: Record<string, unknown>) => Promise<void>;
  /** promptRegistry 模板渲染，classify/fast LLM 步骤优先使用 */
  renderPromptTemplate?: (id: string, vars: Record<string, unknown>) => string | null;
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

function stepTraceparent(ctx: PlaybookStepContext, run: PlaybookRun): string | undefined {
  const parent = ctx.traceparent ?? run.traceparent;
  if (!parent) {
    return undefined;
  }
  return formatTraceparent(createChildTraceContext(parent));
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
      traceparent: stepTraceparent(ctx, run),
    };
    run.steps.push(skipLog);
    return;
  }

  const log: StepLog = {
    stepId: step.id,
    status: "running",
    startedAt: new Date(),
    input: step,
    traceparent: stepTraceparent(ctx, run),
  };
  run.steps.push(log);

  try {
    if (step.kind === "notification") {
      const msg = interpolate(step.message, ctx.variables);
      // 支持 channels: 数组 和 channel: 单字符串两种写法（均做模板插值）
      const channelField = (step as unknown as Record<string, unknown>).channel as
        | string
        | undefined;
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
      const actionStart = Date.now();
      const SLOW_STEP_MS = 5_000;
      // 超过 5s 发布 playbook.step_slow 事件，触发进度提醒 Playbook
      const slowTimer = setTimeout(() => {
        ctx
          .publishEvent?.(
            "playbook.step_slow",
            "step-executor",
            {
              playbook_id: ctx.playbookId,
              run_id: ctx.runId,
              step_id: step.id,
              step_name: (step as unknown as Record<string, unknown>).name ?? step.id,
              action: (step as unknown as Record<string, unknown>).action ?? step.id,
              elapsed_ms: Date.now() - actionStart,
              requester_channel: ctx.variables.requester_channel ?? ctx.variables.channel ?? "",
              user_id: ctx.variables.user_id ?? "",
            },
            ctx.runId,
            log.traceparent,
          )
          .catch(() => {
            /* non-critical */
          });
      }, SLOW_STEP_MS);
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
        publishAnomaly: deps.publishAnomaly,
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
        ...step.input,
        parent_run_id: ctx.runId,
      });
      log.output = { run_id: child.id, status: child.status };
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "atomic") {
      log.output = await executeAtomic(step.fn, step.params, ctx, deps);
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "hitl") {
      const token = deps.hitl.suspend(
        run,
        step.id,
        step.message,
        step.options,
        step.timeout_seconds,
        step.on_timeout,
      );
      if (deps.notify) {
        const timeoutNote = step.timeout_seconds
          ? ` (${step.timeout_seconds}s 后自动${step.on_timeout === "abort" ? "终止" : `选择「${step.on_timeout ?? step.options[0]}」`})`
          : "";
        await deps.notify({
          message: `[HITL] ${interpolate(step.message, ctx.variables)}${timeoutNote} (run=${run.id} step=${step.id})`,
          channels: step.channel ? [step.channel] : undefined,
        });
      }
      run.status = "waiting_hitl";
      log.status = "waiting";
      log.output = { hitl_token: token, timeout_seconds: step.timeout_seconds };
      throw new HitlSuspendedError(token, step.id);
    } else if (step.kind === "llm") {
      const rawPrompt = interpolate(step.prompt, ctx.variables);

      // 信息流上下文丰富化：从 Playbook 变量 _ctx 读取预计算封包，自动注入 KB 案例
      const eventCtx = ctx.variables["_ctx"] as ContextPacket | undefined;
      const ctxResult = await buildLlmContext(
        {
          prompt: rawPrompt,
          task_type: step.task_type,
          context_level: step.context_level,
          domain: step.domain,
          output_fields: step.output_fields,
          event_context: eventCtx,
        },
        {
          logger: deps.logger,
          renderPromptTemplate: deps.renderPromptTemplate,
          fetchCases: async (query, limit) => {
            const results = await deps.kb.search(query, { limit });
            return results.map((r) => (r.title ? `[${r.title}] ${r.text}` : r.text));
          },
          fetchDomainKnowledge: async (domain: string) => {
            const results = await deps.kb.search(domain + " 领域知识", {
              limit: 3,
              namespace: "domain",
            });
            if (!results.length) {
              return null;
            }
            return results.map((r) => r.text).join("\n---\n");
          },
        },
      );
      const prompt = ctxResult.enriched_prompt;

      // 模型路由：显式 step.model > task_type 感知路由 > 默认
      let model: string | undefined;
      if (step.model?.trim()) {
        model = step.model.trim();
      } else if (deps.modelRouter) {
        const taskForRouter =
          step.task_type === "classify"
            ? "classify"
            : step.task_type === "analyze" || ctxResult.recommended_model_tier === "strong"
              ? "reason"
              : ctxResult.recommended_model_tier === "fast"
                ? "classify"
                : "chat";
        model = deps.modelRouter.resolveForTask(taskForRouter);
      }

      if (deps.llmComplete) {
        if (step.output_schema) {
          // 结构化输出：使用 StructuredOutputEngine 保证格式
          const { createStructuredOutputEngine } =
            await import("../../kernel/structured-output.js");
          const engine = createStructuredOutputEngine(async (p) =>
            deps.llmComplete!({ prompt: p.prompt, model }),
          );
          if (step.output_voting) {
            const { data, vote_counts, votes_cast } = await engine.completeWithVoting(
              prompt,
              step.output_schema,
              { votes: step.output_voting.votes, voteField: step.output_voting.field },
            );
            log.output = { ...data, _vote_counts: vote_counts, _votes_cast: votes_cast };
          } else {
            const { data } = await engine.complete(prompt, step.output_schema);
            log.output = data;
          }
          ctx.variables[step.output] = log.output;
        } else {
          const result = await deps.llmComplete({ prompt, model });
          log.output = { text: result.text };
          ctx.variables[step.output] = result.text;
        }
      } else if (deps.productionMode) {
        throw new StepFailedError(
          "LLM bridge 未配置（production_mode=true 时 stub 不可用）",
          step.id,
          "abort",
        );
      } else {
        log.output = { stub: true, prompt: rawPrompt };
        ctx.variables[step.output] = rawPrompt;
        deps.logger?.(`[claworks:llm] stub（无 LLM bridge）: ${rawPrompt.slice(0, 80)}...`);
        void deps.publishAnomaly?.({ kind: "stub_step", stepKind: "llm", stepId: step.id });
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
      const rawSubPrompt = interpolate(step.prompt, ctx.variables);

      // subagent 同样享受信息流上下文丰富化
      const subEventCtx = ctx.variables["_ctx"] as ContextPacket | undefined;
      const subCtxResult = await buildLlmContext(
        {
          prompt: rawSubPrompt,
          task_type: step.task_type,
          context_level: step.context_level,
          domain: step.domain,
          event_context: subEventCtx,
        },
        {
          logger: deps.logger,
          renderPromptTemplate: deps.renderPromptTemplate,
          fetchCases: async (query, limit) => {
            const results = await deps.kb.search(query, { limit });
            return results.map((r) => (r.title ? `[${r.title}] ${r.text}` : r.text));
          },
          fetchDomainKnowledge: async (domain: string) => {
            const results = await deps.kb.search(domain + " 领域知识", {
              limit: 3,
              namespace: "domain",
            });
            if (!results.length) {
              return null;
            }
            return results.map((r) => r.text).join("\n---\n");
          },
        },
      );
      const subPrompt = subCtxResult.enriched_prompt;

      let subModel: string | undefined;
      if (step.model?.trim()) {
        subModel = step.model.trim();
      } else if (deps.modelRouter) {
        const subTaskType =
          step.task_type === "classify"
            ? "classify"
            : subCtxResult.recommended_model_tier === "strong"
              ? "reason"
              : "chat";
        subModel = deps.modelRouter.resolveForTask(subTaskType);
      }

      if (deps.subagentRun) {
        const result = await deps.subagentRun({ prompt: subPrompt, model: subModel });
        log.output = { text: result.text };
      } else if (deps.llmComplete) {
        const result = await deps.llmComplete({ prompt: subPrompt, model: subModel });
        log.output = { text: result.text };
      } else if (deps.productionMode) {
        throw new StepFailedError(
          "subagent bridge 未配置（production_mode=true 时 stub 不可用）",
          step.id,
          "abort",
        );
      } else {
        log.output = { stub: true, prompt: rawSubPrompt };
        deps.logger?.(`[claworks:subagent] stub（无 bridge）: ${rawSubPrompt.slice(0, 80)}...`);
        void deps.publishAnomaly?.({ kind: "stub_step", stepKind: "subagent", stepId: step.id });
      }
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "skill") {
      const input = step.input
        ? (resolveParamsDeep(step.input, ctx.variables) as Record<string, unknown>)
        : {};
      const skillId = step.skillId;
      let skillOutput: Record<string, unknown> | undefined;

      // local-first：与 skill.run 能力一致，先查 scriptLibrary，未找到再走 OpenClaw harness
      if (deps.scriptRun) {
        try {
          const localResult = await deps.scriptRun({ scriptId: skillId, input });
          skillOutput = {
            ...localResult,
            source: "local",
            skill_id: skillId,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isNotFound =
            msg.includes("Script not found") || msg.includes(`Script not found: ${skillId}`);
          if (!isNotFound) {
            throw err;
          }
        }
      }

      if (!skillOutput) {
        if (deps.skillRun) {
          const harnessResult = await deps.skillRun({ skillId, input });
          skillOutput = {
            ...harnessResult,
            source: "harness",
            skill_id: skillId,
          };
        } else if (deps.productionMode) {
          throw new StepFailedError(
            `skill bridge 未配置（production_mode=true 时 stub 不可用），skillId=${skillId}`,
            step.id,
            "abort",
          );
        } else {
          skillOutput = { stub: true, skillId, input };
          deps.logger?.(`[claworks:skill] stub（无 skillRun）skill=${skillId}`);
          void deps.publishAnomaly?.({
            kind: "stub_step",
            stepKind: "skill",
            stepId: step.id,
            skillId,
          });
        }
      }

      log.output = skillOutput;
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "script") {
      const input = step.input
        ? (resolveParamsDeep(step.input, ctx.variables) as Record<string, unknown>)
        : {};
      if (deps.scriptRun) {
        log.output = await deps.scriptRun({ scriptId: step.scriptId, input });
      } else if (deps.productionMode) {
        throw new StepFailedError(
          `scriptRun 未配置（production_mode=true 时 stub 不可用），scriptId=${step.scriptId}`,
          step.id,
          "abort",
        );
      } else {
        log.output = { stub: true, scriptId: step.scriptId, input };
        deps.logger?.(`[claworks:script] stub（无 scriptRun）scriptId=${step.scriptId}`);
        void deps.publishAnomaly?.({
          kind: "stub_step",
          stepKind: "script",
          stepId: step.id,
          scriptId: step.scriptId,
        });
      }
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "call_playbook") {
      const resolvedId = interpolate(step.playbookId, ctx.variables);
      const params = step.params ? resolveParams(step.params, ctx) : {};
      if (deps.callPlaybook) {
        const result = await deps.callPlaybook(resolvedId, params, ctx.runId);
        log.output = result;
        if (step.storeResultAs) {
          ctx.variables[step.storeResultAs] = result.output ?? result;
        }
      } else if (deps.triggerPlaybook) {
        // fallback: reuse triggerPlaybook and wait for the run result.
        // session_id inheritance is handled by playbook-engine's callPlaybook bridge;
        // this path is unused in production where callPlaybook is always wired.
        const child = await deps.triggerPlaybook(resolvedId, {
          ...params,
          parent_run_id: ctx.runId,
        });
        log.output = { run_id: child.id, status: child.status, output: child.output };
        if (step.storeResultAs) {
          ctx.variables[step.storeResultAs] = child.output ?? {};
        }
      } else if (deps.productionMode) {
        throw new StepFailedError(
          `callPlaybook bridge 未配置（production_mode=true 时 stub 不可用），playbookId=${resolvedId}`,
          step.id,
          "abort",
        );
      } else {
        log.output = { stub: true, playbookId: resolvedId };
        if (step.storeResultAs) {
          ctx.variables[step.storeResultAs] = {};
        }
        deps.logger?.(`[claworks:call_playbook] stub（无 bridge）playbookId=${resolvedId}`);
        void deps.publishAnomaly?.({
          kind: "stub_step",
          stepKind: "call_playbook",
          stepId: step.id,
          playbookId: resolvedId,
        });
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
        if (deps.productionMode) {
          throw new StepFailedError(
            `publishEvent 未配置（production_mode=true），eventType=${step.eventType}`,
            step.id,
            "abort",
          );
        }
        log.output = { stub: true, eventType: step.eventType };
        deps.logger?.(
          `[claworks:publish_event] no publishEvent fn, stub eventType=${step.eventType}`,
        );
        void deps.publishAnomaly?.({
          kind: "stub_step",
          stepKind: "publish_event",
          stepId: step.id,
          eventType: step.eventType,
        });
      } else {
        const eventType = interpolate(step.eventType, ctx.variables);
        const source = step.source
          ? interpolate(step.source, ctx.variables)
          : `playbook:${ctx.playbookId}`;
        const resolvedPayload = step.payload
          ? (resolveParamsDeep(step.payload, ctx.variables) as Record<string, unknown>)
          : {};
        await ctx.publishEvent(eventType, source, resolvedPayload, ctx.runId, log.traceparent);
        log.output = { published: true, eventType, source };
        deps.logger?.(`[claworks:publish_event] published ${eventType} from ${source}`);
      }
      if (step.output) {
        ctx.variables[step.output] = log.output;
      }
      recordStepResult(ctx, step.id, log.output);
    } else if (step.kind === "parallel") {
      const ps = step;
      const timeoutMs = (ps.timeout_seconds ?? 30) * 1000;

      type BranchResult =
        | { idx: number; success: true; vars: Record<string, unknown> }
        | { idx: number; success: false; error: string };

      const branchPromises: Promise<BranchResult>[] = ps.branches.map(
        async (branch, idx): Promise<BranchResult> => {
          // Deep-copy the entire variables object so nested mutations in one branch
          // (arrays, sub-objects, step results) cannot contaminate sibling branches.
          let isolatedVars: Record<string, unknown>;
          try {
            isolatedVars = JSON.parse(JSON.stringify(ctx.variables)) as Record<string, unknown>;
          } catch {
            // Non-serializable values (e.g. functions) — fall back to shallow + steps copy.
            isolatedVars = {
              ...ctx.variables,
              steps: { ...(ctx.variables.steps as Record<string, unknown>) },
            };
          }
          const branchCtx = { ...ctx, variables: isolatedVars };
          try {
            for (const s of branch) {
              await executePlaybookStep(s, branchCtx, run, deps);
            }
            return { idx, success: true, vars: branchCtx.variables };
          } catch (e) {
            if (ps.on_branch_failure === "abort_all") {
              throw e;
            }
            return {
              idx,
              success: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        },
      );

      const settled = await Promise.race([
        Promise.allSettled(branchPromises),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("parallel timeout")), timeoutMs),
        ),
      ]);

      const results: BranchResult[] = settled.map((r) =>
        r.status === "fulfilled" ? r.value : { idx: -1, success: false, error: "rejected" },
      );

      log.output = { branches: results };
      if (ps.store_result_as) {
        ctx.variables[ps.store_result_as] = results;
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
  _output: unknown,
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

  // ── Pack ActionRegistry 优先分发 ─────────────────────────────────────
  // Pack entry.ts 通过 PackContribution.actionHandlers 注册的处理器在此调用，
  // 无需修改 step-executor 核心代码即可扩展新 action。
  if (deps.actionRegistry?.has(action)) {
    const reg = deps.actionRegistry.get(action)!;
    deps.logger?.(`[claworks:action] dispatching '${action}' to pack '${reg.packId}'`);
    return await reg.handler(params, ctx);
  }

  if (deps.capabilityHas?.(action) && deps.capabilityInvoke) {
    deps.logger?.(`[claworks:action] routing '${action}' via capabilities.invoke`);
    return await deps.capabilityInvoke(action, params, ctx);
  }

  if (step.objectType && step.objectId) {
    return await ctx.objectStore.executeAction(
      step.objectType,
      interpolate(step.objectId, ctx.variables),
      action,
      params,
      ctx,
    );
  }

  // mes_production_dispatch → process-industry Pack via ActionRegistry（已迁移）

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
    if (!typeName || !id) {
      return { status: "error", reason: "type and id are required" };
    }
    const { type: _t, object_type: _ot, id: _id, object_id: _oid, ...fields } = params;
    const updated = await ctx.objectStore.update(typeName, id, fields);
    const { id: _updId, ...rest } = updated;
    return { status: "ok", id, ...rest };
  }

  // create_quote / create_bid_* / create_customer / create_product
  // → enterprise-commercial Pack via ActionRegistry（已迁移）

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
          ctx.traceparent ?? ctx.triggerEvent?.traceparent,
        );
      }
    }
    const { id: createdId, ...createdRest } = created;
    return { status: "ok", id: createdId, ...createdRest };
  }

  if (action.startsWith("create_")) {
    const typeName = String(params.type ?? params.object_type ?? "WorkOrder");
    const created = await ctx.objectStore.create(typeName, params, ctx);
    const { id: createdId2, ...createdRest2 } = created;
    return { status: "ok", id: createdId2, ...createdRest2 };
  }

  // ── update / resolve 动作：patch ObjectStore 对象 + 可选发布后续事件 ──
  // update_task_status → enterprise-foundation Pack via ActionRegistry（已迁移）

  // resolve_approval → enterprise-foundation Pack via ActionRegistry（已迁移）

  // resolve_incident → enterprise-foundation Pack via ActionRegistry（已迁移）

  // update_robot_owner → enterprise-foundation Pack via ActionRegistry（已迁移）

  // query_overdue_tasks / query_user_tasks / query_daily_stats → enterprise-foundation Pack via ActionRegistry（已迁移）

  // search_kb / ingest_kb_text / ingest_folder → base Pack via ActionRegistry（已迁移）
  // Fallback: handle core KB actions inline when no ActionRegistry registration exists
  if (action === "search_kb") {
    const query = String(params.query ?? "");
    const limit = typeof params.limit === "number" ? params.limit : 5;
    const namespace = typeof params.namespace === "string" ? params.namespace : undefined;
    const results = await ctx.kb.search(query, { limit, namespace });
    return { results, count: results.length };
  }
  if (action === "ingest_kb_text" || action === "ingest_kb") {
    const text = String(params.text ?? params.content ?? "");
    const namespace = typeof params.namespace === "string" ? params.namespace : undefined;
    await ctx.kb.ingest(text, { namespace });
    return { ingested: true };
  }
  if (action === "ingest_document") {
    if (!isDocumentKnowledgeBase(ctx.kb)) {
      return { status: "error", reason: "ingest_document requires DocumentKnowledgeBase" };
    }
    const doc = await ctx.kb.ingestDocument({
      text: String(params.text ?? params.content ?? ""),
      source: typeof params.source === "string" ? params.source : undefined,
      namespace: typeof params.namespace === "string" ? params.namespace : undefined,
      title: typeof params.title === "string" ? params.title : undefined,
      auto_publish: params.auto_publish === true,
    });
    return { document_id: doc.id, document: doc };
  }
  if (action === "lint_document") {
    if (!isDocumentKnowledgeBase(ctx.kb)) {
      return { ok: false, reason: "lint_document requires DocumentKnowledgeBase" };
    }
    const id = String(params.document_id ?? params.id ?? "");
    if (!id) {
      return { ok: false, reason: "document_id required" };
    }
    const result = ctx.kb.lintDocument(id);
    return result;
  }

  // score_work_item / compute_performance_summary / create_scoring_rule / update_scoring_rule → enterprise-performance Pack via ActionRegistry（已迁移）

  // record_daily_report_run / update_daily_report_status → daily-report Pack via ActionRegistry（已迁移）

  // query_objects_time_range / aggregate_objects / export_to_bi → enterprise-analytics Pack via ActionRegistry（已迁移）

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
  // 未知 fn：记录警告并以 stub 形式透传，避免 Playbook 静默失败无任何提示
  deps.logger?.(`[claworks:atomic] unknown fn="${fn}" — step returned stub output`);
  return { fn, params, _stub: true, _warning: `atomic fn "${fn}" is not implemented` };
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

/** 解析 Jinja 表达式中的字面量值（用于过滤器管道中的 default 参数和 get() 默认值）。 */
function parseLiteralExpr(expr: string): unknown {
  const s = expr.trim();
  if (s === "null" || s === "None") {
    return null;
  }
  if (s === "[]") {
    return [];
  }
  if (s === "{}") {
    return {};
  }
  if (s === "true" || s === "True") {
    return true;
  }
  if (s === "false" || s === "False") {
    return false;
  }
  const strMatch = s.match(/^(['"])(.*)\1$/s);
  if (strMatch) {
    return strMatch[2];
  }
  const n = Number(s);
  if (!Number.isNaN(n) && s !== "") {
    return n;
  }
  return undefined;
}

export function interpolate(template: string, vars: Record<string, unknown>): string {
  const payload = (vars.payload ?? vars) as Record<string, unknown>;
  const steps = (vars.steps ?? {}) as Record<
    string,
    { status?: string; result?: Record<string, unknown> }
  >;

  // Expand Jinja-style for loops before other replacements
  const expanded = expandJinjaForLoops(template, vars);

  // ── Jinja2 过滤器管道处理 ─────────────────────────────────────────────────
  // 将 {{ expr | filter1 | filter2(...) }} 模式展开后应用过滤器
  const applyFilters = (value: unknown, filterStr: string): string => {
    let result: unknown = value;
    // 拆分过滤器链：按 | 分隔（但不在括号内）
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
          if (result == null || result === "" || result === false) {
            result = dflt;
          }
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
          result = Number.parseInt(String(result ?? "0"), 10) || 0;
          break;
        case "float":
          result = Number.parseFloat(String(result ?? "0")) || 0;
          break;
        case "string":
          result = String(result ?? "");
          break;
        case "replace": {
          const parts = argStr?.match(/['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/);
          if (parts) {
            result = String(result ?? "")
              .split(parts[1])
              .join(parts[2]);
          }
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
          result = Array.isArray(result)
            ? result[result.length - 1]
            : String(result ?? "").slice(-1);
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
          result =
            String(result ?? "")
              .charAt(0)
              .toUpperCase() + String(result ?? "").slice(1);
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
          result = Array.isArray(result) ? [...result].toSorted() : result;
          break;
        case "reverse":
          result = Array.isArray(result)
            ? [...result].toReversed()
            : String(result ?? "")
                .split("")
                .toReversed()
                .join("");
          break;
        // 忽略未知过滤器，保持原值
        default:
          break;
      }
    }
    return typeof result === "object" ? JSON.stringify(result) : String(result ?? "");
  };

  // 替换含过滤器管道的 {{ expr | filter... }} 表达式
  const withFilters = expanded.replace(
    /\{\{\s*([^{}|]+?)\s*\|\s*([^{}]+?)\s*\}\}/g,
    (match, exprPart, filtersPart) => {
      // 先解析 exprPart 的基础值
      const trimmedExpr = exprPart.trim();
      // 先做简单的变量查找
      let baseValue: unknown = undefined;
      // 支持 a.b 路径访问
      const pathMatch = trimmedExpr.match(/^([\w.]+)$/);
      if (pathMatch) {
        const parts = pathMatch[1].split(".");
        let cur: unknown = vars;
        for (const part of parts) {
          if (cur && typeof cur === "object") {
            cur = (cur as Record<string, unknown>)[part];
          } else {
            cur = undefined;
            break;
          }
        }
        baseValue = cur;
      }
      // payload.get('key') 支持
      const pgm = trimmedExpr.match(/^payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)$/);
      if (pgm) {
        baseValue = payload[pgm[1]];
      }

      // steps['x']['result'].get('field', default) 在过滤器管道中的支持
      if (baseValue === undefined) {
        const stepsGetMatch = trimmedExpr.match(
          /^steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*([^)]+))?\s*\)$/,
        );
        if (stepsGetMatch) {
          const [, stepId, field, defaultExprRaw] = stepsGetMatch;
          const stepResult = steps[stepId]?.result;
          const dflt = defaultExprRaw ? parseLiteralExpr(defaultExprRaw.trim()) : undefined;
          baseValue = stepResult != null ? (stepResult[field] ?? dflt) : dflt;
        }
      }

      // 字面量值支持：null / 'str' / "str" / [] / 数字
      if (baseValue === undefined) {
        if (trimmedExpr === "null") {
          baseValue = null;
        } else if (trimmedExpr === "[]") {
          baseValue = [];
        } else if (trimmedExpr === "{}") {
          baseValue = {};
        } else {
          const literalStr = trimmedExpr.match(/^(['"])(.*)\1$/s);
          if (literalStr) {
            baseValue = literalStr[2];
          } else if (
            trimmedExpr !== "" &&
            !trimmedExpr.includes(" ") &&
            !Number.isNaN(Number(trimmedExpr))
          ) {
            baseValue = Number(trimmedExpr);
          }
        }
      }

      if (baseValue === undefined) {
        // 对未知路径先做正常 interpolate 再应用过滤器
        const simpleInterp = match.replace(/\s*\|[^}]+$/, " }}");
        return applyFilters(simpleInterp, filtersPart);
      }
      return applyFilters(baseValue, filtersPart);
    },
  );

  let out = withFilters
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
    .replace(/\{\{\s*([\w]+(?:\.[\w]+)+)\s*\}\}/g, (_, path) => {
      // 处理任意深度路径：{{ a.b }}、{{ a.b.c }}、{{ event.payload.text }} 等
      const parts = (path as string).split(".");
      let cur: unknown = vars;
      for (const part of parts) {
        if (cur && typeof cur === "object" && !Array.isArray(cur)) {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          cur = undefined;
          break;
        }
      }
      return cur != null ? (typeof cur === "object" ? JSON.stringify(cur) : String(cur)) : "";
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

  // ── 内置全局函数调用：time.now()、uuid()、time.now_ms() ──────────────
  out = out
    .replace(/\{\{\s*time\.now\(\s*\)\s*\}\}/g, () => new Date().toISOString())
    .replace(/\{\{\s*time\.now_ms\(\s*\)\s*\}\}/g, () => String(Date.now()))
    .replace(/\{\{\s*uuid\(\s*\)\s*\}\}/g, () => randomUUID());

  return out;
}
