# ClaWorks 里程碑路线图

**版本**：v1.0  
**日期**：2026-05-19

---

## 总体时间线

```
M0  M1  M2  M3  M4  M5  M6  M7  M8
│   │   │   │   │   │   │   │   │
├───┤                               Fork + 基础设施
    ├───────┤                       Phase 1: 核心三平面
            ├───────┤               Phase 2: 完整机器人
                    ├───────┤       Phase 3: A2A 网格
                            ├───┤  Phase 4: 生态开放
```

---

## Phase 0：Fork + 重命名（Week 1-2）

**目标**：在 `/Users/power/Projects/claworks` 建立清洁的 ClaWorks 工程基础。

### 里程碑 M0.1：Fork 初始化（Day 1-3）

```
任务清单：
□ git clone https://github.com/openclaw/openclaw.git /Users/power/Projects/claworks
□ git remote rename origin upstream      ← 保留上游，用于追踪升级
□ git remote add origin <claworks-repo>  ← 自己的仓库
□ 修改 package.json: name="claworks", bin.claworks=./claworks.mjs
□ 修改 README.md（品牌）
□ 修改 docs/ 里的产品名称
□ 建立 UPSTREAM-SYNC.md（记录同步策略）
```

**验证**：`pnpm install && pnpm dev` 能启动，`claworks start` 命令生效。

### 里程碑 M0.2：目录结构初始化（Day 4-7）

```
新建目录（不改现有 src/）：
□ src/kernel/          ← EventKernel（空目录 + TODO.md）
□ src/planes/data/     ← DataPlane（空目录 + TODO.md）
□ src/planes/orch/     ← OrchPlane（空目录 + TODO.md）
□ src/interfaces/a2a/  ← A2A Server（空目录 + TODO.md）
□ src/interfaces/mcp/  ← MCP Server（空目录 + TODO.md）
□ packs/               ← Pack 安装目录（类比 skills/）
```

**验证**：目录存在，现有 OpenClaw 功能不受影响。

### 里程碑 M0.3：独立 Extension 仓库（Day 7-14）

```
新建仓库：/Users/power/Projects/openclaw-claworks-extension/
□ 迁入 extensions/claworks/（cw_* 工具）
□ 迁入 packages/claworks-client/（HTTP transport）
□ 迁入 packages/claworks-plugin-bridge/（result adapter）
□ 迁入 extensions/clawtwin/、clawops/、clawnexus/（合并整理）
□ 建立独立 package.json，peerDependency: openclaw@>=2026.5.0
□ 发布为 npm 包（供官方 openclaw 用户安装）
```

**验证**：`openclaw plugins install @claworks/openclaw-extension` 生效。

---

## Phase 1：核心三平面（Week 3-10）

**目标**：最小可运行机器人——能接收事件，匹配 Playbook，执行步骤，发通知。

### 里程碑 M1.1：ObjectStore + OntologyEngine（Week 3-5）

参考 Python `core/object_store/` 和 `ontology/` 用 TypeScript 重写。

```
src/planes/data/object-store.ts     ← SQLite（开发）/ PostgreSQL（生产）
  - ObjectStore.open(databaseUrl)
  - store.query(typeName, filters?)
  - store.save(typeName, data)
  - store.executeAction(actionRef, params, ctx)

src/planes/data/ontology-engine.ts  ← YAML loader
  - OntologyEngine.load(packsDir)
  - engine.getObjectType(apiName)
  - engine.validateInstance(typeName, data)
  - engine.reload(packId)           ← 热重载

src/planes/data/kb.ts               ← 知识库（文本检索，Phase 1 子串；Phase 2 向量）
  - KB.ingest(document, metadata)
  - KB.search(query, filters?)
```

**数据库迁移**：用 Drizzle ORM（TypeScript-first），参考 Python Alembic 的 9 个迁移设计表结构。

**验证**：
```bash
pnpm test src/planes/data/  # 覆盖 ObjectStore CRUD、Ontology YAML 加载、KB 检索
```

### 里程碑 M1.2：EventKernel（Week 5-7）

参考 Python `core/event_router/` 重写。

```
src/kernel/event-bus.ts         ← EventBus
  - EventBus.publish(event)
  - EventBus.subscribe(pattern, handler)
  优先级队列：CRITICAL > HIGH > NORMAL > LOW

src/kernel/matcher.ts           ← 事件→Playbook 匹配
  - Matcher.match(event) → PlaybookDef[]
  - 支持：event_type 精确匹配 / 通配符 / 语义 fallback

src/kernel/scheduler.ts         ← Cron 定时触发（复用 OpenClaw cron hooks）
  - Scheduler.register(cronExpr, eventType, payload)

src/kernel/outbox.ts            ← 可靠投递
  - Outbox.enqueue(delivery)    ← 持久化，保证至少一次投递
  - Outbox.flush()
```

**挂载方式**（复用 OpenClaw registerService）：

```typescript
// extensions/claworks-robot/index.ts
api.registerService({
  id: "claworks-kernel",
  start: async (ctx) => {
    const kernel = new EventKernel({ store, engine, playbookEngine });
    await kernel.start();
    return { stop: () => kernel.stop() };
  },
});
```

**验证**：
```bash
pnpm test src/kernel/  # 覆盖 EventBus、Matcher、Scheduler、Outbox
```

### 里程碑 M1.3：PlaybookEngine（Week 7-10）

参考 Python `core/playbook_engine/executor.py`（876行）重写，直接调 OpenClaw LLM。

```
src/planes/orch/playbook-engine.ts   ← Playbook 加载 + 执行
  - PlaybookEngine.load(packsDir)
  - PlaybookEngine.trigger(playbookId, payload)
  - PlaybookEngine.reload(packId)    ← 热重载

src/planes/orch/step-executor.ts     ← 步骤执行（8种步骤类型）
  步骤类型：
  ① llm_reason   → api.runtime.llm.complete()
  ② subagent     → api.runtime.subagent.run()
  ③ skill        → api.runtime.agent.runEmbeddedAgent()
  ④ action       → ObjectStore.executeAction()
  ⑤ notify       → channel 发飞书/Telegram 通知
  ⑥ hitl         → HITLGate.suspend()（等待人类审批）
  ⑦ playbook     → 递归触发子 Playbook
  ⑧ connector    → ConnectorManager.invoke()

src/planes/orch/hitl-gate.ts         ← HITL 挂起/恢复
  - HITLGate.suspend(runId, step, notifyConfig)
  - HITLGate.resume(runId, decision)
  复用 api.runtime.tasks.managedFlows

src/planes/orch/function-executor.ts ← 单次 LLM 推理（非流式）
```

**Playbook YAML 格式**（直接复用 Python 侧已有的 YAML）：

```yaml
# packs/base/playbooks/alarm-to-workorder.yaml
id: alarm-to-workorder
version: "1.0"
trigger:
  event_type: AlarmTriggered
  condition: "trigger.payload.priority >= 2"
steps:
  - id: diagnose
    type: llm_reason
    prompt: "分析告警 {{ trigger.payload.tag }} 的可能原因"
    max_tokens: 512
  - id: create_workorder
    type: action
    ref: WorkOrder.create
    params:
      title: "{{ steps.diagnose.summary }}"
      priority: "{{ trigger.payload.priority }}"
  - id: notify
    type: notify
    channel: feishu
    message: "已自动创建工单：{{ steps.create_workorder.id }}"
```

**验证**：运行完整 alarm→workorder Playbook 端到端测试。

---

## Phase 2：完整机器人产品（Week 11-18）

**目标**：可以交付给第一个客户的完整产品。

### 里程碑 M2.1：OT Connector 框架（Week 11-13）

```
src/interfaces/connectors/connector-manager.ts
  - ConnectorManager.start(connectorId, config)   ← 启动子进程
  - ConnectorManager.stop(connectorId)
  - ConnectorManager.invoke(connectorId, method, params)

  子进程通信：stdio NDJSON（与 OpenClaw MCP stdio 模式相同）
  {type: "event", event_type: "AlarmTriggered", payload: {...}}

首批 Connector：
  connectors/opcua/      ← Python 子进程，OPC-UA 协议
  connectors/modbus/     ← Python 子进程，Modbus TCP
  connectors/mqtt/       ← TypeScript，MQTT broker 订阅
  connectors/rest-poll/  ← TypeScript，HTTP 轮询
```

### 里程碑 M2.2：A2A Server（Week 13-15）

```
src/interfaces/a2a/agent-card.ts      ← GET /.well-known/agent.json
  {
    "name": "claworks-robot",
    "description": "ClaWorks industrial robot",
    "capabilities": ["WorkOrder", "Alarm", "Equipment"],
    "endpoints": { "tasks": "/a2a/tasks" }
  }

src/interfaces/a2a/task-handler.ts    ← POST /a2a/tasks
  - 接收 A2A Task → 转为内部 Event → EventKernel.publish()
  - 返回 taskId + 状态

src/interfaces/a2a/client.ts          ← 主动发起 A2A 请求
  - A2AClient.send(targetUrl, task)
  - 用于 Playbook 步骤 type: a2a_delegate

挂载：api.registerHttpRoute({ path: "/.well-known/agent.json", ... })
```

### 里程碑 M2.3：Nexus Pack 仓库后端（Week 15-17）

```
新建：claworks-nexus/ 仓库（FastAPI，独立部署）

API（兼容 ClaWHub 形状，参考 src/infra/clawhub.ts）：
GET  /api/packages?family=claworks-pack&q=alarm
GET  /api/packages/{slug}
GET  /api/packages/{slug}/versions/{v}
GET  /api/packages/{slug}/versions/{v}/artifacts/{hostKey}

ClaWorks 客户端（src/infra/nexus.ts，参考 src/infra/clawhub.ts）：
claworks packs install base
claworks packs install process-industry
claworks packs list
claworks packs update
```

### 里程碑 M2.4：Studio Web UI（Week 17-18，基础版）

迁移并升级现有 `clawtwin-studio`：

```
studio/
├── pages/
│   ├── Dashboard.tsx     ← 机器人状态总览
│   ├── Objects.tsx       ← ObjectStore 数据浏览
│   ├── Playbooks.tsx     ← Playbook 运行记录 + HITL 操作
│   ├── Ontology.tsx      ← 本体浏览器（YAML 可视化）
│   └── Connectors.tsx    ← Connector 状态
```

---

## Phase 3：多机器人 A2A 网格（Week 19-24）

**目标**：多个 ClaWorks 实例通过 A2A 互联，处理跨域业务。

### 里程碑 M3.1：A2A 服务发现

```
claworks.json 配置多机器人拓扑：
{
  "a2a": {
    "peers": [
      { "name": "pipeline-robot", "url": "http://pipeline:8001" },
      { "name": "dispatch-robot", "url": "http://dispatch:8002" }
    ]
  }
}
```

### 里程碑 M3.2：跨机器人 Playbook

```yaml
# Playbook 步骤：委托给另一台机器人
- id: dispatch_to_pipeline
  type: a2a_delegate
  target: pipeline-robot
  task: "检查泵出口到输油管段的压力变化"
  wait_result: true
```

### 里程碑 M3.3：MCP 工具对外暴露

```
src/interfaces/mcp/server.ts
  tools/list  → 返回机器人所有 cw_* 工具的 MCP 工具描述
  tools/call  → 代理到 EventKernel 或直接执行
```

---

## Phase 4：生态开放（Week 25+）

### 里程碑 M4.1：Extension Pack SDK

```
packages/claworks-sdk/
  definePackEntry()     ← 类比 OpenClaw definePluginEntry()
  PackManifest 类型     ← claworks.pack.json schema
  ObjectTypeBuilder     ← 构建本体定义的类型安全 builder
  PlaybookBuilder       ← 构建 Playbook 的类型安全 builder
```

### 里程碑 M4.2：行业 Pack 发布

```
claworks-packs/ 仓库（独立，可商业化）：
  packs/base/               ← 开源（基础本体：Equipment, Alarm, WorkOrder）
  packs/process-industry/   ← 开源（流程工业）
  packs/oilgas/             ← 商业（油气行业）
  packs/mro/                ← 商业（MRO 维修）
```

### 里程碑 M4.3：自我构建工具

```
通过 OpenClaw（IM 对话）教 ClaWorks 机器人扩展自己：
  cw_write_playbook     ← 写 Playbook YAML + 热重载
  cw_define_object_type ← 写 Ontology YAML + 热重载
  cw_install_pack       ← 安装 Pack（需重启）
```

---

## 依赖关系图

```
Phase 0（Fork+结构）
  └── Phase 1.1（ObjectStore+Ontology）
        └── Phase 1.2（EventKernel）
              └── Phase 1.3（PlaybookEngine）   ← 最小可运行机器人
                    ├── Phase 2.1（OT Connector）
                    ├── Phase 2.2（A2A Server）
                    ├── Phase 2.3（Nexus）
                    └── Phase 2.4（Studio）      ← 可交付客户
                          ├── Phase 3（A2A 网格）
                          └── Phase 4（生态开放）
```

---

## 不做的事（明确范围）

- ❌ 重写 OpenClaw 的 Gateway/Plugin/Config/CLI/Providers/Channels（直接继承）
- ❌ 在 OpenClaw 官方仓库里开发 ClaWorks 功能
- ❌ 把 Studio 改造到 OpenClaw WebUI（两个不同 UX 场景）
- ❌ 同时开发 Phase 1 和 Phase 2（串行，先打好基础）
- ❌ 在没有单元测试的情况下推进下一个里程碑
