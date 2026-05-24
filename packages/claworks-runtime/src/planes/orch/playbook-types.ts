import type { EventTrigger } from "../../kernel/types.js";

export type StepFailurePolicy = "abort" | "continue";

export type StepHitlConfig = {
  requiredIf?: string;
  autoApproveIf?: string;
  timeoutHours?: number;
};

export type StepMeta = {
  condition?: string;
  onFailure?: StepFailurePolicy;
  hitl?: StepHitlConfig;
};

export type PlaybookStep =
  | NotificationStep
  | AtomicStep
  | LlmStep
  | HitlStep
  | ConditionStep
  | ActionStep
  | FunctionStep
  | ConnectorStep
  | SubPlaybookStep
  | CallPlaybookStep
  | A2aDelegateStep
  | SubagentStep
  | SkillStep
  | ScriptStep
  | MemoryReadStep
  | MemoryWriteStep
  | PublishEventStep
  | ParallelStep;

export type PublishEventFn = (
  type: string,
  source: string,
  payload: Record<string, unknown>,
  correlationId?: string,
) => Promise<void>;

export interface NotificationStep extends StepMeta {
  kind: "notification";
  id: string;
  message: string;
  channels?: string[];
}

export interface AtomicStep extends StepMeta {
  kind: "atomic";
  id: string;
  fn: string;
  params: Record<string, unknown>;
  output?: string;
}

export interface ActionStep extends StepMeta {
  kind: "action";
  id: string;
  actionApiName: string;
  params: Record<string, unknown>;
  objectType?: string;
  objectId?: string;
  output?: string;
}

export interface FunctionStep extends StepMeta {
  kind: "function";
  id: string;
  functionApiName: string;
  params: Record<string, unknown>;
  output?: string;
}

export interface ConnectorStep extends StepMeta {
  kind: "connector";
  id: string;
  connectorId: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface SubPlaybookStep extends StepMeta {
  kind: "playbook";
  id: string;
  playbookId: string;
  input?: Record<string, unknown>;
}

/**
 * call_playbook — 同步调用子 Playbook，等待完成并获取输出。
 * 与 kind: "playbook" 不同，此步骤支持模板化 playbook_id、param 插值，
 * 并可通过 store_result_as 将子流程输出写入当前上下文变量。
 */
export interface CallPlaybookStep extends StepMeta {
  kind: "call_playbook";
  id: string;
  /** 子 Playbook ID，支持模板字符串 e.g. "{{ intent }}_handler" */
  playbookId: string;
  /** 传入子 Playbook 的参数（支持模板插值） */
  params?: Record<string, unknown>;
  /** 将子 Playbook 的 output 写入此变量名 */
  storeResultAs?: string;
  /** 超时秒数，默认 60 */
  timeoutSeconds?: number;
}

export interface A2aDelegateStep extends StepMeta {
  kind: "a2a_delegate";
  id: string;
  target: string;
  task: string;
  waitResult?: boolean;
  output?: string;
}

export interface SubagentStep extends StepMeta {
  kind: "subagent";
  id: string;
  prompt: string;
  model?: string;
  output?: string;
}

/**
 * SkillStep — 调用 OpenClaw ClawHub Skill（AI 推理能力，通过 runEmbeddedAgent）。
 * Playbook YAML：kind: skill
 */
export interface SkillStep extends StepMeta {
  kind: "skill";
  id: string;
  skillId: string;
  input?: Record<string, unknown>;
  output?: string;
}

/**
 * ScriptStep — 调用 ClaWorks 内置脚本（纯代码，不依赖 LLM）。
 * Playbook YAML：kind: script
 * 对应 ScriptLibrary.invoke()，IDs 如 kb.quick_search / alarm.classify_severity 等。
 */
export interface ScriptStep extends StepMeta {
  kind: "script";
  id: string;
  /** 脚本 ID，对应 ScriptLibrary 中注册的 id */
  scriptId: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface LlmStep extends StepMeta {
  kind: "llm";
  id: string;
  prompt: string;
  model?: string;
  output: string;
  /**
   * 结构化输出 schema（可选）。
   * 指定后 LLM 步骤会使用 StructuredOutputEngine 保证输出格式，
   * 解析失败自动重试（最多 3 次），最终输出写入 output 变量。
   * 格式同 StructuredOutputEngine.OutputSchema。
   */
  output_schema?: import("../../kernel/structured-output.js").OutputSchema;
  /**
   * Self-Consistency 投票（与 output_schema 配合使用）。
   * 多次采样并对指定字段投票，提升分类/决策准确率。
   * 典型用途：报警严重度分类、意图分类等高置信场景。
   */
  output_voting?: {
    /** 投票字段名（schema 中的某个枚举字段） */
    field: string;
    /** 采样次数（默认 3） */
    votes?: number;
  };
}

export interface HitlStep extends StepMeta {
  kind: "hitl";
  id: string;
  message: string;
  channel?: string;
  options: string[];
  output: string;
  /**
   * 超时秒数。到期后若仍未决策，自动以 on_timeout 决策值继续 Playbook。
   * 未指定时不自动超时（无限等待）。
   */
  timeout_seconds?: number;
  /**
   * 超时自动降级决策值，须是 options 中的一项。
   * 默认取 options[0]（通常为 "approve"）。
   * 设为 "abort" 可让超时后 Playbook 终止并发告警通知。
   */
  on_timeout?: string;
}

export interface ConditionStep extends StepMeta {
  kind: "condition";
  id: string;
  if: string;
  then: PlaybookStep[];
  else?: PlaybookStep[];
}

/**
 * memory_read — 从 ObjectStore RobotMemory 中读取记忆键值，结果写入 output 变量。
 * 若 key 不存在，output.found=false，output.value=undefined。
 */
export interface MemoryReadStep extends StepMeta {
  kind: "memory_read";
  id: string;
  /** RobotMemory 主体（设备 ID / global） */
  subject: string;
  /** 记忆键 */
  key: string;
  /** 输出变量名（写入 ctx.variables） */
  output: string;
}

/**
 * memory_write — 向 ObjectStore RobotMemory 写入键值（创建或更新）。
 * 支持置信度和来源字段，用于后续 Playbook 条件判断。
 */
export interface MemoryWriteStep extends StepMeta {
  kind: "memory_write";
  id: string;
  subject: string;
  key: string;
  value: string | number | boolean;
  category?: string;
  confidence?: number;
  source?: string;
  /** 可选：写入后将结果写入 output 变量 */
  output?: string;
}

/**
 * parallel — 并行执行多个分支（branch 是 PlaybookStep 数组），
 * 支持超时、失败策略和结果合并。
 */
export interface ParallelStep extends StepMeta {
  kind: "parallel";
  id: string;
  /** 并行分支列表，每个分支是一个步骤序列 */
  branches: PlaybookStep[][];
  /** 合并策略：all（等待所有）| first_success（取第一个成功的） */
  merge_strategy?: "all" | "first_success";
  /** 超时秒数，默认 30 */
  timeout_seconds?: number;
  /** 将分支结果写入 ctx.variables 的变量名 */
  store_result_as?: string;
  /** 某分支失败时的处理策略：continue（继续其他分支）| abort_all（中止全部） */
  on_branch_failure?: "continue" | "abort_all";
}

/**
 * publish_event — 在 Playbook 内部直接发布一个新的业务事件到 EventKernel。
 * 用于意图路由：IM bridge classify → 发布具体业务事件（alarm.created / workorder.query 等）。
 */
export interface PublishEventStep extends StepMeta {
  kind: "publish_event";
  id: string;
  /** 要发布的事件类型 */
  eventType: string;
  /** 事件来源（默认 playbook:<playbookId>） */
  source?: string;
  /** 事件 payload（支持模板插值） */
  payload?: Record<string, unknown>;
  /** 可选：将 matched playbooks 列表写入 output 变量 */
  output?: string;
}

export interface PlaybookDefinition {
  id: string;
  name: string;
  description?: string;
  pack: string;
  version?: string;
  trigger: EventTrigger;
  priority: number;
  /** Playbook 全局超时（秒），超时后 run 强制标记 failed，默认 300s（5 分钟） */
  timeout_seconds?: number;
  /**
   * 触发此 Playbook 所需的最低用户角色（可选）。
   * 角色等级：viewer < operator < admin。
   * 触发时若 input.user_role 低于此值，立即拒绝并返回 failed 状态。
   * 未配置时不做角色检查，所有触发均允许。
   */
  required_role?: "viewer" | "operator" | "admin";
  steps: PlaybookStep[];
}

export interface PlaybookStepContext {
  runId: string;
  playbookId: string;
  triggerEvent?: import("../../kernel/types.js").CwEvent;
  variables: Record<string, unknown>;
  objectStore: import("../data/object-store.js").ObjectStore;
  kb: import("../../kernel/types.js").KnowledgeBase;
  robot: import("../../kernel/types.js").RobotInfo;
  publishEvent?: PublishEventFn;
  ontology?: import("../data/ontology-engine.js").OntologyEngine;
  reloadPacks?: () => Promise<Record<string, unknown>>;
  a2aPeers?: import("../../claworks/a2a-peers.js").A2aPeerConfig[];
  /**
   * 调用外部连接器（供 Pack ActionHandler 使用）。
   * 例：ctx.connectorInvoke?.("bi-tableau", "push", { records: [...] })
   */
  connectorInvoke?: (
    connectorId: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<void>;
  /** 运行时日志输出 */
  logger?: (msg: string) => void;
}

export interface StepLog {
  stepId: string;
  status: "running" | "completed" | "failed" | "skipped" | "waiting";
  startedAt: Date;
  completedAt?: Date;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface PlaybookRun {
  id: string;
  playbookId: string;
  status: "running" | "waiting_hitl" | "completed" | "failed" | "cancelled";
  startedAt: Date;
  completedAt?: Date;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  steps: StepLog[];
}
