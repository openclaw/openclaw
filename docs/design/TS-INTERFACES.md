# ClaWorks TypeScript 接口定义

> 这份文档是 Phase 1 实现的**类型契约**。所有核心模块必须实现这些接口。
> 文件路径对应 `src/kernel/`, `src/planes/`, `src/interfaces/`。

---

## 一、EventKernel

### 事件类型（`src/kernel/types.ts`）

```typescript
/** ClaWorks 内部事件。source 是 URI 格式标识符，payload 由事件类型决定。 */
export interface CwEvent {
  id: string;
  type: string; // e.g. "alarm.created", "workorder.status_changed"
  source: string; // e.g. "opc-ua://plc-001", "rest-api", "scheduler"
  timestamp: Date;
  payload: Record<string, unknown>;
  correlationId?: string; // 关联到同一业务流程的 ID
}

export interface CwEventMatch {
  event: CwEvent;
  playbookId: string;
  priority: number;
  input: Record<string, unknown>; // 从 event.payload 映射到 Playbook 输入
}
```

### 事件总线（`src/kernel/event-bus.ts`）

```typescript
export interface EventBus {
  /** 发布事件，返回匹配到的 Playbook 列表 */
  publish(event: CwEvent): Promise<CwEventMatch[]>;

  /** 订阅事件类型（支持 glob pattern：`alarm.*`、`workorder.#`） */
  subscribe(pattern: string, handler: (event: CwEvent) => Promise<void>): () => void;

  /** 查询事件日志 */
  query(opts: EventQueryOptions): Promise<CwEvent[]>;
}

export interface EventQueryOptions {
  type?: string;
  source?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}
```

### Playbook Matcher（`src/kernel/playbook-matcher.ts`）

```typescript
export interface PlaybookMatchRule {
  playbookId: string;
  trigger: EventTrigger;
  priority: number;
}

export type EventTrigger =
  | { kind: "event"; pattern: string; filter?: Record<string, unknown> }
  | { kind: "schedule"; cron: string; timezone?: string }
  | { kind: "manual" };

export interface PlaybookMatcher {
  /** 加载所有已安装 pack 的 playbook trigger 规则 */
  load(playbooks: PlaybookDefinition[]): void;

  /** 对事件进行匹配，返回按优先级排序的匹配列表 */
  match(event: CwEvent): CwEventMatch[];
}
```

---

## 二、ObjectStore（`src/planes/data/object-store.ts`）

```typescript
/** 对象类型实例，字段由 Pack 的 ObjectType YAML 定义 */
export interface CwObject {
  id: string;
  _type: string; // ObjectType 名称，e.g. "WorkOrder"
  _version: number; // 乐观锁版本号
  _createdAt: Date;
  _updatedAt: Date;
  [field: string]: unknown;
}

export interface ObjectQueryOptions {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: { field: string; dir: "asc" | "desc" };
}

export interface ObjectStore {
  /** 查询对象列表 */
  query(
    typeName: string,
    opts?: ObjectQueryOptions,
  ): Promise<{ items: CwObject[]; nextCursor?: string }>;

  /** 获取单个对象 */
  get(typeName: string, id: string): Promise<CwObject | null>;

  /** 创建对象（自动生成 id） */
  create(typeName: string, data: Record<string, unknown>): Promise<CwObject>;

  /** 更新对象字段（部分更新） */
  update(typeName: string, id: string, patch: Record<string, unknown>): Promise<CwObject>;

  /** 删除对象 */
  delete(typeName: string, id: string): Promise<void>;

  /** 执行 ActionType（如 acknowledge_alarm，内部触发 FSM 转换） */
  executeAction(
    typeName: string,
    id: string,
    actionType: string,
    params: Record<string, unknown>,
    ctx: PlaybookStepContext,
  ): Promise<Record<string, unknown>>;
}
```

---

## 三、OntologyEngine（`src/planes/data/ontology-engine.ts`）

```typescript
export interface ObjectTypeDefinition {
  name: string;
  description?: string;
  pack: string;
  fields: FieldDefinition[];
  actions: ActionTypeDefinition[];
  fsm?: FsmDefinition;
}

export interface FieldDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "enum" | "ref";
  required?: boolean;
  enumValues?: string[];
  refType?: string; // 当 type=ref 时，引用的 ObjectType 名称
  default?: unknown;
}

export interface ActionTypeDefinition {
  name: string;
  description?: string;
  params: FieldDefinition[];
  /** FSM 触发的状态转换 */
  fsmTransition?: { from: string | string[]; to: string };
}

export interface FsmDefinition {
  field: string; // 存储状态的字段名（e.g. "status"）
  initial: string;
  states: string[];
  transitions: Array<{ from: string | string[]; event: string; to: string }>;
}

export interface OntologyEngine {
  /** 从已安装 Pack 加载所有 ObjectType 定义 */
  loadFromPacks(packs: LoadedPack[]): Promise<void>;

  /** 获取 ObjectType 定义 */
  getType(name: string): ObjectTypeDefinition | null;

  /** 列举所有已知 ObjectType */
  listTypes(): ObjectTypeDefinition[];

  /** 验证数据是否符合 ObjectType schema */
  validate(typeName: string, data: Record<string, unknown>): ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}
```

---

## 四、PlaybookEngine（`src/planes/orch/playbook-engine.ts`）

```typescript
export interface PlaybookDefinition {
  id: string;
  name: string;
  description?: string;
  pack: string;
  trigger: EventTrigger;
  priority: number;
  steps: PlaybookStep[];
}

export type PlaybookStep =
  | AtomicStep // 原子操作：调用函数/工具
  | LlmStep // LLM 决策步骤
  | HitlStep // 人工审批
  | ConditionStep // 条件分支
  | ParallelStep // 并行执行
  | PlaybookStep[]; // 嵌套（复合）

export interface AtomicStep {
  kind: "atomic";
  id: string;
  fn: string; // 函数引用，e.g. "objects.create", "kb.search", "connector.opcua.read"
  params: Record<string, unknown>;
  output?: string; // 将结果存储到 context 的变量名
}

export interface LlmStep {
  kind: "llm";
  id: string;
  prompt: string; // 支持 {{context.variable}} 插值
  model?: string; // 不填用配置的默认模型
  output: string; // 将 LLM 回答存储到 context 的变量名
}

export interface HitlStep {
  kind: "hitl";
  id: string;
  message: string; // 发给审批人的消息（支持插值）
  channel?: string; // 覆盖 hitl.default_channel
  options: string[]; // 审批选项，e.g. ["approve", "reject", "defer"]
  output: string; // 将选择结果存储到 context 的变量名
  timeout_seconds?: number;
}

export interface ConditionStep {
  kind: "condition";
  id: string;
  if: string; // context 表达式，e.g. "{{context.severity}} === 'high'"
  then: PlaybookStep[];
  else?: PlaybookStep[];
}

export interface ParallelStep {
  kind: "parallel";
  id: string;
  branches: PlaybookStep[][];
}

/** Playbook 执行上下文，在 step 间传递 */
export interface PlaybookStepContext {
  runId: string;
  playbookId: string;
  triggerEvent?: CwEvent;
  variables: Record<string, unknown>;
  objectStore: ObjectStore;
  kb: KnowledgeBase;
  robot: RobotInfo;
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

export interface StepLog {
  stepId: string;
  status: "running" | "completed" | "failed" | "waiting";
  startedAt: Date;
  completedAt?: Date;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface PlaybookEngine {
  /** 加载 Playbook 定义 */
  loadFromPacks(packs: LoadedPack[]): Promise<void>;

  /** 列举所有可用 Playbook */
  list(): PlaybookDefinition[];

  /** 触发 Playbook 执行（异步，返回 run_id） */
  trigger(
    playbookId: string,
    input: Record<string, unknown>,
    ctx?: Partial<PlaybookStepContext>,
  ): Promise<PlaybookRun>;

  /** 获取运行状态 */
  getRun(runId: string): Promise<PlaybookRun | null>;

  /** 列举历史运行 */
  listRuns(opts: { playbookId?: string; status?: string; limit?: number }): Promise<PlaybookRun[]>;

  /** 向 HITL 节点提交决策 */
  submitHitlDecision(
    runId: string,
    stepId: string,
    decision: string,
    comment?: string,
  ): Promise<void>;
}
```

---

## 五、Pack 加载器（`src/pack-loader/loader.ts`）

```typescript
export interface PackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  license: string;
  dependencies?: string[];
  provides: {
    objectTypes: string[];
    playbooks: string[];
    actionTypes: string[];
  };
}

export interface LoadedPack {
  manifest: PackManifest;
  path: string;
  objectTypes: ObjectTypeDefinition[];
  playbooks: PlaybookDefinition[];
}

export interface PackLoader {
  /** 从路径加载一个 Pack，验证 manifest 和依赖 */
  load(packPath: string): Promise<LoadedPack>;

  /** 加载配置中列出的所有已安装 Pack */
  loadInstalled(config: CwPackConfig): Promise<LoadedPack[]>;

  /** 安装 Pack（从 Nexus 下载或本地路径） */
  install(source: string, config: CwPackConfig): Promise<LoadedPack>;

  /** 列举已加载的 Pack */
  list(): LoadedPack[];
}
```

---

## 六、A2A 接口（`src/interfaces/a2a/types.ts`）

> 遵循 Google A2A 协议标准，这里只列出 ClaWorks 自定义的扩展部分。

```typescript
/** ClaWorks A2A Agent Card 扩展 */
export interface CwAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: CwAgentSkill[];
  /** ClaWorks 扩展字段 */
  claworks?: {
    role: "monolith" | "twin" | "ops" | "nexus";
    packs: string[];
    objectTypes: string[];
    playbooks: string[];
  };
}

export interface CwAgentSkill {
  id: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>; // JSON Schema
  outputSchema?: Record<string, unknown>;
}
```

---

## 七、共享类型（`src/kernel/types.ts`）

```typescript
export interface RobotInfo {
  name: string;
  role: "monolith" | "twin" | "ops" | "nexus";
  version: string;
  endpoint: string;
}

export interface KnowledgeBase {
  search(query: string, opts?: { limit?: number; namespace?: string }): Promise<KbResult[]>;
  ingest(text: string, opts?: { namespace?: string; source?: string }): Promise<void>;
}

export interface KbResult {
  id: string;
  score: number;
  text: string;
  source?: string;
  namespace?: string;
}
```
