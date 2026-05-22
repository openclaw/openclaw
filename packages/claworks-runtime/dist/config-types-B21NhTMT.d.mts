//#region src/interfaces/connectors/types.d.ts
/** NDJSON stdio protocol between ClaWorks and connector child processes. */
type ConnectorOutboundMessage = {
  type: "invoke";
  id: string;
  method: string;
  params?: Record<string, unknown>;
} | {
  type: "shutdown";
};
type ConnectorInboundMessage = {
  type: "ready";
  connectorId?: string;
} | {
  type: "log";
  level?: string;
  message: string;
} | {
  type: "event";
  event_type: string;
  source: string;
  payload: Record<string, unknown>;
  correlation_id?: string;
} | {
  type: "result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};
type ConnectorAutoStart = boolean | {
  method?: string;
  params?: Record<string, unknown>;
};
type ConnectorConfig = {
  enabled?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  auto_start?: ConnectorAutoStart;
};
type ConnectorStatus = {
  id: string;
  running: boolean;
  pid?: number;
  ready: boolean;
  lastError?: string;
};
//#endregion
//#region src/interfaces/connectors/presets.d.ts
type ConnectorConfigInput = Omit<ConnectorConfig, "command"> & {
  /** Built-in connector id: echo | rest-poll | mqtt | opcua | modbus */preset?: string; /** 连接器命令（当 preset 存在时可省略，由 preset resolver 填充） */
  command?: string; /** 特定连接器所需的应用 ID（如飞书 App ID） */
  app_id?: string; /** 任意扩展配置（供自定义连接器使用） */
  [key: string]: unknown;
};
declare function resolveConnectorConfigs(connectors: Record<string, ConnectorConfigInput> | undefined, claworksRoot?: string): Record<string, ConnectorConfig>;
//#endregion
//#region src/kernel/types.d.ts
/** ClaWorks kernel shared types. */
interface CwEvent {
  id: string;
  type: string;
  source: string;
  timestamp: Date;
  payload: Record<string, unknown>;
  correlationId?: string;
  /** 触发主体标识（REST apikey hash、A2A peer name、channel user id、system） */
  subjectId?: string;
  /** 触发主体类型 */
  subjectType?: "agent" | "peer" | "apikey" | "channel_user" | "system";
  /** 幂等键（防重放） */
  idempotencyKey?: string;
}
interface CwEventMatch {
  event: CwEvent;
  playbookId: string;
  priority: number;
  input: Record<string, unknown>;
}
interface EventQueryOptions {
  type?: string;
  source?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}
type EventTrigger = {
  kind: "event";
  pattern: string;
  filter?: Record<string, unknown>;
  condition?: string;
} | {
  kind: "schedule";
  cron: string;
  timezone?: string;
} | {
  kind: "manual";
};
interface RobotInfo {
  name: string;
  role: "monolith" | "twin" | "ops" | "nexus";
  version: string;
  endpoint: string;
}
interface KbResult {
  id: string;
  score: number;
  /** 主要文本字段 */
  text: string;
  /** text 的别名（向后兼容旧代码中使用 .content 的地方） */
  content?: string;
  /** 文档标题（可选） */
  title?: string;
  source?: string;
  namespace?: string;
  /** 文档 ID（向量知识库中的父文档） */
  document_id?: string;
  /** 文档分块 ID */
  chunk_id?: string;
  /** 分层标识 */
  layer?: string;
  /** 引用信息（段落/节标题） */
  citation?: string;
  /** 文档版本 */
  revision?: number;
  /** 任意扩展元数据 */
  metadata?: Record<string, unknown>;
}
/** 写入知识库时的选项 */
interface KbIngestOptions {
  namespace?: string;
  source?: string;
  title?: string;
  tags?: string[];
  document_id?: string;
  chunk_id?: string;
  /** 知识库分层标识（如 "system", "domain", "enterprise"） */
  layer?: string;
  /** 任意扩展选项 */
  [key: string]: unknown;
}
interface KnowledgeBase {
  /** 语义搜索（兼容旧代码中调用 .search 的地方） */
  search(query: string, opts?: {
    limit?: number;
    namespace?: string;
    layer?: string;
  }): Promise<KbResult[]>;
  /** 语义搜索（和 search 等价，供需要显式区分的调用方使用） */
  semanticSearch?(query: string, opts?: {
    limit?: number;
    namespace?: string;
  }): Promise<KbResult[]>;
  /** 向知识库写入文本 */
  ingest(text: string, opts?: KbIngestOptions): Promise<void>;
  /** 添加结构化文档（add 是 ingest 的别名，兼容旧接口） */
  add?(doc: {
    id?: string;
    content: string;
    title?: string;
    source?: string;
    namespace?: string;
    tags?: string[];
  }): Promise<string>;
  /** 按 id 删除文档 */
  remove?(id: string): Promise<void>;
  /** 统计文档总数 */
  count?(): Promise<number>;
  /**
   * 将缓冲区内容刷写到持久化存储（对 memory-core 等内存 KB 有意义）。
   * 若 KB 不支持 flush 则为 no-op。
   */
  flush?(): Promise<void>;
  /** KB 提供者标识（如 "bm25-memory", "memory-core", "file"） */
  provider?: string;
  /** 是否支持向量 embedding（语义搜索） */
  supportsEmbedding?: boolean;
  describe?(): Promise<KbStatus>;
}
interface KbStatus {
  provider: "bm25-memory" | "file" | "memory-core" | string;
  vector: boolean;
  kb_path?: string;
  kb_embed_model?: string;
  kb_drop_dir?: string;
  memory_slot?: string;
  document_count?: number;
  note?: string;
}
//#endregion
//#region src/planes/data/ontology-types.d.ts
interface FieldDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "enum" | "ref";
  required?: boolean;
  enumValues?: string[];
  refType?: string;
  default?: unknown;
}
interface ActionTypeDefinition {
  name: string;
  description?: string;
  params: FieldDefinition[];
  fsmTransition?: {
    from: string | string[];
    to: string;
  };
}
interface FsmDefinition {
  field: string;
  initial: string;
  states: string[];
  transitions: Array<{
    from: string | string[];
    event: string;
    to: string;
  }>;
}
interface ObjectTypeDefinition {
  name: string;
  description?: string;
  pack: string;
  primaryKey: string;
  fields: FieldDefinition[];
  actions: ActionTypeDefinition[];
  fsm?: FsmDefinition;
}
interface ValidationResult$1 {
  valid: boolean;
  errors: Array<{
    field: string;
    message: string;
  }>;
}
//#endregion
//#region src/planes/data/db-types.d.ts
/**
 * SQLite-compatible sync database surface used by ClaWorks planes (ObjectStore, PlaybookEngine, Outbox).
 */
type CwPreparedStatement = {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};
type CwDatabase = {
  exec(sql: string): void;
  prepare(sql: string): CwPreparedStatement;
  close(): void;
};
//#endregion
//#region src/planes/data/db.d.ts
declare function openDatabase(databaseUrl: string): {
  db: CwDatabase;
  close: () => void;
};
//#endregion
//#region src/planes/data/object-store.d.ts
interface CwObject {
  id: string;
  _type: string;
  _version: number;
  _createdAt: Date;
  _updatedAt: Date;
  [field: string]: unknown;
}
interface ObjectQueryOptions {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: {
    field: string;
    dir: "asc" | "desc";
  };
  /** 时序过滤：按对象的某个 ISO-8601 字符串字段（或 _createdAt）过滤时间范围 */
  time_range?: {
    /** 要过滤的字段名，默认 "_createdAt" */field?: string; /** ISO-8601 起始（含），如 "2026-05-01T00:00:00Z" */
    from?: string; /** ISO-8601 截止（含），如 "2026-05-31T23:59:59Z" */
    to?: string;
  };
}
type AggregationPeriod = "hour" | "day" | "week" | "month";
type AggregationFn = "count" | "sum" | "avg" | "min" | "max";
interface TimeSeriesQueryOptions {
  /** 要聚合的时间字段，默认 "_createdAt" */
  time_field?: string;
  /** 时间范围（同 ObjectQueryOptions.time_range） */
  from?: string;
  to?: string;
  /** 分组粒度，默认 "day" */
  group_by_period?: AggregationPeriod;
  /** 聚合函数，默认 "count" */
  aggregate_fn?: AggregationFn;
  /** 当 aggregate_fn != "count" 时，指定要聚合的数字字段 */
  aggregate_field?: string;
  /** 额外的属性过滤（同 ObjectQueryOptions.filter） */
  filter?: Record<string, unknown>;
}
interface TimeSeriesBucket {
  /** 时间桶标签，如 "2026-05-01"（day）、"2026-05-01T08"（hour）、"2026-W20"（week）、"2026-05"（month） */
  period: string;
  value: number;
  count: number;
}
interface TimeSeriesResult {
  type_name: string;
  group_by_period: AggregationPeriod;
  aggregate_fn: AggregationFn;
  aggregate_field?: string;
  from?: string;
  to?: string;
  buckets: TimeSeriesBucket[];
  total_count: number;
  total_value: number;
}
interface ObjectStore {
  query(typeName: string, opts?: ObjectQueryOptions): Promise<{
    items: CwObject[];
    nextCursor?: string;
  }>;
  get(typeName: string, id: string): Promise<CwObject | null>;
  create(typeName: string, data: Record<string, unknown>, ctx?: PlaybookStepContext): Promise<CwObject>;
  update(typeName: string, id: string, patch: Record<string, unknown>): Promise<CwObject>;
  /** 创建或更新（按 id）：存在则 patch，不存在则 create。 */
  upsert(typeName: string, id: string, data: Record<string, unknown>): Promise<CwObject>;
  delete(typeName: string, id: string): Promise<void>;
  executeAction(typeName: string, id: string, actionType: string, params: Record<string, unknown>, ctx: PlaybookStepContext): Promise<Record<string, unknown>>;
  /**
   * 时序聚合查询：按时间字段将对象分桶并聚合数值。
   * 适用于跨期趋势分析（日/周/月报对比、绩效曲线等）。
   */
  queryTimeSeries(typeName: string, opts?: TimeSeriesQueryOptions): Promise<TimeSeriesResult>;
}
type ObjectStoreOptions = {
  validate?: (typeName: string, data: Record<string, unknown>) => ValidationResult$1; /** Validate FSM transition (action, currentState) → allowed + nextState. */
  validateFsmTransition?: (typeName: string, action: string, currentState: string) => {
    allowed: boolean;
    nextState?: string;
    reason?: string;
  }; /** Called after create/update/upsert when type is a policy object (e.g. RbacPolicy). */
  onPolicyWrite?: (typeName: string) => void;
};
declare function createObjectStore(db: CwDatabase, opts?: ObjectStoreOptions): ObjectStore;
//#endregion
//#region src/planes/data/ontology-engine.d.ts
interface OntologyEngine {
  loadFromPacks(packs: LoadedPack[]): Promise<void>;
  reloadPack(packId: string, pack: LoadedPack): Promise<void>;
  getType(name: string): ObjectTypeDefinition | null;
  listTypes(): ObjectTypeDefinition[];
  validate(typeName: string, data: Record<string, unknown>): ValidationResult$1;
}
declare function createOntologyEngine(): OntologyEngine;
//#endregion
//#region src/claworks/a2a-peers.d.ts
type A2aPeerConfig = {
  name: string; /** 对端基础 URL（url 的别名，两者等价） */
  url: string; /** 对端端点（与 url 等价，供旧代码使用 .endpoint 的地方） */
  endpoint?: string;
};
/** Resolve playbook ``target`` (URL or configured peer name) to an A2A base URL. */
declare function resolveA2aTarget(target: string, peers?: A2aPeerConfig[]): string;
declare function listA2aPeerNames(peers?: A2aPeerConfig[]): string[];
//#endregion
//#region src/planes/orch/playbook-types.d.ts
type StepFailurePolicy = "abort" | "continue";
type StepHitlConfig = {
  requiredIf?: string;
  autoApproveIf?: string;
  timeoutHours?: number;
};
type StepMeta = {
  condition?: string;
  onFailure?: StepFailurePolicy;
  hitl?: StepHitlConfig;
};
type PlaybookStep = NotificationStep | AtomicStep | LlmStep | HitlStep | ConditionStep | ActionStep | FunctionStep | ConnectorStep | SubPlaybookStep | A2aDelegateStep | SubagentStep | SkillStep | MemoryReadStep | MemoryWriteStep | PublishEventStep | ParallelStep;
type PublishEventFn = (type: string, source: string, payload: Record<string, unknown>, correlationId?: string) => Promise<void>;
interface NotificationStep extends StepMeta {
  kind: "notification";
  id: string;
  message: string;
  channels?: string[];
}
interface AtomicStep extends StepMeta {
  kind: "atomic";
  id: string;
  fn: string;
  params: Record<string, unknown>;
  output?: string;
}
interface ActionStep extends StepMeta {
  kind: "action";
  id: string;
  actionApiName: string;
  params: Record<string, unknown>;
  objectType?: string;
  objectId?: string;
  output?: string;
}
interface FunctionStep extends StepMeta {
  kind: "function";
  id: string;
  functionApiName: string;
  params: Record<string, unknown>;
  output?: string;
}
interface ConnectorStep extends StepMeta {
  kind: "connector";
  id: string;
  connectorId: string;
  method: string;
  params?: Record<string, unknown>;
}
interface SubPlaybookStep extends StepMeta {
  kind: "playbook";
  id: string;
  playbookId: string;
  input?: Record<string, unknown>;
}
interface A2aDelegateStep extends StepMeta {
  kind: "a2a_delegate";
  id: string;
  target: string;
  task: string;
  waitResult?: boolean;
  output?: string;
}
interface SubagentStep extends StepMeta {
  kind: "subagent";
  id: string;
  prompt: string;
  model?: string;
  output?: string;
}
interface SkillStep extends StepMeta {
  kind: "skill";
  id: string;
  skillId: string;
  input?: Record<string, unknown>;
  output?: string;
}
interface LlmStep extends StepMeta {
  kind: "llm";
  id: string;
  prompt: string;
  model?: string;
  output: string;
}
interface HitlStep extends StepMeta {
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
interface ConditionStep extends StepMeta {
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
interface MemoryReadStep extends StepMeta {
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
interface MemoryWriteStep extends StepMeta {
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
interface ParallelStep extends StepMeta {
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
interface PublishEventStep extends StepMeta {
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
interface PlaybookDefinition {
  id: string;
  name: string;
  description?: string;
  pack: string;
  version?: string;
  trigger: EventTrigger;
  priority: number;
  steps: PlaybookStep[];
}
interface PlaybookStepContext {
  runId: string;
  playbookId: string;
  triggerEvent?: CwEvent;
  variables: Record<string, unknown>;
  objectStore: ObjectStore;
  kb: KnowledgeBase;
  robot: RobotInfo;
  publishEvent?: PublishEventFn;
  ontology?: OntologyEngine;
  reloadPacks?: () => Promise<Record<string, unknown>>;
  a2aPeers?: A2aPeerConfig[];
  /**
   * 调用外部连接器（供 Pack ActionHandler 使用）。
   * 例：ctx.connectorInvoke?.("bi-tableau", "push", { records: [...] })
   */
  connectorInvoke?: (connectorId: string, method: string, params?: Record<string, unknown>) => Promise<void>;
  /** 运行时日志输出 */
  logger?: (msg: string) => void;
}
interface StepLog {
  stepId: string;
  status: "running" | "completed" | "failed" | "skipped" | "waiting";
  startedAt: Date;
  completedAt?: Date;
  input: unknown;
  output?: unknown;
  error?: string;
}
interface PlaybookRun {
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
//#endregion
//#region src/agents/research-agent.d.ts
type ResearchFinding = {
  source: string;
  content: string;
  relevance: number;
  url?: string;
};
type ResearchResult = {
  task_id: string;
  query: string;
  findings: ResearchFinding[];
  synthesis: string;
  confidence: number;
  duration_ms: number;
};
type ResearchSource = "kb" | "web" | "events";
interface ResearchAgent {
  research(opts: {
    id?: string;
    query: string;
    sources?: ResearchSource[];
    depth?: "quick" | "thorough";
    save_to_kb?: boolean;
  }): Promise<ResearchResult>;
  monitor(topic: string, intervalHours?: number): Promise<string>;
  stopMonitor(monitorId: string): void;
  getResult(taskId: string): ResearchResult | undefined;
}
//#endregion
//#region src/interfaces/connectors/connector-manager.d.ts
type ConnectorEventHandler = (event: {
  connectorId: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}) => void | Promise<void>;
declare class ConnectorManager {
  private readonly connectors;
  private readonly pendingInvokes;
  private onEvent?;
  private readonly logger?;
  constructor(opts?: {
    onEvent?: ConnectorEventHandler;
    logger?: (msg: string) => void;
  });
  setEventHandler(handler: ConnectorEventHandler | undefined): void;
  start(connectorId: string, config: ConnectorConfig): Promise<void>;
  stop(connectorId: string): Promise<void>;
  stopAll(): Promise<void>;
  invoke(connectorId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  list(): ConnectorStatus[];
  private send;
  private handleLine;
  /**
   * 返回所有连接器的状态快照（供能力/UI 查询）。
   * ready: 进程已就绪; error: 进程出错或已退出; idle: 尚未启动
   */
  status(): Array<{
    id: string;
    ready: boolean;
    lastError?: string;
  }>;
}
//#endregion
//#region src/kernel/action-registry.d.ts
/** Playbook action 处理器签名 */
type ActionHandler = (params: Record<string, unknown>, ctx: PlaybookStepContext) => Promise<Record<string, unknown>>;
interface ActionRegistration {
  /** action API 名（与 Playbook YAML 中的 action_api_name 一致） */
  apiName: string;
  handler: ActionHandler;
  /** 注册来源 Pack ID */
  packId: string;
  /** 人类可读描述（用于 /v1/actions 列表端点） */
  description?: string;
}
interface ActionRegistry {
  /** 注册一个 action 处理器。同名后注册覆盖先注册（Pack 层叠机制）。 */
  register(registration: ActionRegistration): void;
  /** 批量注册（Pack entry 常用） */
  registerAll(packId: string, handlers: Record<string, ActionHandler>): void;
  /** 查找处理器。找不到返回 undefined。 */
  get(apiName: string): ActionRegistration | undefined;
  /** 是否已注册 */
  has(apiName: string): boolean;
  /** 列出所有注册的 action（用于文档/UI） */
  list(): ActionRegistration[];
  /** 删除指定 Pack 注册的所有 action（Pack 卸载时调用） */
  unregisterPack(packId: string): void;
  /** 清空所有注册（热重载前调用） */
  clear(): void;
}
declare function createActionRegistry(): ActionRegistry;
//#endregion
//#region src/kernel/bridge-registry.d.ts
/**
 * BridgeRegistry — 外部接口桥接注册表
 *
 * 替代 PlaybookEngineDeps 里平铺的函数指针 (llmComplete, notify, subagentRun...)
 * 与 OpenClaw PluginRegistry 中各类 Registration 数组同构：
 *   插件通过 registry.registerXxx() 注入实现；核心代码只调 registry.getBridge("llm")。
 *
 * 设计原则：
 *   - 核心代码对任何外部实现都是可选+可替换的（测试/生产/stub）
 *   - 每类桥接有唯一 well-known key，防止拼写错误
 *   - 桥接本身是版本化的接口，添加新方法时核心不感知
 */
declare const BRIDGE_LLM: "llm";
declare const BRIDGE_NOTIFY: "notify";
declare const BRIDGE_SUBAGENT: "subagent";
declare const BRIDGE_SKILL: "skill";
type LlmBridge = {
  complete(params: {
    prompt: string;
    model?: string;
  }): Promise<{
    text: string;
  }>;
};
type NotifyBridge = {
  send(params: {
    message: string;
    channels?: string[]; /** 渠道原生富格式卡片 map（key=渠道ID, value=原生卡片 JSON） */
    cards?: Record<string, unknown>;
  }): Promise<void>;
};
type SubagentBridge = {
  run(params: {
    prompt: string;
    model?: string;
  }): Promise<{
    text: string;
  }>;
};
type SkillBridge = {
  run(params: {
    skillId: string;
    input?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
};
type BridgeTypeMap = {
  [BRIDGE_LLM]: LlmBridge;
  [BRIDGE_NOTIFY]: NotifyBridge;
  [BRIDGE_SUBAGENT]: SubagentBridge;
  [BRIDGE_SKILL]: SkillBridge;
};
type BridgeRegistry = {
  register<K extends keyof BridgeTypeMap>(key: K, impl: BridgeTypeMap[K]): void;
  get<K extends keyof BridgeTypeMap>(key: K): BridgeTypeMap[K] | undefined;
  has(key: string): boolean;
};
//#endregion
//#region src/kernel/capability-registry.d.ts
/** 通用能力处理函数 */
type CapabilityHandler = (ctx: CapabilityContext, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** 动词分类（用于分析、路由、遥测） */
type CapabilityVerb = "query" | "acquire" | "retrieve" | "transform" | "compose" | "deliver" | "observe" | "control" | "modify" | "create" | "delete" | "execute";
/** 能力归属 */
type CapabilityOwner = {
  kind: "core";
} | {
  kind: "pack";
  packId: string;
} | {
  kind: "bridge";
  bridgeId: string;
};
/** RBAC 决策 */
type CapabilityRbacPolicy = {
  /** 允许的 subjectType 列表；省略表示不限 */allowedSubjects?: string[]; /** 默认决策 */
  decision: "allow" | "hitl_required" | "deny";
  reason?: string;
};
/** 能力描述符（与 GatewayMethodDescriptor 同构） */
type CapabilityDescriptor = {
  /** 唯一 ID，格式 "namespace.verb_noun"，如 "kb.search" */id: string;
  verb: CapabilityVerb;
  description: string;
  handler: CapabilityHandler; /** JSON Schema（用于自描述、参数校验、自动学习） */
  paramsSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  rbac?: CapabilityRbacPolicy;
  owner: CapabilityOwner; /** false = 不出现在 system.describe 列表中 */
  advertise?: boolean;
};
/** describe 时返回的精简视图 */
type CapabilityView = {
  id: string;
  verb: CapabilityVerb;
  description: string;
  paramsSchema?: Record<string, unknown>;
  owner: CapabilityOwner;
};
/** 能力执行上下文（注入到 handler，不泄漏整个 runtime） */
type CapabilityContext = {
  /** 调用来源（im / rest / playbook / scheduler / ...） */source: string; /** 主体标识 */
  subjectId?: string;
  subjectType?: string; /** 用户 ID（im 渠道等用户身份场景） */
  userId?: string; /** correlationId 用于跟踪链路 */
  correlationId?: string; /** Playbook step 上下文（从 Playbook 触发时注入） */
  stepCtx?: PlaybookStepContext; /** 向下调用其他能力（避免直接访问 registry） */
  invoke: (capabilityId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>; /** 日志 */
  logger?: (msg: string) => void;
};
/** 熔断器状态 */
type CircuitBreakerState = "closed" | "open" | "half-open";
type CircuitBreakerStatus = {
  capabilityId: string;
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureAt?: number;
  openUntil?: number;
};
type CapabilityRegistry = {
  /** 注册一个能力（重复 id 报错；pack 注册时 id 必须以 packId 开头） */register(descriptor: CapabilityDescriptor): void; /** 批量注册 */
  registerAll(descriptors: CapabilityDescriptor[]): void; /** 注销 Pack 的所有能力（Pack 卸载/重载时调用） */
  unregisterPack(packId: string): void; /** 查找 handler（找不到返回 undefined） */
  get(id: string): CapabilityDescriptor | undefined; /** 列出所有可广播的能力（用于 system.describe） */
  list(): CapabilityView[]; /** 列出所有 id（含隐藏） */
  listAll(): string[];
  /**
   * 经行为准则检查后调用能力。
   * - allow: 直接执行
   * - hitl_required: 抛出 CapabilityHitlRequired 错误（调用者负责发起 HITL 流程）
   * - deny: 抛出 CapabilityDenied 错误
   */
  invoke(id: string, ctx: CapabilityContext, params: Record<string, unknown>, opts?: {
    constitutionCheck?: {
      source?: string;
      userId?: string;
    };
  }): Promise<Record<string, unknown>>;
  /**
   * 注入行为准则（runtime.ts 在 constitution 创建后调用）。
   * 调用后所有 invoke() 均会经过 constitution.check()。
   */
  setConstitution(constitution: {
    check(id: string, opts?: {
      source?: string;
      userId?: string;
    }): {
      action: "allow" | "hitl_required" | "deny";
      tier: 0 | 1 | 2 | 3;
      reason: string;
    };
  }): void; /** 列出所有处于 open/half-open 状态的熔断器 */
  listCircuitBreakers(): CircuitBreakerStatus[]; /** 手动重置某个能力的熔断器（运维用途）*/
  resetCircuitBreaker(capabilityId: string): void;
};
//#endregion
//#region src/kernel/card-builder.d.ts
/**
 * card-builder.ts — ClaWorks 渠道无关卡片构建器
 *
 * 生成结构化的 CwCard 对象，各渠道适配器负责转换：
 *   - toFeishu()     → 飞书互动卡片 JSON (msg_type: "interactive")
 *   - toWeixinWork() → 企微 Markdown 格式卡片
 *   - toPlainText()  → 纯文本降级（无富文本渠道兜底）
 *
 * 内置业务卡片模板（5 个）：
 *   alarm / work_order / approval / report / health_status
 */
type CardColor = "red" | "orange" | "green" | "blue" | "grey" | "purple";
type CardElement = {
  type: "title";
  text: string;
  level?: 1 | 2 | 3;
} | {
  type: "text";
  text: string;
  bold?: boolean;
  color?: string;
} | {
  type: "field";
  label: string;
  value: string;
  inline?: boolean;
} | {
  type: "divider";
} | {
  type: "button";
  text: string;
  action: string;
  value?: string;
  style?: "primary" | "danger" | "default";
} | {
  type: "badge";
  text: string;
  color?: CardColor;
} | {
  type: "table";
  headers: string[];
  rows: string[][];
} | {
  type: "note";
  text: string;
} | {
  type: "image";
  url: string;
  alt?: string;
};
type CwCard = {
  /** 卡片模板 ID（alarm / work_order / approval / report / health_status / custom） */template: string;
  title: string;
  color?: CardColor;
  elements: CardElement[]; /** 底部操作按钮（仅 button 类型有效） */
  actions?: CardElement[];
  footer?: string;
};
interface CardBuilder {
  build(card: CwCard): CwCard;
  alarm(opts: {
    alarmId: string;
    equipmentId: string;
    severity: string;
    description: string;
    time?: string;
  }): CwCard;
  workOrder(opts: {
    id: string;
    title: string;
    status: string;
    assignee: string;
    priority: string;
    equipment?: string;
  }): CwCard;
  approval(opts: {
    id: string;
    title: string;
    applicant: string;
    status: string;
    description?: string;
  }): CwCard;
  report(opts: {
    title: string;
    period: string;
    metrics: Array<{
      label: string;
      value: string;
    }>;
  }): CwCard;
  healthStatus(opts: {
    overall: string;
    dimensions: Array<{
      name: string;
      status: string;
      note?: string;
    }>;
  }): CwCard;
  toFeishu(card: CwCard): Record<string, unknown>;
  toWeixinWork(card: CwCard): Record<string, unknown>;
  toPlainText(card: CwCard): string;
  /** 自动按渠道名选择格式：feishu→对象, weixin_work→对象, 其他→纯文本 */
  toAuto(card: CwCard, channel: string): unknown;
}
//#endregion
//#region src/kernel/context-engine.d.ts
/**
 * context-engine.ts — ClaWorks 对话上下文引擎
 *
 * 让机器人跨轮次记住对话上下文，实现真正的对话连续性。
 * 内存实现：每个 sessionId 最多保留 50 轮，30 分钟无活动自动清理。
 */
type ContextTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
};
type SessionSummary = {
  sessionId: string;
  turnCount: number;
  lastActiveAt: Date;
  firstTurnAt: Date;
};
interface ContextEngine {
  /** 追加一条消息到会话上下文 */
  append(sessionId: string, role: "user" | "assistant" | "system", content: string, meta?: Record<string, unknown>): void;
  /** 获取最近 N 轮对话（用于 LLM prompt 构建） */
  getRecent(sessionId: string, maxTurns?: number): ContextTurn[];
  /** 获取所有活跃会话摘要 */
  listSessions(): SessionSummary[];
  /** 清除一个会话的上下文 */
  clear(sessionId: string): void;
  /** 压缩长上下文（超过 maxTurns 时保留最近 N 轮） */
  compress(sessionId: string, maxTurns?: number): Promise<void>;
  /** 将上下文保存到 DB（持久化，可选） */
  persist?(db: unknown): Promise<void>;
}
//#endregion
//#region src/kernel/user-profile-store.d.ts
/**
 * user-profile-store.ts — 用户画像存储
 *
 * 双层存储：内存缓存（快速读取）+ SQLite 持久化（重启保留）。
 * 运行时实例挂载到 ClaworksRuntime.userProfileStore。
 * perceive.intent 读取画像并注入 LLM prompt，提升个性化响应。
 *
 * 存储层：
 *   - 内存缓存 Map：同一进程内多次读取无需查 DB
 *   - SQLite cw_user_profiles 表：重启后恢复用户偏好
 *   - 无 DB 时降级为纯内存（向后兼容）
 *
 * 清理策略：
 *   - 内存层：7 天无活动自动清理（仅从缓存移除，DB 不删）
 *   - DB 层：保留永久记录，由 UPDATE 持续刷新
 */
type ResponseStyle = "concise" | "detailed" | "structured";
type UserProfile = {
  userId: string;
  name?: string;
  preferredLanguage?: string;
  preferredResponseStyle: ResponseStyle;
  recentTopics: string[];
  interactionCount: number;
  lastSeenAt: string;
  customNotes?: string;
};
interface UserProfileStore {
  get(userId: string): UserProfile;
  update(userId: string, patch: Partial<Omit<UserProfile, "userId">>): void;
  addTopic(userId: string, topic: string): void;
  getPreferredStyle(userId: string): ResponseStyle;
  setName(userId: string, name: string): void;
  bump(userId: string): void;
  toPromptHint(userId: string): string;
  list(): UserProfile[];
}
//#endregion
//#region src/kernel/intent-registry.d.ts
/**
 * IntentRegistry — IM 意图到业务事件的映射注册表
 *
 * 解耦 function-executor.ts 中的硬编码意图映射表：
 *   - 各 Pack 在 entry.ts 通过 PackContribution.intentMappings 声明自己的意图
 *   - function-executor 的 publish_event_from_intent 查此注册表而非硬编码 if-else
 *   - base Pack 只保留系统级 intent（hitl_approve, pack_reload, kb_query）
 *   - 业务 Pack 注册业务级 intent（task_create, alarm_report 等）
 *
 * 优先级：后注册覆盖先注册（业务包可覆盖 base 默认行为）
 */
interface IntentMapping {
  /** LLM 分类返回的 intent 字符串（snake_case） */
  intent: string;
  /** 要发布的业务事件类型 */
  eventType: string;
  /** 可选：注册来源 Pack ID */
  packId?: string;
  /** 可选：人类可读描述（用于调试/文档） */
  description?: string;
}
interface IntentRegistry {
  /** 注册单个 intent 映射 */
  register(mapping: IntentMapping): void;
  /** 批量注册（Pack entry 常用） */
  registerAll(packId: string, mappings: Array<Omit<IntentMapping, "packId">>): void;
  /** 根据 intent 字符串查找 eventType。找不到返回 undefined。 */
  resolve(intent: string): IntentMapping | undefined;
  /** 列出所有已注册映射 */
  list(): IntentMapping[];
  /** 删除指定 Pack 注册的所有映射（Pack 卸载时调用） */
  unregisterPack(packId: string): void;
  /** 清空所有注册（热重载前调用） */
  clear(): void;
}
declare function createIntentRegistry(): IntentRegistry;
//#endregion
//#region src/claworks/model-router.d.ts
type ModelRouterConfig = {
  default?: string;
  fast?: string;
  embed?: string; /** 分类/快速任务专用小模型（如 Qwen 7B） */
  classification_model?: string; /** 复杂推理/代码任务专用强模型 */
  reasoning_model?: string; /** 代码生成专用模型（默认回退到 reasoning_model） */
  code_model?: string; /** 长文档生成专用模型（大上下文窗口） */
  document_model?: string;
};
type ModelRouter = {
  resolve(stepKind: string, explicitModel?: string): string | undefined; /** 按任务类型选择最合适的模型 */
  resolveForTask(taskType: "classify" | "chat" | "reason" | "code" | "document"): string;
};
/**
 * Resolves LLM model for playbook steps. Explicit step.model always wins.
 */
declare function createModelRouter(config?: ModelRouterConfig): ModelRouter;
//#endregion
//#region src/claworks/robot-identity.d.ts
/**
 * Robot Identity — 机器人自身的身份、记忆、规则与 RBAC 守卫。
 *
 * 设计原则：
 * - 机器人有自己的 robot.md（角色宣言 + 规则），不依赖聊天会话记忆
 * - RBAC 规则作为 ObjectType "RbacPolicy" 存入 ObjectStore（可靠数据，不是硬编码）
 * - 权限校验发布 `rbac.denied` 事件，可被 Playbook 响应（智能化，而非硬拒绝后沉默）
 * - 机器人记忆（声明性事实）存储为 ObjectType "RobotMemory"
 */
type RobotOwner = {
  ownerId: string;
  channelId?: string;
  shiftSchedule?: string;
};
type RobotIdentity = {
  name: string;
  role: string;
  domain: string;
  description: string; /** 运行时规则摘要（来自 robot.md + pack 规则） */
  rules: string[]; /** 机器人守则 Markdown 全文 */
  agentMd: string; /** 唯一主人（来自 robot.md Owner 段） */
  owner?: RobotOwner;
};
/**
 * RBAC 策略记录。
 *
 * 基础 RBAC（单机器人、固定规则）是开源功能，存储于 ObjectStore 的 RbacPolicy 对象。
 *
 * @enterprise 高级 RBAC 功能（行级安全、委托链、多租户命名空间隔离、SSO 身份绑定）
 * 通过 ClaWorks Enterprise 插件提供，不包含在本开源版本中。
 */
type RbacPolicy = {
  id: string; /** 操作类型：event.publish | playbook.trigger | rest.write | a2a.delegate | hitl.resolve */
  action: string; /** 资源通配符：alarm.* | playbook:diagnose_on_alarm | * */
  resource: string; /** 主体类型：agent | peer | apikey | channel_user */
  subjectType: "agent" | "peer" | "apikey" | "channel_user" | "system"; /** 主体标识（* 表示所有同类） */
  subjectId: string;
  effect: "allow" | "deny"; /** 可选条件（可引用 payload 字段） */
  condition?: string;
};
type RbacCheckInput = {
  action: string;
  resource: string;
  subjectType: RbacPolicy["subjectType"];
  subjectId: string; /** 可选上下文（payload / event 内容） */
  context?: Record<string, unknown>;
};
type RbacCheckResult = {
  allowed: true;
} | {
  allowed: false;
  reason: string;
  policy?: RbacPolicy;
};
/**
 * 加载 robot.md —— 按以下优先级查找：
 * 1. packDir/robot.md（Pack 内置角色宣言）
 * 2. stateDir/robot.md（运营方定制）
 * 3. 内置默认（从 robot name + description 生成）
 */
declare function loadRobotMd(opts: {
  robotName: string;
  robotRole: string;
  domain?: string;
  packDirs?: string[];
  stateDir?: string;
}): string;
/**
 * 提取 robot.md 中「核心规则」段落作为 rules[] 列表。
 */
/**
 * 从 robot.md 解析 Owner 段（支持 YAML 风格键或 Markdown 列表）。
 */
declare function extractOwnerFromMd(md: string): RobotOwner | undefined;
declare function extractRulesFromMd(md: string): string[];
/**
 * 构建机器人身份对象（从 robot.md 派生）。
 */
declare function buildRobotIdentity(opts: {
  robotName: string;
  robotRole: string;
  domain?: string;
  packDirs?: string[];
  stateDir?: string;
}): RobotIdentity;
/**
 * RBAC 守卫 —— 从 ObjectStore RbacPolicy 对象评估权限。
 *
 * 策略评估顺序：
 * 1. 精确匹配（action + resource + subject）的 deny → 立即拒绝
 * 2. 精确匹配的 allow → 通过
 * 3. 通配符匹配（同顺序）
 * 4. 默认 deny（如无任何策略匹配）
 *
 * 可靠性原则：RBAC 守卫本身是纯函数，策略来自 ObjectStore（可审计、可热更新）。
 */
declare function createRbacGuard(policies: RbacPolicy[]): {
  check(input: RbacCheckInput): RbacCheckResult; /** 加载新策略列表（Pack 热重载后调用） */
  reload(newPolicies: RbacPolicy[]): void;
};
/**
 * 内置默认策略（开机可用，不依赖 Pack）。
 * 运营方可通过 ObjectStore 的 RbacPolicy 对象覆盖或扩展。
 */
declare const DEFAULT_RBAC_POLICIES: RbacPolicy[];
//#endregion
//#region src/planes/orch/hitl-gate.d.ts
interface HitlPending {
  token: string;
  runId: string;
  stepId: string;
  message: string;
  options: string[];
  createdAt: Date;
  /** Unix ms when this entry expires; undefined = no timeout. */
  expiresAt?: number;
  /** Auto-resolve decision when expired; undefined means abort the run. */
  onTimeout?: string;
}
interface ExpiredHitl {
  pending: HitlPending;
  /** Auto-resolution decision (onTimeout value or first option). */
  decision: string;
}
interface HitlGate {
  suspend(run: PlaybookRun, stepId: string, message: string, options: string[], timeoutSeconds?: number, onTimeout?: string): string;
  resolve(token: string, decision: string, comment?: string): HitlPending | null;
  get(token: string): HitlPending | undefined;
  /** List all currently pending approvals (for REST /v1/hitl/pending). */
  listPending(): HitlPending[];
  /**
   * Scan for entries past their expiresAt deadline.
   * Removes them and returns their auto-resolution info for the caller to handle.
   * Call from a scheduler tick (e.g., every 30 s).
   */
  expireStale(): ExpiredHitl[];
  /** Hydrate in-memory state from DB after process restart. */
  hydrate?(): void;
}
declare function createHitlGate(): HitlGate;
//#endregion
//#region src/planes/orch/step-executor.d.ts
declare class HitlSuspendedError extends Error {
  readonly token: string;
  readonly stepId: string;
  constructor(token: string, stepId: string);
}
declare class StepFailedError extends Error {
  readonly stepId: string;
  readonly policy: "abort" | "continue";
  constructor(message: string, stepId: string, policy: "abort" | "continue");
}
type LlmCompleteFn = (params: {
  prompt: string;
  model?: string;
}) => Promise<{
  text: string;
}>;
type NotifyFn = (params: {
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
type ConnectorInvokeFn = (connectorId: string, method: string, params?: Record<string, unknown>) => Promise<void>;
type TriggerPlaybookFn = (playbookId: string, input: Record<string, unknown>) => Promise<PlaybookRun>;
type SubagentRunFn = (params: {
  prompt: string;
  model?: string;
}) => Promise<{
  text: string;
}>;
type SkillRunFn = (params: {
  skillId: string;
  input?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;
type StepExecutorDeps = {
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
  /**
   * Pack action registry — step-executor 优先在此查找处理器。
   * 找到时直接委托给 Pack 注册的 ActionHandler，无需修改 runtime。
   */
  actionRegistry?: ActionRegistry;
  /**
   * Pack intent registry — 传递给 function-executor 的 publish_event_from_intent。
   * 各 Pack 在 entry.ts 通过 PackContribution.intentMappings 注册。
   */
  intentRegistry?: IntentRegistry;
};
declare function executePlaybookStep(step: PlaybookStep, ctx: PlaybookStepContext, run: PlaybookRun, deps: StepExecutorDeps): Promise<void>;
declare function interpolate(template: string, vars: Record<string, unknown>): string;
//#endregion
//#region src/planes/orch/playbook-engine.d.ts
interface PlaybookEngine {
  loadFromPacks(packs: LoadedPack[]): Promise<void>;
  /**
   * 动态加载（或替换）单个 Playbook 定义（热重载用）。
   * 若同 id 已存在则替换，否则新增。
   */
  load(playbook: PlaybookDefinition): void;
  /**
   * 按 id 卸载一个 Playbook（热移除用）。
   */
  unload(id: string): void;
  list(): PlaybookDefinition[];
  /** Alias for list() for readability in integration tests and external consumers. */
  listPlaybooks(): PlaybookDefinition[];
  trigger(playbookId: string, input: Record<string, unknown>, ctx?: Partial<PlaybookStepContext>): Promise<PlaybookRun>;
  getRun(runId: string): Promise<PlaybookRun | null>;
  listRuns(opts: {
    playbookId?: string;
    status?: string;
    limit?: number;
  }): Promise<PlaybookRun[]>;
  submitHitlDecision(runId: string, stepId: string, decision: string, comment?: string): Promise<PlaybookRun>;
  reloadPack(packId: string): Promise<void>;
  /** Restore waiting_hitl runs from DB after process restart */
  hydrateSuspendedRuns(): Promise<number>;
  /**
   * Sweep HITL entries past their expiresAt deadline and auto-resume them
   * with the configured on_timeout decision. Returns count of expired runs.
   */
  expireStaleHitl(): Promise<number>;
  setLlmComplete(fn: LlmCompleteFn | undefined): void;
  setNotify(fn: NotifyFn | undefined): void;
  setConnectorInvoke(fn: ConnectorInvokeFn | undefined): void;
}
type PlaybookEngineDeps = {
  db: CwDatabase;
  objectStore: ObjectStore;
  kb: KnowledgeBase;
  robot: RobotInfo;
  hitl: HitlGate;
  llmComplete?: LlmCompleteFn;
  notify?: NotifyFn;
  connectorInvoke?: ConnectorInvokeFn;
  publishEvent?: (type: string, source: string, payload: Record<string, unknown>, correlationId?: string) => Promise<void>;
  ontology?: OntologyEngine;
  subagentRun?: SubagentRunFn;
  skillRun?: SkillRunFn;
  reloadPacks?: () => Promise<Record<string, unknown>>;
  reloadPackById?: (packId: string) => Promise<LoadedPack | null>;
  a2aPeers?: A2aPeerConfig[];
  modelRouter?: ModelRouter;
  rbacCheck?: (input: RbacCheckInput) => RbacCheckResult;
  logger?: (msg: string) => void; /** Pack action registry — passed through to step-executor for dynamic dispatch */
  actionRegistry?: ActionRegistry; /** Pack intent registry — passed through to function-executor */
  intentRegistry?: IntentRegistry;
};
declare function createPlaybookEngine(deps: PlaybookEngineDeps): PlaybookEngine;
//#endregion
//#region src/kernel/dedup.d.ts
/**
 * EventDedup — 事件去重守卫（防止相同事件短时间内重复触发相同 Playbook）。
 *
 * 解决「能量守恒」问题：同源事件 60 秒内不重复触发相同 Playbook。
 * 去重键：source + eventType + playbookId。
 */
type DedupGuard = {
  /** 检查是否应跳过（已在窗口内处理过） */shouldSkip(key: string): boolean; /** 记录一次触发 */
  record(key: string): void; /** 构建去重键 */
  buildKey(source: string, eventType: string, playbookId: string): string;
};
declare function createDedupGuard(windowMs?: number): DedupGuard;
//#endregion
//#region src/kernel/playbook-matcher.d.ts
interface PlaybookMatcher {
  load(playbooks: PlaybookDefinition[]): void;
  match(event: CwEvent): CwEventMatch[];
}
declare function createPlaybookMatcher(): PlaybookMatcher;
/** Token overlap fallback when glob patterns miss (e.g. alarm.triggered ≈ alarm.created). */
declare function semanticFallbackScore(pattern: string, eventType: string): number;
/** Best-effort translation of Python-style pack conditions. */
declare function evaluateCondition(condition: string, payload: Record<string, unknown>): boolean;
//#endregion
//#region src/kernel/event-bus.d.ts
interface EventBus {
  publish(event: CwEvent): Promise<CwEventMatch[]>;
  subscribe(pattern: string, handler: (event: CwEvent) => Promise<void>): () => void;
  query(opts: EventQueryOptions): Promise<CwEvent[]>;
}
type EventBusOptions = {
  matcher: PlaybookMatcher;
  maxLogEntries?: number;
  onMatch?: (matches: CwEventMatch[]) => Promise<void>;
};
declare function createEventBus(opts: EventBusOptions): EventBus;
//#endregion
//#region src/kernel/outbox.d.ts
type OutboxDelivery = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError?: string;
};
type EventOutbox = {
  enqueue(kind: string, payload: Record<string, unknown>): string;
  flush(handler: (delivery: OutboxDelivery) => Promise<void>, opts?: {
    onExhausted?: (delivery: OutboxDelivery) => Promise<void>;
  }): Promise<number>;
  pendingCount(): number;
  deadCount(): number;
};
declare function createEventOutbox(db: CwDatabase): EventOutbox;
//#endregion
//#region src/kernel/event-kernel.d.ts
interface EventKernel {
  bus: EventBus;
  matcher: PlaybookMatcher;
  outbox: EventOutbox | null;
  dedup: DedupGuard;
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(type: string, source: string, payload: Record<string, unknown>, opts?: {
    correlationId?: string;
    idempotencyKey?: string;
    subjectId?: string;
    subjectType?: CwEvent["subjectType"];
  }): Promise<CwEventMatch[]>;
  flushOutbox(): Promise<number>;
  /** 列出所有已注册的能力（委托给 capabilities 注册表）。 */
  listCapabilities(): CapabilityView[];
  /** 订阅事件总线上的特定事件类型，返回取消订阅函数。 */
  subscribe(type: string, handler: (payload: Record<string, unknown>) => void): () => void;
  /** 通过能力注册表调用能力（委托给 capabilities.invoke）。 */
  callCapability(id: string, ctx: CapabilityContext, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 注入能力注册表（在 runtime 组装完成后调用）。 */
  setCapabilityRegistry(registry: CapabilityRegistry): void;
  /** 返回最近 N 条事件（用于 observe.* 能力统计）。 */
  getRecentEvents(limit?: number, type?: string): Array<{
    type: string;
    source: string;
    ts: Date;
  }>;
}
type EventKernelOptions = {
  playbookEngine: PlaybookEngine;
  db?: CwDatabase;
  onEventPublished?: (event: CwEvent, matches: CwEventMatch[]) => void;
  logger?: (msg: string) => void;
  dedupWindowMs?: number;
  playbookConcurrency?: number;
  publishAnomaly?: (payload: Record<string, unknown>) => Promise<void>;
  onOutboxExhausted?: (payload: Record<string, unknown>) => Promise<void>;
};
declare function createEventKernel(opts: EventKernelOptions): EventKernel;
//#endregion
//#region src/kernel/evolve-engine.d.ts
type EvolveRequest = {
  /** 用户的需求描述（自然语言） */description: string; /** 额外上下文（系统状态、已有能力等） */
  context?: string; /** 参考案例（few-shot 提示） */
  examples?: string[];
};
type EvolveProposal = {
  id: string;
  title: string;
  description: string; /** 生成的完整 Playbook YAML 字符串 */
  playbook_yaml: string; /** 需要调用的能力 ID 列表 */
  required_capabilities: string[]; /** 不在注册表中但需要的能力 */
  missing_capabilities: string[]; /** 触发事件名 */
  trigger_event: string; /** 测试时发送的事件名 */
  test_event: string; /** 测试时的事件载荷 */
  test_payload: Record<string, unknown>; /** 0–1 置信度 */
  confidence: number; /** 潜在问题警告 */
  warnings: string[];
};
type EvolveResult = {
  proposal: EvolveProposal;
  deployed: boolean;
  playbook_path: string;
  test_passed?: boolean;
  test_output?: unknown;
  cbr_case_id?: string;
};
interface EvolveEngine {
  /** 分析需求，LLM 生成 Playbook 方案 */
  propose(req: EvolveRequest): Promise<EvolveProposal>;
  /** 部署方案（写文件 + 热重载） */
  deploy(proposal: EvolveProposal, opts?: {
    packId?: string;
  }): Promise<EvolveResult>;
  /** 发布测试事件，验证 Playbook 是否正确触发 */
  verify(playbookId: string, testEvent: string, testPayload: Record<string, unknown>): Promise<{
    passed: boolean;
    output?: unknown;
    error?: string;
  }>;
  /** 将进化结果写入 CbrStore */
  learn(result: EvolveResult, feedback?: string): Promise<string | undefined>;
  /** 列出用户通过对话生成的所有 Playbook */
  listEvolved(): Promise<Array<{
    id: string;
    title: string;
    deployedAt: Date;
  }>>;
  /** 移除一个进化的 Playbook */
  remove(playbookId: string): Promise<void>;
}
//#endregion
//#region src/kernel/ingress.d.ts
/**
 * EventIngress — 事件入站策略路由。
 *
 * 解决「IM 消息不应默认进 EventKernel」问题：
 * 不同来源的消息经策略路由后，决定是：
 *   A) 直接进 EventKernel（Connector / OT / REST / peer）
 *   B) 经意图路由处理（IM 自然语言 → 意图分类 → 结构化事件）
 *   C) 拒绝（RBAC 或速率限制）
 *   D) 仅记录观测（observe-only）
 *
 * 路由规则可存储为 ObjectType "IngressPolicy"，从而实现 Playbook 化配置，
 * 而非硬编码 if-else。
 */
type IngressSource = "connector" | "rest" | "a2a" | "scheduler" | "system" | "im" | "mcp" | "webhook";
type IngressDecision = {
  action: "kernel";
  eventType?: string;
} | {
  action: "intent_route";
  hint?: string;
} | {
  action: "observe_only";
} | {
  action: "deny";
  reason: string;
};
type IngressPolicy = {
  id: string; /** 来源类型匹配（* 匹配所有） */
  source: IngressSource | "*"; /** 事件类型通配（* 匹配所有） */
  eventTypePattern: string; /** 主体 ID 匹配（* 匹配所有） */
  subjectId?: string;
  decision: IngressDecision; /** 优先级（数字越大越先评估） */
  priority: number;
};
/**
 * 内置默认 Ingress 策略（开机可用）：
 * - Connector/REST/A2A/Scheduler/System → 直接进 Kernel
 * - IM/Webhook → 意图路由（不直接进 Kernel，由意图 Playbook 分类后 publish）
 */
declare const DEFAULT_INGRESS_POLICIES: IngressPolicy[];
type IngressRouter = {
  decide(source: IngressSource, eventType: string, subjectId?: string): IngressDecision;
  reload(policies: IngressPolicy[]): void;
};
declare function createIngressRouter(initialPolicies?: IngressPolicy[]): IngressRouter;
//#endregion
//#region src/kernel/notification-router.d.ts
type NotificationRecipient = {
  userId: string;
  name?: string; /** 该用户偏好的渠道，按优先级排列，如 ["feishu"]、["weixin-work", "sms"] */
  channels: string[]; /** 最高优先渠道（channels[0]） */
  preferredChannel?: string;
};
type NotificationPreference = {
  userId: string; /** 用户注册的渠道（优先级由数组顺序决定） */
  channels: string[]; /** 订阅的事件类型模式，如 ["alarm.*", "work_order.*"] */
  subscriptions: string[];
};
type SubjectMapping = {
  subjectType: string;
  subjectId: string;
  userIds: string[];
};
type DispatchOpts = {
  subjectType: string;
  subjectId?: string; /** 发给某个角色的所有绑定用户（如 "equipment_operator"） */
  role?: string;
  priority: "low" | "normal" | "high" | "critical";
  title?: string;
  message: string;
  metadata?: Record<string, unknown>;
};
type DispatchResult = {
  sent: number;
  recipients: string[];
  channels: string[];
};
interface NotificationRouter {
  resolveRecipients(subjectType: string, subjectId: string): NotificationRecipient[];
  setPreference(userId: string, pref: Partial<NotificationPreference>): void;
  getPreference(userId: string): NotificationPreference | undefined;
  listPreferences(): NotificationPreference[];
  bindSubject(subjectType: string, subjectId: string, userIds: string[]): void;
  unbindSubject(subjectType: string, subjectId: string): void;
  listBindings(): SubjectMapping[];
  dispatch(opts: DispatchOpts): Promise<DispatchResult>;
}
//#endregion
//#region src/kernel/robot-constitution-v2.d.ts
/**
 * robot-constitution-v2.ts — ClaWorks 四层行为准则体系
 *
 * 参照 OpenClaw constitution 体系，扩展为四个层级：
 *
 *   Tier 0: IMMUTABLE（硬编码，代码中不可修改）
 *     - 不泄露凭据
 *     - 不冒充人类
 *     - 不在无确认的情况下删除数据
 *     - 所有对外通信必须标识为机器人
 *     - 这些规则是机器人的「道德底线」
 *
 *   Tier 1: OPERATOR（运营商配置，在 claworks.json 中设置）
 *     - 哪些能力需要 HITL
 *     - 信任来源列表
 *     - 速率限制
 *     - 机器人角色范围
 *
 *   Tier 2: USER（用户运行时设置，存储在 ObjectStore）
 *     - 个人偏好
 *     - 自定义权限
 *     - 风格偏好
 *     - 通知渠道偏好
 *
 *   Tier 3: LEARNED（可进化，通过反馈循环更新）
 *     - 响应格式偏好
 *     - 优先级调整
 *     - 行为微调
 *     - 注意：安全规则不在此层
 *
 * 与 OpenClaw 对应：
 *   Tier 0 ↔ 硬编码的 Gateway 鉴权规则
 *   Tier 1 ↔ operator-scopes + DEFAULT_ROBOT_CONSTITUTION
 *   Tier 2 ↔ PluginSessionExtension（用户状态）
 *   Tier 3 ↔ memory/kb-backed behavioral evolution
 */
declare const IMMUTABLE_RULES: {
  readonly denyAlways: readonly ["credential.export", "credential.share", "data.delete_all", "production.modify_unconfirmed", "identity.impersonate_human", "llm.inject_system_prompt"];
  readonly requireHitlAlways: readonly ["data.delete_production", "config.security_change", "pack.uninstall", "constitution.modify_tier0"];
  readonly identity: {
    readonly mustIdentifyAsRobot: true;
    readonly cannotClaimHuman: true;
    readonly mustRevealCapabilitiesOnRequest: true;
    readonly ownerInstructionsPriority: "highest";
    readonly cannotDenyBeingRobot: true;
  };
  readonly roleAccess: {
    readonly owner: {
      readonly description: "主人/管理员——所有合法能力均可使用，指令优先级最高";
      readonly canModifyConfig: true;
      readonly canAddRelations: true;
      readonly canReadAllInfo: true;
    };
    readonly admin: {
      readonly description: "管理员——可执行日常业务操作，不能修改系统安全配置";
      readonly canModifyConfig: false;
      readonly canAddRelations: true;
      readonly canReadAllInfo: true;
    };
    readonly operator: {
      readonly description: "操作员——可执行日常业务操作，不能修改系统配置或安全设置";
      readonly canModifyConfig: false;
      readonly canAddRelations: false;
      readonly canReadAllInfo: false;
    };
    readonly guest: {
      readonly description: "访客——只能查询，不能创建/修改任何数据";
      readonly canModifyConfig: false;
      readonly canAddRelations: false;
      readonly canReadAllInfo: false;
      readonly readOnly: true;
    };
  };
};
type OperatorConstitution = {
  /** 自动允许的能力 token（无需确认直接执行） */autoAllow: string[]; /** 需要 HITL 的能力 token */
  hitlRequired: string[]; /** 完全拒绝的能力 token（运营商级拒绝，比 IMMUTABLE 软） */
  deny: string[]; /** 受信任的消息来源 */
  trustedSources: string[]; /** 去重窗口（毫秒） */
  dedupWindowMs: number; /** 机器人允许执行的行业角色范围 */
  roleScope?: string[]; /** 每分钟最大调用次数（0 = 不限） */
  rateLimit?: number;
};
type UserConstitutionEntry = {
  userId: string; /** 该用户额外允许的能力（在 OPERATOR 限制基础上放宽） */
  additionalAllow?: string[]; /** 该用户额外拒绝的能力（比 OPERATOR 更严格） */
  additionalDeny?: string[]; /** 用户偏好的通知渠道 */
  preferredChannels?: string[]; /** 用户偏好的响应语言 */
  preferredLanguage?: string; /** 用户偏好的回复风格 */
  responseStyle?: "concise" | "detailed" | "structured"; /** 用户偏好的模型 */
  preferredModel?: string;
};
type LearnedConstitutionEntry = {
  capabilityId: string; /** 调整方向：nudge_allow（放宽）/ nudge_hitl（加强确认）/ style_adjust（风格调整） */
  adjustment: "nudge_allow" | "nudge_hitl" | "style_adjust"; /** 调整触发次数（达到阈值才生效） */
  feedbackCount: number;
  threshold: number; /** 不允许进化影响 Tier 0 和安全相关的 Tier 1 规则 */
  frozen?: boolean;
};
type ConstitutionDecision = {
  action: "allow" | "hitl_required" | "deny";
  tier: 0 | 1 | 2 | 3;
  reason: string;
};
type ConstitutionV2 = {
  /** 检查一个能力是否被允许执行 */check(capabilityId: string, opts?: {
    source?: string;
    userId?: string;
  }): ConstitutionDecision; /** 更新用户规则（Tier 2） */
  setUserRule(entry: UserConstitutionEntry): void;
  getUserRule(userId: string): UserConstitutionEntry | undefined; /** 记录一次反馈（Tier 3 学习） */
  recordFeedback(capabilityId: string, direction: LearnedConstitutionEntry["adjustment"]): void; /** 导出所有规则（用于诊断） */
  describe(): {
    immutable: typeof IMMUTABLE_RULES;
    operator: OperatorConstitution;
    userCount: number;
    learnedCount: number;
  };
};
//#endregion
//#region src/kernel/robot-identity-manager.d.ts
type RobotIdentityProfile = {
  id: string;
  name: string;
  role: string;
  organization: string;
  domain: string;
  version: string;
  language: string;
  timezone: string;
  owner?: {
    userId: string;
    name: string;
    contact?: string;
  };
  admins: string[];
  operators: string[];
  guests: string[];
  capabilities_summary: string;
  introduction: string;
  always_greet: boolean;
  auto_learn: boolean;
  proactive: boolean;
};
type RobotRelation = {
  userId: string;
  name: string;
  role: "owner" | "admin" | "operator" | "guest" | "peer_robot";
  channels: string[];
  bindingSubjects: string[];
  joinedAt: Date;
  note?: string;
};
type RobotIdentityManager = {
  getIdentity(): RobotIdentityProfile;
  updateIdentity(patch: Partial<RobotIdentityProfile>): void;
  addRelation(relation: Omit<RobotRelation, "joinedAt">): RobotRelation;
  removeRelation(userId: string): boolean;
  getRelation(userId: string): RobotRelation | undefined;
  listRelations(): RobotRelation[];
  buildIntroduction(lang?: string): string;
  persist(db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
    };
  }): Promise<void>;
  hydrate(db: {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => unknown;
    };
  }): Promise<void>;
};
//#endregion
//#region src/kernel/scaffold-engine.d.ts
type ScaffoldAssetType = "playbook" | "prompt_template" | "decision_table" | "skill_script" | "few_shot";
type ScaffoldAsset = {
  id: string;
  type: ScaffoldAssetType;
  name: string;
  description: string; /** YAML / TypeScript / JSON / prompt 内容 */
  content: string;
  domain?: string;
  task_type?: string;
  generated_by: string;
  generated_at: Date;
  validated: boolean;
  usage_count: number;
  success_rate: number;
};
type ScaffoldGenerateResult = {
  playbooks: number;
  prompt_templates: number;
  decision_tables: number;
  skills: number;
};
interface ScaffoldEngine {
  /** 为某个领域批量生成脚手架（调用强模型，适合离线/初始化时执行） */
  generateDomainScaffold(domain: string, context?: string): Promise<ScaffoldGenerateResult>;
  /** 生成单个少样本 Prompt 模板，让弱模型"有样学样" */
  generatePromptTemplate(taskType: string, examples: string[], opts?: {
    outputSchema?: unknown;
    model?: string;
  }): Promise<ScaffoldAsset>;
  /** 从示例中提炼决策表，把模糊 LLM 判断变成确定性规则 */
  generateDecisionTable(scenario: string, examples: Array<{
    input: unknown;
    output: unknown;
  }>): Promise<ScaffoldAsset>;
  /** 生成 Skill 脚本（确定性函数，不调 LLM） */
  generateSkillScript(capability: string, description: string): Promise<ScaffoldAsset>;
  get(id: string): ScaffoldAsset | undefined;
  list(filter?: {
    type?: string;
    domain?: string;
    task_type?: string;
  }): ScaffoldAsset[];
  /** 记录使用情况，用于成功率统计 */
  recordUsage(id: string, success: boolean): void;
  /** 将资产部署到 Runtime（注册到 promptRegistry / playbookEngine 等） */
  deploy(asset: ScaffoldAsset): Promise<void>;
}
//#endregion
//#region src/kernel/scheduler.d.ts
type PlaybookScheduler = {
  /** 从加载好的 Playbook 列表中重新构建所有定时任务 */reload(playbooks: PlaybookDefinition[]): void; /** 动态添加一条定时规则（不影响已有任务） */
  add(playbook: PlaybookDefinition): void; /** 停止所有定时任务 */
  stop(): void;
};
declare function createPlaybookScheduler(opts: {
  onFire: (playbookId: string) => void | Promise<void>;
  logger?: (msg: string) => void;
  timezone?: string;
}): PlaybookScheduler;
//#endregion
//#region src/kernel/structured-output.d.ts
/**
 * structured-output.ts — 结构化输出引擎
 *
 * 弱模型补偿：强制 LLM 输出符合 JSON schema，失败自动重试。
 * 解决弱模型输出格式不稳定的痛点。
 */
type OutputSchemaProperty = {
  type: "string" | "number" | "boolean" | "array" | "object";
  enum?: string[];
  description?: string;
};
type OutputSchema = {
  type: "object";
  required?: string[];
  properties: Record<string, OutputSchemaProperty>;
};
type StructuredOutputOpts = {
  schema: OutputSchema; /** 最大重试次数，默认 3 */
  maxRetries?: number; /** 重试时附加的提示，默认为 JSON schema 提示 */
  retryPrompt?: string; /** 解析失败后的兜底值（不抛错） */
  fallback?: Record<string, unknown>;
};
type StructuredCompleteResult = {
  data: Record<string, unknown>;
  retries: number;
  fallback: boolean;
};
type ValidationResult = {
  valid: boolean;
  errors: string[];
};
interface StructuredOutputEngine {
  /**
   * 调用 LLM 并强制返回符合 schema 的 JSON。
   * 失败自动重试（最多 maxRetries 次），追加格式提示。
   * 全部失败后使用 fallback 或抛出错误。
   */
  complete(prompt: string, schema: OutputSchema, opts?: Omit<StructuredOutputOpts, "schema">): Promise<StructuredCompleteResult>;
  /** 验证已有数据是否符合 schema（检查 required 字段、enum 值） */
  validate(data: unknown, schema: OutputSchema): ValidationResult;
}
//#endregion
//#region src/claworks/runtime-types.d.ts
/** 运行时句柄（与 `createClaworksRuntime` 返回值结构一致）。 */
type ClaworksRuntime = {
  config: ClaworksRobotConfig;
  robot: RobotInfo;
  identity: RobotIdentity;
  rbac: ReturnType<typeof createRbacGuard>;
  ingress: IngressRouter;
  db: CwDatabase;
  objectStore: ReturnType<typeof createObjectStore>;
  ontology: ReturnType<typeof createOntologyEngine>;
  kb: KnowledgeBase;
  playbookEngine: PlaybookEngine;
  kernel: EventKernel; /** 能力注册表，提供 register / invoke / list 等操作 */
  capabilities: CapabilityRegistry;
  /**
   * Playbook Action 注册表。
   * Pack entry.ts 通过 PackContribution.actionHandlers 注册，
   * step-executor 优先查此表，找不到再走通用 CRUD 兜底。
   */
  actionRegistry: ActionRegistry;
  /**
   * IM 意图注册表。
   * 各 Pack 通过 PackContribution.intentMappings 声明自己的 intent→event 映射，
   * 解耦 function-executor 的硬编码中央意图表。
   */
  intentRegistry: IntentRegistry; /** 行为准则（四层权限体系），extension capabilities 注册后设置 */
  constitution?: ConstitutionV2; /** 机器人身份管理器 */
  robotIdentityManager: RobotIdentityManager; /** 关闭运行时（停止 kernel、connector 等） */
  shutdown: () => Promise<void>;
  loadedPacks: LoadedPack[];
  packLoader: PackLoader;
  connectorManager: ConnectorManager;
  scheduler: PlaybookScheduler;
  logger?: (msg: string) => void;
  databaseDialect?: string;
  _outboxFlushTimer?: ReturnType<typeof setInterval>; /** HITL expiry sweep timer (30 s interval). */
  _hitlExpiryTimer?: ReturnType<typeof setInterval>;
  close: () => void;
  /**
   * 桥接注册表（BridgeRegistry）：对接 LLM、通知、Subagent、Skill 等外部服务。
   * extension-capabilities 在初始化时调用 createBridgeRegistry() 并注入。
   */
  bridges?: BridgeRegistry;
  /**
   * LLM 补全函数（快捷访问，等同于 bridges?.get("llm")?.complete）。
   * 由 extension-capabilities 或宿主设置。
   */
  llmComplete?: LlmCompleteFn;
  /**
   * LLM 流式补全函数（当 LLM 支持 streaming 时设置）。
   */
  llmStream?: (params: {
    prompt: string;
    model?: string;
    signal?: AbortSignal;
  }) => AsyncIterable<string>;
  /**
   * 对话上下文引擎（多轮会话记忆）。
   * 由 extension-capabilities 初始化并绑定。
   */
  contextEngine?: ContextEngine;
  /**
   * 用户画像存储（记忆用户偏好风格、近期话题、交互次数）。
   * 由 createClaworksRuntime 初始化并绑定。
   * perceive.intent 读取后注入 LLM prompt，实现个性化响应。
   */
  userProfileStore?: UserProfileStore;
  /**
   * 通知路由器（管理用户通知偏好和跨渠道分发）。
   * 由 extension-capabilities 初始化并绑定。
   */
  notificationRouter?: NotificationRouter;
  /**
   * 卡片构建器（将 CwCard DSL 渲染为各渠道格式）。
   * 由 extension-capabilities 初始化并绑定。
   */
  cardBuilder?: CardBuilder;
  /**
   * 自主进化引擎（LLM 生成 Playbook → 写文件 → 热重载 → 验证 → CBR 学习）。
   * 由宿主在 runtime 组装完成后初始化并注入。
   */
  evolveEngine?: EvolveEngine;
  /**
   * 脚手架引擎（强模型离线生成 Prompt/规则/Skill → 弱模型在线填空执行）。
   * 由 createClaworksRuntime 初始化并注入。
   */
  scaffoldEngine?: ScaffoldEngine;
  /**
   * 研究智能体（多源并行搜索 + LLM 综合分析）。
   * 由 createClaworksRuntime 初始化并注入。
   */
  researchAgent?: ResearchAgent;
  /**
   * 结构化输出引擎（强制 LLM 返回合规 JSON）。
   * 由 extension-capabilities 或宿主注入。
   */
  structuredOutput?: StructuredOutputEngine;
  /**
   * 提示词模板注册表（存储和渲染 prompt 模板）。
   * 由宿主注入；未注入时相关能力降级为内联 prompt。
   */
  promptRegistry?: {
    list(): Array<{
      id: string;
      template: string;
      description?: string;
    }>;
    render(id: string, variables?: Record<string, unknown>): string;
    register(id: string, template: string, description?: string): void;
  };
  /**
   * 案例库（Case-Based Reasoning Store）。
   * 用于存储和检索历史处理案例，支持类比推理。
   * 由宿主或专项 Pack 注入。
   */
  cbrStore?: {
    search(query: string, limit?: number): Array<Record<string, unknown>>; /** 添加案例：可传递结构化对象，也可分别传 problem/solution/metadata */
    add(problemOrEntry: string | Record<string, unknown>, solution?: string, metadata?: Record<string, unknown>): Record<string, unknown>;
    recordOutcome(caseId: string, outcome: string, metadata?: Record<string, unknown>): void;
    list(): Array<Record<string, unknown>>;
  };
  /**
   * Hook 引擎（生命周期钩子注册）。
   * 支持在 Playbook/事件处理的关键节点注入自定义逻辑。
   * 由宿主注入。
   */
  hookEngine?: {
    register(config: Record<string, unknown>): Record<string, unknown>;
    unregister(hookId: string): boolean;
    list(): Array<Record<string, unknown>>;
    enable(hookId: string): void;
    disable(hookId: string): void;
  };
  /**
   * Provider 注册表（模型/服务提供者管理）。
   * 由宿主注入；与 OpenClaw 插件系统的 provider registry 对应。
   */
  providerRegistry?: {
    list(kind?: string): Array<{
      id: string;
      kind: string;
      name?: string;
      priority?: number;
      available?: boolean;
      meta?: Record<string, unknown>;
      [k: string]: unknown;
    }>;
    isAvailable(id: string): boolean;
    register(provider: Record<string, unknown>): void;
  };
  /**
   * Skill 库（可调用的技能列表）。
   * 由宿主或专项 Pack 注入。
   */
  skillLibrary?: {
    list(): Array<{
      id: string;
      name: string;
      description?: string;
    }>;
    get(id: string): Record<string, unknown> | undefined;
    invoke(id: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  /**
   * 规则引擎（基于声明式规则的决策支持）。
   * 由宿主注入；未注入时规则类能力不可用。
   */
  ruleEngine?: {
    /** 对单个规则集（tableId）求值，返回触发的规则列表 */evaluate(tableIdOrInput: string | Record<string, unknown>, context?: Record<string, unknown>): Array<{
      id: string;
      triggered: boolean;
      action?: string;
    }>;
    listRules(): Array<{
      id: string;
      name?: string;
      condition: string;
      action?: string;
    }>;
    addRule(rule: Record<string, unknown>): void;
    [key: string]: unknown;
  };
  /**
   * 额外的可扩展运行时属性（由宿主或插件动态挂载）。
   * 类型为 unknown，调用者需自行断言。
   */
  [key: string]: unknown;
};
//#endregion
//#region src/kernel/prompt-templates.d.ts
/**
 * prompt-templates.ts — ClaWorks 弱模型脚手架：Prompt 模板注册表
 *
 * 为常见工业场景提供精心设计的中文 Prompt 模板，让弱开源模型
 * (Qwen/Deepseek/Llama) 也能稳定完成结构化输出任务。
 *
 * 内置模板（6 个）：
 *   intent_classify         — 意图分类（15 类，few-shot）
 *   alarm_analysis          — 报警根因分析（步骤引导）
 *   work_order_description  — 自动生成工单描述
 *   kb_answer               — 知识库检索增强问答
 *   shift_summary           — 班次总结生成
 *   report_narrative        — 报告文字描述生成
 *
 * 设计原则：
 *   - 模板变量用 {{variable}} 占位，render() 替换
 *   - system prompt 简短、明确，避免弱模型迷失
 *   - 每个模板指定 outputFormat（json/text/list）
 *   - few-shot 示例让弱模型「有样学样」
 */
type PromptTemplate = {
  id: string;
  name: string;
  description: string; /** {{variable}} 占位符会被 render() 替换 */
  system: string;
  user: string;
  outputFormat: "json" | "text" | "list";
  examples?: Array<{
    input: Record<string, string>;
    output: string;
  }>;
};
//#endregion
//#region src/pack-loader/pack-sdk.d.ts
type HookDefinition = {
  event: string;
  handler: (event: Record<string, unknown>) => void | Promise<void>;
};
type PackContribution = {
  /** 注册到能力注册表的额外能力 */capabilities?: CapabilityDescriptor[]; /** 注册到 Playbook 引擎的 Playbook 定义 */
  playbooks?: PlaybookDefinition[]; /** 注册到本体引擎的对象类型 */
  objectTypes?: ObjectTypeDefinition[]; /** 注册到 Prompt 模板注册表的模板 */
  promptTemplates?: PromptTemplate[]; /** 事件钩子 */
  hooks?: HookDefinition[];
  /**
   * Playbook action 处理器映射（核心扩展点）。
   *
   * 键为 action_api_name（与 Playbook YAML 中的 action_api_name 一致）。
   * 注册后，step-executor 优先调用此处理器，无需修改 runtime。
   *
   * 示例：
   * ```ts
   * actionHandlers: {
   *   "create_task": async (params, ctx) => { ... return { status: "ok", id }; },
   *   "update_task_status": handlers.updateTaskStatus,
   * }
   * ```
   */
  actionHandlers?: Record<string, ActionHandler>;
  /**
   * IM 意图到业务事件的映射声明（解耦 function-executor 硬编码表）。
   *
   * 每个 Pack 声明自己识别的 intent 并指定对应的事件类型。
   * base Pack 只保留系统级 intent；业务 Pack 注册业务 intent。
   *
   * 示例：
   * ```ts
   * intentMappings: [
   *   { intent: "task_create", eventType: "task.create_requested", description: "用户请求创建任务" },
   *   { intent: "task_query", eventType: "task.status_query" },
   * ]
   * ```
   */
  intentMappings?: Array<Omit<IntentMapping, "packId">>; /** Pack 加载时执行（初始化连接/注册监听等） */
  onLoad?: (runtime: ClaworksRuntime) => void | Promise<void>; /** Pack 卸载时执行（清理资源） */
  onUnload?: () => void | Promise<void>;
};
/**
 * Pack 开发者导出的工厂函数签名。
 * Pack 的 index.ts/index.js 默认导出必须符合此类型。
 */
type PackFactory = (runtime: ClaworksRuntime) => PackContribution | Promise<PackContribution>;
type PackSdkContext = {
  runtime: ClaworksRuntime; /** 便捷方法：向 EventBus 发布事件 */
  publish(eventType: string, payload?: Record<string, unknown>): Promise<void>; /** 便捷方法：读取 KB */
  search(query: string, limit?: number): Promise<Array<{
    id: string;
    content: string;
    score: number;
  }>>; /** 便捷方法：写入 KB */
  ingest(content: string, metadata?: Record<string, unknown>): Promise<string>; /** 获取当前运行时配置 */
  config(): Record<string, unknown>;
};
//#endregion
//#region src/pack-loader/types.d.ts
interface PackDependency {
  /** Pack ID to depend on. */
  id: string;
  /** Semver range string, e.g. ">=0.1.0". Optional — omit to accept any version. */
  version?: string;
  /** If true, a missing dependency is a warning, not an error. Default false. */
  optional?: boolean;
}
interface PackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  license: string;
  /** @deprecated Use `requires` instead. Legacy flat string dependency list. */
  dependencies?: string[];
  /**
   * Structured dependency declarations.
   * Validated by the loader before activating a pack.
   */
  requires?: PackDependency[];
  /**
   * JS/TS 入口文件（相对于 pack 目录），默认导出必须为 PackFactory。
   * 例如: "./src/capabilities.js"
   */
  entry?: string;
  provides: {
    objectTypes: string[];
    playbooks: string[];
    actionTypes: string[];
    capabilities?: string[];
  };
}
interface PackDependencyError {
  packId: string;
  dependencyId: string;
  reason: string;
}
interface LoadedPack {
  manifest: PackManifest;
  path: string;
  objectTypes: ObjectTypeDefinition[];
  playbooks: PlaybookDefinition[];
  /**
   * 当 manifest.entry 存在时，动态 import 并缓存的 PackFactory。
   * pack-runtime.ts 在获得 runtime 后调用此 factory 注册能力。
   */
  factory?: PackFactory;
}
interface CwPackConfig {
  auto_load?: boolean;
  paths?: string[];
  installed?: string[];
  registry?: string;
}
interface PackLoader {
  load(packPath: string, logger?: (msg: string) => void): Promise<LoadedPack>;
  loadInstalled(config: CwPackConfig, logger?: (msg: string) => void): Promise<LoadedPack[]>;
  install(source: string, config: CwPackConfig, logger?: (msg: string) => void): Promise<LoadedPack>;
  list(): LoadedPack[];
}
//#endregion
//#region src/pack-loader/loader.d.ts
/**
 * Validate that all non-optional `requires` entries are satisfied by the loaded pack set.
 * Returns a list of errors (empty = all dependencies satisfied).
 */
declare function validatePackDependencies(packs: LoadedPack[], logger?: (msg: string) => void): PackDependencyError[];
declare function resolvePackDir(packRef: string, searchPaths: string[]): Promise<string | null>;
declare function createPackLoader(): PackLoader;
//#endregion
//#region src/interfaces/nexus/types.d.ts
/** ClaWorks Nexus registry API (ClawHub-compatible subset). */
type NexusPackageSummary = {
  slug: string;
  name: string;
  description?: string;
  latestVersion?: string;
  family?: string;
};
type NexusPackageDetail = NexusPackageSummary & {
  versions: string[];
};
type NexusVersionDetail = {
  slug: string;
  version: string;
  manifest?: Record<string, unknown>;
};
type NexusPackageListResponse = {
  packages: NexusPackageSummary[];
};
type NexusArtifactDescriptor = {
  slug: string;
  version: string;
  hostKey: string;
  mediaType: string;
  size?: number;
};
//#endregion
//#region src/pack-loader/nexus-client.d.ts
type NexusInstallSpec = {
  slug: string;
  version?: string;
};
declare function parseNexusSource(source: string): NexusInstallSpec | null;
declare function listNexusPackages(registry: string, opts?: {
  q?: string;
}): Promise<NexusPackageListResponse>;
declare function getNexusPackage(registry: string, slug: string): Promise<NexusPackageDetail>;
declare function downloadPackArtifact(registry: string, slug: string, version: string): Promise<Buffer>;
declare function installPackFromNexus(params: {
  registry: string;
  source: string;
  installRoot: string;
}): Promise<{
  slug: string;
  version: string;
  path: string;
}>;
//#endregion
//#region src/pack-loader/yaml-parsers.d.ts
declare function readPackManifest(manifestPath: string): Promise<PackManifest>;
declare function parseObjectTypeYaml(content: string, packId: string, fileName: string): ObjectTypeDefinition;
declare function parsePlaybookYaml(content: string, packId: string): PlaybookDefinition;
//#endregion
//#region src/claworks/notify-types.d.ts
/** 通知通道目标（与 OpenClaw outbound 适配器对接）。 */
type NotifyChannelTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};
type ClaworksNotifyConfig = {
  targets?: NotifyChannelTarget[]; /** Playbook notify 步骤仅给 channel 名时的默认通道 */
  default_channel?: string;
};
//#endregion
//#region src/claworks/config-types.d.ts
type ClaworksRobotConfig = {
  api?: {
    api_key?: string; /** 是否要求 API key（默认 false） */
    require_api_key?: boolean;
  }; /** 安全策略（请求过滤、IP 白名单等） */
  security?: {
    allowed_origins?: string[];
    ip_whitelist?: string[];
    [key: string]: unknown;
  };
  a2a?: {
    enabled?: boolean;
    endpoint?: string;
    peers?: A2aPeerConfig[];
  };
  kernel?: {
    event_queue_size?: number;
    playbook_concurrency?: number;
    hitl_timeout_seconds?: number;
    scheduler_timezone?: string; /** 速率限制：最大请求数（滑动窗口） */
    rate_limit_max_requests?: number; /** 速率限制窗口时长（ms） */
    rate_limit_window_ms?: number;
  };
  robot?: {
    name?: string;
    role?: RobotInfo["role"];
    port?: number;
    host?: string;
    session_key?: string; /** 组织/企业名称 */
    organization?: string; /** 业务领域（如 "oil-gas", "manufacturing"） */
    domain?: string; /** 机器人归属用户 ID */
    owner_user_id?: string; /** 机器人归属用户名 */
    owner_name?: string; /** 是否启用主动通知（proactive messaging） */
    proactive?: boolean; /** 机器人界面语言（zh-CN / en-US 等） */
    language?: string; /** 是否启用自动学习（从对话中积累知识） */
    auto_learn?: boolean;
  };
  data?: {
    database_url?: string;
    kb_path?: string;
    kb_provider?: "stub" | "memory-core";
    memory_agent_id?: string; /** 知识库嵌入模型 ID */
    kb_embed_model?: string; /** 知识库监控目录（自动 ingest） */
    kb_watch_dirs?: string[]; /** 知识库命名空间 */
    kb_namespace?: string; /** 知识库监控间隔（ms） */
    kb_watch_interval_ms?: number;
  };
  packs?: CwPackConfig;
  notify?: ClaworksNotifyConfig;
  im_bridge?: {
    auto_on_message_received?: boolean;
  };
  model_router?: {
    default?: string;
    fast?: string;
    embed?: string; /** 对话模型（chat completion） */
    chat?: string;
  };
  connectors?: Record<string, ConnectorConfigInput>;
};
//#endregion
export { createDedupGuard as $, ObjectStore as $t, PackSdkContext as A, createIntentRegistry as At, EventKernel as B, PlaybookDefinition as Bt, PackDependency as C, extractRulesFromMd as Ct, HookDefinition as D, createModelRouter as Dt, PackManifest as E, ModelRouterConfig as Et, IngressDecision as F, ActionRegistry as Ft, createEventOutbox as G, StepLog as Gt, createEventKernel as H, PlaybookStep as Ht, IngressPolicy as I, createActionRegistry as It, createEventBus as J, listA2aPeerNames as Jt, EventBus as K, StepMeta as Kt, IngressRouter as L, ConnectorEventHandler as Lt, PlaybookScheduler as M, CapabilityDescriptor as Mt, createPlaybookScheduler as N, ActionHandler as Nt, PackContribution as O, IntentMapping as Ot, DEFAULT_INGRESS_POLICIES as P, ActionRegistration as Pt, DedupGuard as Q, CwObject as Qt, IngressSource as R, ConnectorManager as Rt, LoadedPack as S, ConnectorStatus as Sn, extractOwnerFromMd as St, PackLoader as T, ModelRouter as Tt, EventOutbox as U, PlaybookStepContext as Ut, EventKernelOptions as V, PlaybookRun as Vt, OutboxDelivery as W, PublishEventFn as Wt, evaluateCondition as X, OntologyEngine as Xt, createPlaybookMatcher as Y, resolveA2aTarget as Yt, semanticFallbackScore as Z, createOntologyEngine as Zt, NexusVersionDetail as _, resolveConnectorConfigs as _n, RbacPolicy as _t, parsePlaybookYaml as a, ObjectTypeDefinition as an, NotifyFn as at, validatePackDependencies as b, ConnectorInboundMessage as bn, buildRobotIdentity as bt, downloadPackArtifact as c, CwEventMatch as cn, StepFailedError as ct, listNexusPackages as d, KbIngestOptions as dn, interpolate as dt, createObjectStore as en, PlaybookEngine as et, parseNexusSource as f, KbResult as fn, HitlGate as ft, NexusPackageSummary as g, ConnectorConfigInput as gn, RbacCheckResult as gt, NexusPackageListResponse as h, RobotInfo as hn, RbacCheckInput as ht, parseObjectTypeYaml as i, FieldDefinition as in, LlmCompleteFn as it, ClaworksRuntime as j, CapabilityContext as jt, PackFactory as k, IntentRegistry as kt, getNexusPackage as l, EventQueryOptions as ln, SubagentRunFn as lt, NexusPackageDetail as m, KnowledgeBase as mn, DEFAULT_RBAC_POLICIES as mt, ClaworksNotifyConfig as n, CwDatabase as nn, ConnectorInvokeFn as nt, readPackManifest as o, ValidationResult$1 as on, SkillRunFn as ot, NexusArtifactDescriptor as p, KbStatus as pn, createHitlGate as pt, EventBusOptions as q, A2aPeerConfig as qt, NotifyChannelTarget as r, CwPreparedStatement as rn, HitlSuspendedError as rt, NexusInstallSpec as s, CwEvent as sn, StepExecutorDeps as st, ClaworksRobotConfig as t, openDatabase as tn, createPlaybookEngine as tt, installPackFromNexus as u, EventTrigger as un, executePlaybookStep as ut, createPackLoader as v, ConnectorAutoStart as vn, RobotIdentity as vt, PackDependencyError as w, loadRobotMd as wt, CwPackConfig as x, ConnectorOutboundMessage as xn, createRbacGuard as xt, resolvePackDir as y, ConnectorConfig as yn, RobotOwner as yt, createIngressRouter as z, ActionStep as zt };