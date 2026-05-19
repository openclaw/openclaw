# Python → TypeScript 迁移指南

## 原则：迁移概念和接口，不逐行翻译代码

Python 侧已有 11,372 行业务核心代码，其中：
- **YAML 文件**（本体/Playbook）：语言无关，100% 直接复用
- **核心逻辑**：用 TypeScript 重写，直接调 OpenClaw API，比 Python 版更简洁
- **数据库结构**：参考 Python Alembic 迁移，用 Drizzle ORM 重建

---

## 模块映射表

### ObjectStore

```python
# Python (core/object_store/postgres.py)
class PostgresObjectStore:
    async def load(self, type_name: str, id: str) -> dict
    async def save(self, type_name: str, data: dict) -> str
    async def query(self, type_name: str, filters: dict) -> list[dict]
```

```typescript
// TypeScript (src/planes/data/object-store.ts)
export class ObjectStore {
  static async open(databaseUrl: string): Promise<ObjectStore>
  async query(typeName: string, filters?: Record<string, unknown>): Promise<unknown[]>
  async save(typeName: string, data: Record<string, unknown>): Promise<string>
  async executeAction(actionRef: string, params: unknown, ctx: PlaybookContext): Promise<unknown>
}
```

**数据库**：Python 用 SQLAlchemy + PostgreSQL，TypeScript 用 Drizzle ORM + SQLite（开发）/ PostgreSQL（生产）。

迁移 Alembic 表结构（9个迁移）→ Drizzle schema：

```typescript
// src/planes/data/schema.ts
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const equipment = sqliteTable("equipment", {
  id: text("id").primaryKey(),
  stationId: text("station_id").notNull(),
  equipmentType: text("equipment_type").notNull(),
  status: text("status").notNull().default("normal"),  // 8 态，参考 equipment.yaml
  tag: text("tag"),
  createdAt: integer("created_at", { mode: "timestamp" }),
});

export const alarms = sqliteTable("alarms", {
  id: text("id").primaryKey(),
  equipmentId: text("equipment_id"),
  priority: integer("priority").notNull(),             // ISA-18.2: 1-4
  status: text("status").notNull().default("active"),  // active/acknowledged/shelved/resolved
  triggeredAt: integer("triggered_at", { mode: "timestamp" }),
  acknowledgedBy: text("acknowledged_by"),
});

export const workOrders = sqliteTable("work_orders", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  state: text("state").notNull().default("draft"),     // FSM: draft→in_progress→done/rejected
  workType: text("work_type"),                         // maintenance/inspection/repair
  stationId: text("station_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
});
// ... 参考 Python alembic migrations 001-009
```

---

### OntologyEngine

```python
# Python (ontology/loader.py)
class OntologyLoader:
    def load_object_types(self, pack_dir: str) -> dict[str, ObjectTypeDef]
    def validate_instance(self, type_name: str, data: dict) -> ValidationResult
```

```typescript
// TypeScript (src/planes/data/ontology-engine.ts)
import { parse as parseYaml } from "yaml";  // 已在 OpenClaw 中使用

export class OntologyEngine {
  static async load(packsDir: string): Promise<OntologyEngine>
  getObjectType(apiName: string): ObjectTypeDef | undefined
  validateInstance(typeName: string, data: unknown): ValidationResult
  async reload(packId: string): Promise<void>  // 热重载：写 YAML → 调此方法
}
```

**YAML 文件直接复用**（零迁移成本）：

```bash
# 从 clawtwin-platform 迁移 YAML 文件
cp -r /Users/power/Projects/clawtwin-platform/platform-api/ontology/object_types/*.yaml \
      /Users/power/Projects/claworks-packs/base/ontology/object_types/
cp -r /Users/power/Projects/clawtwin-platform/platform-api/ontology/playbooks/*.yaml \
      /Users/power/Projects/claworks-packs/base/ontology/playbooks/
```

---

### EventRouter → EventKernel

```python
# Python (core/event_router/__init__.py, bus.py, matcher.py)
class EventBus:
    def publish(self, event: Event) -> None
    def subscribe(self, pattern: str, handler: Callable)

class PlaybookMatcher:
    def match(self, event: Event) -> list[PlaybookDef]
```

```typescript
// TypeScript (src/kernel/event-bus.ts)
// 利用 OpenClaw registerService 生命周期

export class EventKernel {
  constructor(deps: {
    store: ObjectStore;
    engine: OntologyEngine;
    playbookEngine: PlaybookEngine;
  }) {}

  async start(): Promise<void>
  async stop(): Promise<void>
  async publish(event: ClaworksEvent): Promise<void>
  subscribe(pattern: EventPattern, handler: EventHandler): Unsubscribe
}

// 挂载到 OpenClaw（extensions/claworks-robot/index.ts）：
api.registerService({
  id: "claworks-kernel",
  start: async (ctx) => {
    const kernel = new EventKernel({ store, engine, playbookEngine });
    await kernel.start();
    return { stop: () => kernel.stop() };
  },
});
```

---

### PlaybookEngine

```python
# Python (core/playbook_engine/executor.py, 876 行)
class PlaybookExecutor:
    async def run(self, playbook: PlaybookDef, trigger_ctx: TriggerContext) -> PlaybookRun
    async def _execute_step(self, step: StepDef, run_ctx: RunContext) -> StepResult
    async def _resume_hitl(self, run_id: str, decision: HITLDecision) -> PlaybookRun
```

```typescript
// TypeScript (src/planes/orch/playbook-engine.ts)
export class PlaybookEngine {
  static async load(packsDir: string): Promise<PlaybookEngine>

  async trigger(playbookId: string, payload: unknown): Promise<PlaybookRunHandle>
  async resume(runId: string, decision: HITLDecision): Promise<void>
  async reload(packId?: string): Promise<void>
}

// 步骤执行器（src/planes/orch/step-executor.ts）
export class StepExecutor {
  constructor(private api: OpenClawPluginApi) {}  // 直接持有 api，用 OpenClaw 能力

  async execute(step: StepDef, ctx: RunContext): Promise<StepResult> {
    switch (step.type) {
      case "llm_reason":
        // 直接调 OpenClaw LLM，不造轮子
        return this.api.runtime.llm.complete({
          messages: [{ role: "user", content: renderTemplate(step.prompt, ctx) }],
          purpose: `claworks.playbook.${step.id}`,
        });

      case "hitl":
        // 直接用 OpenClaw managedFlows
        const flow = this.api.runtime.tasks.managedFlows.fromContext(ctx.runId);
        await flow.setWaiting({ flowId: ctx.runId, currentStep: step.id, waitJson: step.config });
        // 通过 channel 发通知
        await this.api.runtime.agent.runEmbeddedAgent({
          sessionId: `claworks:hitl:${ctx.runId}`,
          prompt: renderTemplate(step.message, ctx),
        });
        return { status: "waiting" };

      case "notify":
        // 直接用 OpenClaw channel
        await this.api.runtime.agent.runEmbeddedAgent({
          sessionId: `claworks:notify:${Date.now()}`,
          prompt: renderTemplate(step.message, ctx),
        });
        return { status: "completed" };

      // ... 其他步骤类型
    }
  }
}
```

**Python executor.py 的模板语法**（`{{ expr }}`）直接复用：

```typescript
// src/planes/orch/template.ts
export function renderTemplate(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
    // 沙箱求值，与 Python 版本兼容
    return String(evalInSandbox(expr, ctx));
  });
}
```

---

### ExtensionRegistry → Pack Loader

```python
# Python (core/extension_registry/__init__.py, 341行)
class ExtensionRegistry:
    def load_from_dir(self, packs_dir: str) -> None
    def get_object_types(self) -> list[ObjectTypeDef]
    def get_playbooks(self) -> list[PlaybookDef]
    def get_connectors(self) -> list[ConnectorDef]
```

```typescript
// TypeScript (src/planes/data/pack-loader.ts)
// 类比 OpenClaw 的 PluginRegistry，但面向 Pack

export class PackLoader {
  static async loadFromDir(packsDir: string): Promise<PackRegistry>

  getObjectTypes(): ObjectTypeDef[]
  getPlaybooks(): PlaybookDef[]
  getConnectors(): ConnectorDef[]
  async install(packId: string, nexusUrl: string): Promise<void>
  async reload(packId?: string): Promise<void>
}
```

---

### HITL FSM（WorkOrder 状态机）

Python 版完整 FSM 直接用 TypeScript 重写，逻辑完全一致：

```typescript
// src/planes/orch/workorder-fsm.ts
export type WorkOrderState = "draft" | "in_progress" | "waiting_approval" | "done" | "rejected";
export type WorkOrderAction = "start" | "submit_approval" | "approve" | "reject" | "complete";

export const WORKORDER_TRANSITIONS: Record<WorkOrderState, Partial<Record<WorkOrderAction, WorkOrderState>>> = {
  draft:            { start: "in_progress" },
  in_progress:      { submit_approval: "waiting_approval", complete: "done" },
  waiting_approval: { approve: "in_progress", reject: "rejected" },
  done:             {},
  rejected:         {},
};

export function transition(
  current: WorkOrderState,
  action: WorkOrderAction,
): WorkOrderState {
  const next = WORKORDER_TRANSITIONS[current]?.[action];
  if (!next) {
    throw new WorkOrderFSMError({ current, action, allowed: Object.keys(WORKORDER_TRANSITIONS[current] ?? {}) });
  }
  return next;
}
```

---

## 迁移执行顺序

```bash
Week 3-4:
  1. 建立 src/planes/data/schema.ts（参考 Python 001-009 迁移）
  2. 实现 ObjectStore（Drizzle）
  3. 实现 OntologyEngine（yaml 包）
  4. 迁移 YAML 文件到 claworks-packs/base/
  5. 单元测试覆盖

Week 5-6:
  6. 实现 EventKernel（event-bus + matcher）
  7. 挂载到 claworks-robot registerService
  8. 单元测试覆盖

Week 7-9:
  9. 实现 PlaybookEngine（loader + step-executor）
  10. 实现 HITLGate（复用 managedFlows）
  11. 实现 WorkOrder FSM
  12. 端到端测试：告警 → Playbook → 工单 → HITL 通知
```
