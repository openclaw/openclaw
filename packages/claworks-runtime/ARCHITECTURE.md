# ClaWorks 架构说明

## 三层架构

ClaWorks 采用"核心不知业务，业务不改核心"的三层 Pack 架构：

```
┌─────────────────────────────────────────────────────────────┐
│  第三层：领域 Pack（claworks-packs/industrial / 用户自定义）   │
│  工业/行业专属能力：equipment.* shift.* maintenance.* ...    │
├─────────────────────────────────────────────────────────────┤
│  第二层：通用业务 Pack（claworks-packs/base）                  │
│  行业通用能力：notify.* approval.* task.* audit.* ...        │
├─────────────────────────────────────────────────────────────┤
│  第一层：核心 Runtime（packages/claworks-runtime）            │
│  机器人大脑：EventKernel · CapabilityRegistry · PackLoader   │
│             PlaybookEngine · DataPlane · OrchPlane           │
└─────────────────────────────────────────────────────────────┘
```

---

### 第一层：核心 Runtime（`packages/claworks-runtime`）

机器人的"大脑"，只包含通用、业务无关的能力。
不直接依赖任何业务逻辑或外部服务配置。

**核心子系统：**

| 子系统             | 位置                              | 职责                                               |
| ------------------ | --------------------------------- | -------------------------------------------------- |
| EventKernel        | `kernel/event-kernel.ts`          | 事件发布、Playbook 匹配、Circuit Breaker、幂等去重 |
| CapabilityRegistry | `kernel/capability-registry.ts`   | 能力注册/调用/权限检查（宪法四层）                 |
| PlaybookEngine     | `planes/orch/playbook-engine.ts`  | Playbook 加载、触发、HITL 挂起、状态持久化         |
| PackLoader         | `pack-loader/index.ts`            | 从磁盘加载 Pack（YAML + JS 入口混合支持）          |
| DataPlane          | `planes/data/`                    | ObjectStore、KB、Ontology、数据库                  |
| IngressRouter      | `kernel/ingress.ts`               | 入口决策（放行/观察/拒绝/意图路由）                |
| Scheduler          | `kernel/scheduler.ts`             | Cron Playbook 调度                                 |
| ConstitutionV2     | `kernel/robot-constitution-v2.ts` | 四层权限：autoAllow / hitlRequired / deny / audit  |

**核心能力域（L0–L9）：**

| 层级 | 域              | 代表能力                                            |
| ---- | --------------- | --------------------------------------------------- |
| L0   | `system.*`      | system.health, system.describe, system.reload_packs |
| L1   | `environment.*` | environment.time, environment.context               |
| L2   | `kb.*`          | kb.search, kb.ingest, kb.learn                      |
| L3   | `perceive.*`    | perceive.intent, perceive.message, perceive.entity  |
| L4   | `task.*`        | task.run, task.status                               |
| L5   | `object.*`      | object.create, object.update, object.query          |
| L6   | `event.*`       | event.publish, event.subscribe                      |
| L7   | `learn.*`       | learn.from_observation, learn.schedule              |
| L8   | `evolve.*`      | evolve.discover_interface, evolve.generate_playbook |
| L9   | `message.*`     | message.route（兜底）                               |

**扩展能力域（extension-capabilities.ts）：**

`robot.*` · `health.*` · `memory.*` · `schedule.*` · `constitution.*` ·
`comms.*` · `observe.*` · `a2a.*` · `notify.*` · `approval.*` · `audit.*` ·
`research.*` · `agent.*`

**新增子系统（v1.1+）：**

| 子系统         | 位置                            | 职责                                            |
| -------------- | ------------------------------- | ----------------------------------------------- |
| EvolveEngine   | `kernel/evolve-engine.ts`       | LLM 驱动的 Playbook 自动生成与热部署            |
| ScaffoldEngine | `kernel/scaffold-engine.ts`     | 强模型预生成脚手架，提升弱模型可靠性            |
| ResearchAgent  | `agents/research-agent.ts`      | 多源并行搜索（KB + 网络 + 事件）+ LLM 综合分析  |
| ReactExecutor  | `agents/react-executor.ts`      | ReAct 迭代推理循环（Reason → Act → Observe）    |
| ParallelStep   | `planes/orch/playbook-types.ts` | Playbook 并行分支执行（超时/失败策略/结果合并） |

---

### 第二层：通用业务 Pack（`claworks-packs/base`）

所有行业通用的业务 Playbook，通过 Pack SDK 注册，可被替换或覆盖。

**Playbook 数量：** 59 个（含 IM 消息处理、HITL、自治、告警、知识库、设置向导等）

**关键 Playbook：**

| Playbook                       | 触发事件                 | 用途                          |
| ------------------------------ | ------------------------ | ----------------------------- |
| `comms_on_im_message`          | `im.message_received`    | IM 消息入口 → 意图分类 → 路由 |
| `setup_wizard`                 | manual                   | 首次配置引导                  |
| `onboarding_welcome`           | `system.runtime.started` | 开机欢迎                      |
| `autonomy_on_heartbeat`        | schedule (每5分钟)       | 自治心跳检查                  |
| `kb_auto_ingest_on_completion` | `playbook.completed`     | Playbook 完成后自动 KB 学习   |
| `self_heal_on_degraded`        | `system.anomaly`         | 自愈响应                      |

---

### 第三层：领域 Pack（`claworks-packs/industrial` 等）

特定行业的业务能力，由官方或生态伙伴提供。
可以被用户创建的自定义 Pack 完全覆盖。

**Playbook 数量：** 16 个

**工业域能力（`industrial/src/capabilities.ts`）：**

| 域              | 能力                                                 | 说明          |
| --------------- | ---------------------------------------------------- | ------------- |
| `shift.*`       | shift.start, shift.end, shift.summary                | 班次管理      |
| `incident.*`    | incident.report, incident.escalate                   | 事故上报/升级 |
| `equipment.*`   | equipment.list, equipment.status, equipment.diagnose | 设备管理      |
| `maintenance.*` | maintenance.schedule, maintenance.complete           | 维保管理      |
| `production.*`  | production.kpi, production.shift_report              | 生产统计      |
| `safety.*`      | safety.hazard_report, safety.lockout_check           | 安全管理      |

---

## 扩展点

| 扩展类型        | 文件位置                                           | 说明                |
| --------------- | -------------------------------------------------- | ------------------- |
| 自定义 Playbook | `claworks-packs/my-pack/ontology/playbooks/`       | YAML，无需代码      |
| 自定义 Skill    | `claworks-packs/my-pack/src/skills.ts`             | TypeScript 函数     |
| 自定义能力      | `claworks-packs/my-pack/src/capabilities.ts`       | TypeScript 能力     |
| 自定义规则      | `claworks-packs/my-pack/ontology/decision_tables/` | YAML 决策表         |
| 机器人行为      | `claworks.robot.json`                              | JSON 配置           |
| Intent 映射     | Pack `PackContribution.intentMappings`             | 业务意图 → 事件类型 |
| Action 处理器   | Pack `PackContribution.actionHandlers`             | 覆盖 CRUD 默认行为  |

---

## 关键流程

### IM 消息处理流程

```
飞书消息
  → im-bridge.ts → im.message_received 事件
    → EventKernel.publish
      → PlaybookMatcher 匹配 comms_on_im_message.yaml
        → perceive.intent（意图分类）
          ├─ LLM + structuredOutput（优先）
          └─ perceive.message 规则引擎（降级）
            → publish_event_from_intent
              ├─ IntentRegistry（Pack 注册的业务 intent）
              ├─ 系统 intent 映射（hitl_approve / kb_query）
              └─ 通用 intent.{name} 兜底
                → EventKernel.publish 业务事件
                  → Playbook 触发执行
                    → notify.dispatch → 飞书回复
```

### Pack 加载流程

```
createClaworksRuntime()
  → loadPersistedInstalled()           ← 从磁盘读上次已安装列表
  → PackLoader.loadInstalled(config)
    ├─ 加载 base Pack（Playbook + 能力）
    ├─ 加载 industrial Pack（Playbook + 能力）
    └─ 加载用户 Pack（~/.claworks/packs/ / ./packs/）
  → OntologyEngine.loadFromPacks()     ← 加载 ObjectType 定义
  → PlaybookEngine.loadFromPacks()     ← 加载 Playbook YAML
  → CapabilityRegistry 注册能力        ← core + extension + pack
  → ConstitutionV2 注入权限策略
```

### 能力调用流程

```
Playbook YAML 的 action: capability.invoke
  → StepExecutor → CapabilityRegistry.invoke(id, ctx, params)
    → ConstitutionV2 权限检查
      ├─ autoAllow → 直接执行
      ├─ hitlRequired → 挂起等待人工审批
      ├─ deny → 抛出 CapabilityDeniedError
      └─ 通过 → handler(ctx, params)
```

---

## 可靠性机制

| 机制                   | 位置                 | 说明                             |
| ---------------------- | -------------------- | -------------------------------- |
| Circuit Breaker        | `event-kernel.ts`    | Playbook 失败3次后冷却60秒       |
| 幂等去重               | `kernel/dedup.ts`    | 滑动窗口去重（默认60秒）         |
| Outbox 重试            | `kernel/outbox.ts`   | Playbook 触发失败自动入队重试    |
| HITL 超时扫描          | `runtime.ts` 定时器  | 每30秒扫描过期审批自动解除       |
| `on_failure: continue` | `playbook-engine.ts` | 非关键步骤失败后继续执行         |
| EventKernel 并发限制   | `event-kernel.ts`    | 每 Playbook 最多10并发（可配置） |

---

## 配置示例

```json
{
  "robot": { "name": "claworks-01", "role": "monolith" },
  "data": {
    "database_url": "sqlite://~/.claworks/robot.db",
    "kb_provider": "memory-core"
  },
  "packs": {
    "installed": ["base", "process-industry"]
  },
  "kernel": {
    "playbook_concurrency": 10,
    "scheduler_timezone": "Asia/Shanghai"
  }
}
```
