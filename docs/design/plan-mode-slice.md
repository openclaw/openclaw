# Plan Mode Upstream Design Slice

> 2026-04-06 | Phase 1 设计文档
> 目标：最小 Plan Mode 正式 upstream，不做重 UI，不做 multi-agent 联动

---

## 1. 现有基础设施（已存在，不需重建）

### 1.1 runtimeMode 字段

**文件**: `src/config/sessions/types.ts:57`

```typescript
// AcpSessionRuntimeOptions 中已有：
runtimeMode?: string; // 支持 "plan", "normal", "auto"
```

### 1.2 before_tool_call Hook

**文件**: `src/plugins/hooks.ts` + `src/plugins/types.ts`

- 完整的插件生命周期 hook 系统
- `runBeforeToolCall(event)` → 可返回 `{ cancel: true, reason: string }` 拦截工具
- 已有测试：`hooks.before-tool-call.test.ts`

### 1.3 Task Registry

**文件**: `src/tasks/task-registry.ts` + `task-registry.types.ts`

- `TaskRecord` 支持 queued/running/succeeded/failed/cancelled/timed_out/lost
- `TaskEventRecord` 追踪状态变化
- `TaskRuntime = "subagent" | "acp" | "cli" | "cron"`
- 完整的观察者模式和持久化（SQLite store）

### 1.4 Session Metadata

**文件**: `src/config/sessions/types.ts`

- `SessionEntry` 有大量可扩展字段
- `acp` 字段承载 ACP 元信息

---

## 2. 最小 Plan Mode 设计

### 2.1 概念模型

```
用户请求 → Agent 判断复杂度
  ├─ 简单 → 直接执行（normal mode）
  └─ 复杂 → 进入 plan mode
       ├─ 生成计划（todo list + task breakdown）
       ├─ 用户确认
       │   ├─ 确认 → exit plan mode → 执行
       │   └─ 修改 → 更新计划 → 再次确认
       └─ 执行中 → 可暂停/恢复
```

### 2.2 需要新增的部分

#### A. Plan Mode 状态管理（极小改动）

**位置**: `SessionEntry` 或 `AcpSessionRuntimeOptions`

```typescript
// 方案 A：复用已有的 runtimeMode
runtimeMode?: "plan" | "normal" | "auto"; // 已有，只需明确枚举

// 方案 B（最小改动）：在 SessionEntry 新增
planMode?: {
  active: boolean;
  planContent?: string;    // markdown 格式的计划
  todos?: PlanTodo[];       // todo 列表
  enteredAt?: number;       // 进入时间
  confirmedAt?: number;     // 确认时间
};

type PlanTodo = {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done" | "skipped";
};
```

**推荐方案 A** — 复用 `runtimeMode`，最小改动，符合已有架构。

#### B. 5 个工具/命令

| 工具              | 作用               | 实现                                               |
| ----------------- | ------------------ | -------------------------------------------------- |
| `enter_plan_mode` | 进入计划态         | 设置 `runtimeMode = "plan"`，清空当前 plan context |
| `exit_plan_mode`  | 退出计划态         | 设置 `runtimeMode = "normal"`                      |
| `todo_write`      | 写/更新 todo 列表  | 存到 session metadata                              |
| `task_create`     | 从计划创建执行任务 | 复用 Task Registry                                 |
| `task_update`     | 更新任务状态       | 复用 Task Registry                                 |

#### C. Mutation Gate（基于 before_tool_call）

```typescript
// 在 before_tool_call hook 中注册
const MUTATION_TOOLS = [
  "apply_patch",
  "exec",
  "edit",
  "write",
  "feishu_doc.write",
  "sessions_send",
];

function planModeGate(event: BeforeToolCallEvent): BeforeToolCallResult | undefined {
  if (getSessionRuntimeMode() !== "plan") return undefined;
  if (MUTATION_TOOLS.includes(event.toolName)) {
    return {
      cancel: true,
      reason:
        `Plan mode active. Tool "${event.toolName}" is blocked until plan is confirmed. ` +
        `Use exit_plan_mode to proceed, or update the plan with todo_write.`,
    };
  }
  return undefined;
}
```

### 2.3 数据流

```
[enter_plan_mode]
  → session.runtimeMode = "plan"
  → before_tool_call hook 激活 mutation gate

[todo_write]
  → 写入 session.metadata.planTodos
  → 可多次调用更新

[exit_plan_mode]（用户确认后由 agent 调用）
  → session.runtimeMode = "normal"
  → mutation gate 解除

[task_create]（exit_plan_mode 后）
  → 复用 Task Registry 创建 TaskRecord
  → 每个 todo item → 一个 task

[task_update]
  → 更新 TaskRecord.status
```

### 2.4 Resume 行为

- session 恢复时检查 `runtimeMode`
- 如果是 `"plan"`，agent 看到当前 plan 内容和 todos
- agent 可以继续规划或等待用户确认

---

## 3. 实现切片（建议拆分）

### Slice 1：runtimeMode 枚举 + session 读写

- 明确 `runtimeMode` 的合法值
- `getSessionRuntimeMode()` / `setSessionRuntimeMode()` 工具函数
- 测试

### Slice 2：5 个工具注册

- `enter_plan_mode` / `exit_plan_mode` / `todo_write` / `task_create` / `task_update`
- 工具定义 + schema
- 基础测试

### Slice 3：Mutation Gate

- 注册 before_tool_call hook
- 拦截列表可配置
- 结构化拒绝返回
- 测试

### Slice 4：Plan 持久化 + Resume

- plan 内容存入 session metadata
- resume 时恢复 plan 状态
- 集成测试

---

## 4. 不在范围内（Phase 2+）

- 工具元数据驱动的 gate（V2）
- 复杂 UI / plan 可视化
- Multi-agent plan 协调
- Plan diff / version history
- 自动复杂度判断（先手动触发）

---

## 5. 验收标准

- [ ] `enter_plan_mode` 后，mutation tools 被拦截
- [ ] 拦截返回结构化原因 + 下一步建议
- [ ] `exit_plan_mode` 后正常执行
- [ ] 中断/恢复后能看到 plan 内容和 mode 状态
- [ ] 现有工具不受 normal mode 影响
- [ ] 测试覆盖 gate + resume 路径

---

🦞 _复用已有骨架，最小改动 upstream_
