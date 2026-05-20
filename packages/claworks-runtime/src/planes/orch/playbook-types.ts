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
  | A2aDelegateStep
  | SubagentStep
  | SkillStep
  | MemoryReadStep
  | MemoryWriteStep
  | PublishEventStep;

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

export interface SkillStep extends StepMeta {
  kind: "skill";
  id: string;
  skillId: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface LlmStep extends StepMeta {
  kind: "llm";
  id: string;
  prompt: string;
  model?: string;
  output: string;
}

export interface HitlStep extends StepMeta {
  kind: "hitl";
  id: string;
  message: string;
  channel?: string;
  options: string[];
  output: string;
  timeout_seconds?: number;
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
