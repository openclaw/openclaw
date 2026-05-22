# ClawTwin 架构深化：具体化设计（Architecture Deepening）

> **版本**：v1.0 · 2026-05-12  
> **地位**：对三份权威文档（INDUSTRIAL-FOUNDRY-ARCHITECTURE / PLATFORM-BUSINESS-CONTROL-PLANE / DESIGN-COHERENCE-AUDIT）的**具体化与填空**。  
> **原则**：不重述已有抽象，直接给出「之前有原则、没有实例」的部分——Schema、状态图、分层模型、飞轮机制。

---

## 一、Playbook YAML 完整规范（权威 Schema）

### 1.1 顶层结构

```yaml
# ontology/playbooks/<playbook_id>.yaml
playbook_id: string # 唯一标识，kebab-case
display_name: string
version: semver # 1.2.0；run 实例锁定版本
description: string
scope:
  type: enum # station | multi_station | organization
  station_ids: list[string] # 仅 station 时生效；空 = 当前 JWT scope
trigger:
  type: enum # schedule | event | user | threshold
  # schedule:
  cron: string # "0 7 * * *"
  # event:
  event_type: string # alarm.created | workorder.done | ...
  condition: jexl_expr # "alarm.priority in ['P1','P2']"
  # threshold:
  signal_object: string # Object Type api_name
  metric_field: string
  operator: enum # gt | lt | gte | lte
  threshold: number
  window_seconds: int
policy_ref: string # 引用 core/policy/<id>.yaml；null = 默认 Policy
steps: list[PlaybookStep]
outcome_measurement: # 可选；建立 OutcomeEvent
  delay_minutes: int # 执行完后多久采样
  metric_object: string # 采样哪个 Object Type
  metric_field: string
  comparison: enum # before_vs_after | absolute
  auto_evaluate: bool # 是否自动写 outcome_type
```

### 1.2 PlaybookStep 类型

```yaml
# type: function
- id: string
  type: function
  function: string # Function Type api_name（已注册）
  input_mapping: # Jinja2/JEXL 表达式；{{trigger.*}} / {{steps.<id>.output.*}}
    equipment_id: "{{trigger.alarm.equipment_id}}"
    window_hours: 24
  cache_ttl_seconds: int # 结果缓存；0 = 不缓存
  on_failure: enum # abort | skip | compensate
  requires: list[string] # 前置 step id

# type: action
- id: string
  type: action
  action: string # Action Type api_name
  input_mapping:
    title: "{{steps.diagnose.output.value.summary}}"
  idempotency_key: jexl_expr # "{{run_id}}-draft"；保证幂等
  risk_level: enum # low | medium | high；覆盖 Action 默认值
  on_failure: abort | skip | compensate

# type: hitl_checkpoint（人在环等待点）
- id: string
  type: hitl_checkpoint
  assignee_role: string # 角色名；从 Marking 解析出具体用户
  message_template: string # 引用飞书卡片模板 id
  context_objects: # 卡片里要展示的 Object id 列表（表达式）
    - "{{steps.diagnose.output.value.equipment_id}}"
  timeout_hours: int
  on_timeout: enum # escalate | abort | auto_approve
  on_approval: continue # 继续下一步
  on_rejection: abort_with_reason

# type: notification
- id: string
  type: notification
  channel: enum # feishu | webhook | sms
  template: string # 消息模板 id
  recipients: # 角色 or 用户 id
    roles: [station_operator]
  on_failure: skip # 通知失败不影响主流程

# type: parallel（并行分支）
- id: string
  type: parallel
  branches: list[list[PlaybookStep]] # 每个分支独立步骤列表
  join: enum # all_success | any_success | first_done

# type: sub_playbook（子编排复用）
- id: string
  type: sub_playbook
  playbook_id: string
  version: string # 固定版本；否则用当前最新
  input_mapping: object
```

### 1.3 完整示例：告警 → 诊断 → 工单 → 审批 → 飞书通知

```yaml
playbook_id: p1-alarm-to-approved-workorder
display_name: P1 告警自动处理
version: 1.0.0
scope:
  type: station
trigger:
  type: event
  event_type: alarm.created
  condition: "alarm.priority == 'P1'"
policy_ref: default-station-policy
steps:
  - id: diagnose
    type: function
    function: DiagnoseEquipment
    input_mapping:
      equipment_id: "{{trigger.alarm.equipment_id}}"
      context_window_hours: 2
    cache_ttl_seconds: 0
    on_failure: skip # 诊断失败不阻塞，工单照创

  - id: draft_workorder
    type: action
    action: CreateWorkOrder
    input_mapping:
      equipment_id: "{{trigger.alarm.equipment_id}}"
      title: "{{steps.diagnose.output.value.summary | default('P1 告警处理')}}"
      description: "{{steps.diagnose.output.value.reasoning_trace}}"
      source_alarm_id: "{{trigger.alarm.id}}"
    idempotency_key: "{{run_id}}-create"
    on_failure: abort

  - id: await_approval
    type: hitl_checkpoint
    assignee_role: station_supervisor
    message_template: workorder-approval-card-v2
    context_objects:
      - "{{steps.draft_workorder.output.workorder_id}}"
      - "{{trigger.alarm.equipment_id}}"
    timeout_hours: 2
    on_timeout: escalate

  - id: notify_confirmed
    type: notification
    channel: feishu
    template: workorder-confirmed-msg
    recipients:
      roles: [station_operator, station_supervisor]
    on_failure: skip

outcome_measurement:
  delay_minutes: 90
  metric_object: Equipment
  metric_field: health_score
  comparison: before_vs_after
  auto_evaluate: true
```

### 1.4 PlaybookRun 状态机

```
created
  │ trigger matched / user started
  ▼
running
  │ hitl_checkpoint reached
  ▼
waiting_for_human ──(callback: approve)──► running
                  ──(callback: reject)───► failed[reason=rejected]
                  ──(timeout: escalate)──► escalating ──► waiting_for_human[new_assignee]
                  ──(timeout: abort)─────► failed[reason=timeout]
  │ all steps done
  ▼
completed_pending_outcome    (若配置 outcome_measurement)
  │ delay elapsed → auto_evaluate
  ▼
done[outcome_type: recovered|degraded|unchanged|unknown]

任意步骤 abort:
running ──► failed[step_id, reason]
```

---

## 二、Digital Twin 状态模型（Twin State Model）

ClawTwin 的「数字孪生」不是噱头，而是**四层状态叠加**：

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 4: Predictive State（预测层）                           │
│  · PredictBreach(equipment, hours=2) → FunctionResult        │
│  · MOIRAI 时序预测；结果缓存在 FunctionResultCache（Redis）   │
│  · 过期自动重算（TTL 由 Function YAML 声明）                  │
├──────────────────────────────────────────────────────────────┤
│ Layer 3: Semantic State（语义层）                             │
│  · EquipmentStatus（8 态 enum）                              │
│  · health_score（Computed Property，由 ComputeHealthScore）  │
│  · active_alarms_count、latest_workorder_state              │
│  · 存 PostgreSQL ObjectStore（Equipment 表 + 关联）          │
│  · 是 Studio / AI 决策的主要消费层                           │
├──────────────────────────────────────────────────────────────┤
│ Layer 2: Shadow State（影子层）                               │
│  · 最新一组传感器读数（temperature, pressure, vibration...）  │
│  · 存 Redis Hash（key: shadow:{equipment_id}）               │
│  · OPC-UA Bridge → Kafka → Nexus consumer 持续刷新           │
│  · 超时判定：>heartbeat_timeout_seconds → 状态切 data_loss    │
├──────────────────────────────────────────────────────────────┤
│ Layer 1: Historical State（历史层）                           │
│  · EquipmentReading Object（时序表，TimescaleDB）             │
│  · 保留策略：原始数据 90d，分钟聚合 1y，小时聚合 3y           │
│  · 供 MOIRAI 训练、趋势分析、合规报告                         │
└──────────────────────────────────────────────────────────────┘
```

**关键规则**

- Studio 详情页默认读 **Layer 3 + Layer 2**（语义 + 影子）；读数历史读 **Layer 1**。
- `DiagnoseEquipment` Function 可读全四层（通过 `get_equipment_context` 拉综合包）。
- **写操作只能通过 Action Type 改 Layer 3**；Layer 2 只能由 Bridge/Pipeline 写；Layer 4 只读。
- `decision_package` 缓存 = Layer 3 + Layer 2 + Layer 4 的快照（Redis，10ms 响应）。

---

## 三、知识架构（Knowledge Architecture）

### 3.1 四层知识模型（L0–L3）完整定义

```
L0：通用工程知识（Universal）
    · 来源：设备厂商手册、国际标准（ISO 14224、API RP 579）、教科书
    · 更新：平台版本发布时由 ClawTwin 团队维护（SaaS 推送 or Pack 更新）
    · 权限：所有角色可读；不可客户修改
    · 示例：「离心泵轴承振动超标 15mm/s 为警告级」

L1：行业域知识（Industry Domain）
    · 来源：行业规范（SY/T 油气标准、ISA-18.2 告警管理）、Industry Pack 附带
    · 更新：Pack 版本迭代
    · 权限：所有角色可读；Industry Pack 管理员可更新
    · 示例：「天然气压缩站进气压力异常处理流程」

L2：企业规程（Company Policy）
    · 来源：公司 SOP、内部维修规程、HSE 制度
    · 更新：KB Admin 角色（经审核）
    · 权限：本公司所有站场；跨公司 Marking 隔离
    · 示例：「本公司压缩机检修必须提前 48h 申请作业票」

L3：站级知识（Station-Specific）
    · 来源：已完成工单的自动摄入（Knowledge Flywheel）+ 人工上传
    · 更新：自动（via Pipeline）+ 站级 KB Admin
    · 权限：仅本站场；Marking 强制
    · 示例：「C-003 压缩机 2024Q3 振动超标根因：地脚螺栓松动」
```

### 3.2 检索策略（Retrieval Strategy）

Playbook step 或 Function 调用时可声明检索策略：

```yaml
retrieval_strategy:
  mode: enum # layered | semantic_k | graph_expand | full_context
  layers: [L3, L2, L1, L0] # 检索优先级（高 → 低）；mode=layered 时用
  max_chunks: int # 最多返回 chunk 数
  min_score: float # 相似度阈值（pgvector cosine）
  graph_hops: int # mode=graph_expand 时从 Equipment 展开几跳
  include_citations: true
```

**四种模式**

| 模式           | 适用场景               | 说明                                          |
| -------------- | ---------------------- | --------------------------------------------- |
| `layered`      | 标准诊断/建议          | 从 L3 开始，命中不足则向上扩展层              |
| `semantic_k`   | 快速相似搜索           | top-k 余弦，不区分层                          |
| `graph_expand` | 根因分析、多设备关联   | 从 Equipment Ontology Link 扩展邻居，再做 RAG |
| `full_context` | 报告生成、班次交接摘要 | 全上下文注入（限长上下文 LLM）                |

### 3.3 知识冲突解决规则

```
优先级：L3 > L2 > L1 > L0
例外：L0/L1 标注 MANDATORY 的安全规程不可被 L2/L3 覆盖

KB Document 字段：
  conflict_policy: enum   # override | append | flag_for_review
  mandatory: bool         # 安全规程标记；检索时必须包含
  valid_until: date | null
  superseded_by: doc_id | null
```

---

## 四、组织层级模型（Organization Hierarchy）

### 4.1 四级层次

```
Organization（租户根）
  tenant_id / display_name / tier(enterprise|smb|trial)
  └── Region（可选中间层，用于多站分区）
        region_id / name / parent_org_id
        └── Station（部署单元，Marking 边界）
              station_id / name / region_id
              └── Equipment / Alarm / WorkOrder / ...（业务对象）
```

**设计约束**

- **Marking 以 Station 为最小单元**；Region/Organization 层级用于聚合权限，不细化到字段级。
- 跨站查询必须显式声明 `InvocationContext.station_ids: [s1, s2]`，且调用者必须持有这些站的 Marking。
- Organization 级别的「晨报汇总」、「KPI 跨站对比」是 Function Type（`BuildOrgBriefing`），结果按各站 Marking 过滤后聚合，不暴露原始行级数据。

### 4.2 用户角色与 Marking 对应

```
sys_admin          → Organization 级；可管理用户/租户/Pack
org_admin          → Organization 级；可管理 Region/Station 配置
station_supervisor → Station 级；可审批工单、管理本站用户
station_engineer   → Station 级；可创建工单、操作设备诊断
station_operator   → Station 级；可确认告警、查看数据
kb_admin           → Organization 或 Station 级；可管理 L2/L3 知识
readonly_analyst   → 可指定范围读取（报表/审计）

继承规则：
  上级角色不自动获得下级所有权限（职责分离原则）
  sys_admin 可临时提权进入任意站场（必须留审计记录）
```

### 4.3 多租户数据隔离策略

| 层次            | 隔离方式                                                 |
| --------------- | -------------------------------------------------------- |
| Organization 间 | 完全行级隔离（`tenant_id` WHERE 子句 + Casbin 外层）     |
| Region 间       | Marking 策略（软隔离，sys_admin 可见）                   |
| Station 间      | `station_id` Marking（同 Organization 内跨站需显式授权） |
| OT 数据         | Bridge service token 只允许写指定 `station_id`           |

---

## 五、平台飞轮（Platform Flywheel）

平台随使用变得更好，而不是需要人工持续维护。四条飞轮路径：

```
┌──────────────────────────────────────────────────────────────────┐
│                    Platform Flywheel                             │
│                                                                  │
│  ① 知识飞轮（已有基础）                                          │
│     WorkOrder.done                                               │
│       → Knowledge Flywheel Pipeline                             │
│       → L3 KBDocument（工单根因/处理经验）                       │
│       → 下次类似告警时 DiagnoseEquipment 检索到                  │
│       → 诊断更准确 → 工单处理时间缩短                            │
│                                                                  │
│  ② AI 评估飞轮（新建）                                           │
│     OutcomeEvent（measured_at + metric_snapshot）                │
│       → EvalPipeline（weekly）                                   │
│       → EvalRun Object（per Function Type）                      │
│       → 低分 Function → 人工 Review → Prompt 版本 bump          │
│       → 新版 Function → 更好的诊断 → 更多 recovered 结果        │
│                                                                  │
│  ③ Playbook 优化飞轮（新建）                                     │
│     PlaybookRun history（success_rate / avg_duration / hitl_rate）│
│       → Studio「Playbook 健康」面板（可观测）                    │
│       → 业务管理员调整 trigger condition / timeout / 步骤        │
│       → Playbook 新版本发布 → 旧版 run 不受影响                  │
│                                                                  │
│  ④ Industry Pack 迭代飞轮（Phase C）                             │
│     多站场运行经验（anonymized OutcomeEvent + EvalRun 统计）     │
│       → ClawTwin 团队提炼 L1 新知识 / CompositeAlarmRule 模板    │
│       → Industry Pack 新版本发布                                 │
│       → 客户通过 Pack Registry 升级 → 即刻获益                   │
└──────────────────────────────────────────────────────────────────┘
```

**飞轮不应是全自动的**——每条飞轮的关键环节都保留人工确认节点，避免错误知识自我强化：

| 飞轮      | 自动部分                      | 人工确认点                                       |
| --------- | ----------------------------- | ------------------------------------------------ |
| 知识      | WorkOrder → L3 Draft 自动生成 | KB Admin 审核发布（PublishKBL3Knowledge Action） |
| AI 评估   | EvalPipeline 自动跑           | 人工 review 低分 Function + 决定 Prompt 升级     |
| Playbook  | 运行数据自动统计              | 管理员手动调整参数后发布新版本                   |
| Pack 迭代 | 统计数据自动聚合              | ClawTwin 团队审核 + Pack 版本 review             |

---

## 六、事件分类（Event Taxonomy）

统一的事件体系，避免各模块各发各的。

### 6.1 Event Envelope（所有事件的通用结构）

```python
@dataclass
class PlatformEvent:
    event_id: str            # UUID
    event_type: str          # 点分层级，见下表
    schema_version: str      # "1.0"
    occurred_at: datetime
    producer: str            # "nexus.alarm_engine" / "nexus.hitl"
    tenant_id: str
    station_id: str | None   # None = org-level event
    trace_id: str            # 与 InvocationContext.trace_id 一致
    payload_ref: str | None  # 大负载存 Object Store 时的引用
    payload: dict            # 小负载直接内联（< 4KB）
```

### 6.2 事件类型目录（权威命名）

```
设备与数据
  equipment.reading.ingested        OPC-UA 读数入库
  equipment.status.changed          设备状态变化
  equipment.quarantine.flagged      读数入隔离区
  equipment.health.updated          health_score 重算

告警
  alarm.created                     新告警
  alarm.acknowledged                已确认
  alarm.shelved                     已搁置
  alarm.resolved                    已关闭
  alarm.composite.triggered         复合告警规则命中

工单
  workorder.created                 工单创建
  workorder.state.changed           工单状态变化（参数带 from/to）
  workorder.evidence.attached       证据上传
  workorder.done                    完成（触发 Knowledge Flywheel）

Playbook
  playbook.run.started
  playbook.run.step.completed
  playbook.run.waiting_for_human
  playbook.run.resumed
  playbook.run.completed
  playbook.run.failed

知识
  kb.document.ingested              知识文档入库
  kb.document.published             L3 知识审核发布
  kb.document.superseded            知识被更新替代

AI
  ai.function.invoked               Function 被调用
  ai.function.completed             Function 完成（含 confidence）
  ai.evalrun.completed              EvalPipeline 完成

系统
  platform.pack.installed           Industry Pack 安装
  platform.pack.upgraded
  platform.schema.migrated          Ontology schema 变更
```

---

## 七、API 演进策略（Ontology & API Versioning）

### 7.1 Ontology 变更分类

```
向后兼容（可随时部署）：
  · 新增可选字段
  · 新增 Object Type / Action Type / Function Type
  · 新增 Link Type
  · 新增枚举值（末尾追加）

需版本窗口（需公告 + 双写过渡期）：
  · 重命名字段（提供 alias 过渡）
  · 枚举值废弃（标记 deprecated，保留 1 个 minor 版本）
  · 修改字段类型（需 alembic migration + 数据回填）

破坏性（需主版本号 + 客户通知）：
  · 删除字段 / Object Type
  · 修改必填 → 不可为空语义
  · 修改 Link 方向
```

### 7.2 API schema_version 传播

- 所有 HTTP 响应带 `"schema_version": "2026.5"`（年月格式）。
- MCP tools/list 返回的 inputSchema 版本与 Ontology YAML hash 绑定。
- 客户 AgentRuntime 可订阅 `platform.schema.migrated` 事件，自动重拉工具清单。

### 7.3 Alembic + Ontology 联动规则

```
每次修改 ontology/object_types/*.yaml：
  1. 运行 pnpm ontology:check（检查向后兼容性）
  2. 若需迁移：生成 alembic revision，注释标明 ontology_change_id
  3. 同步更新 schema_version.yaml
  4. CI 门控：schema check + migration check（已有 /v1/bootstrap/db/migration）
```

---

## 八、通知与告警路由（Notification Routing）

### 8.1 通知层次

```
Level 1: 实时推送（毫秒级）
  · SSE /v1/sse/station/{id} → Studio 在线用户
  · 适合：读数异常、新告警

Level 2: 即时消息（秒级）
  · 飞书 Bot 消息/卡片 → 相关角色
  · 适合：P1/P2 告警、工单审批请求、班次交接

Level 3: 汇总推送（分钟~小时）
  · 飞书晨报卡片（定时 Playbook）
  · 适合：KPI 日报、值班交接摘要、设备健康周报

Level 4: 合规记录（异步）
  · 写入 audit_logs + OutcomeEvent
  · 不依赖即时通道；供后续查阅
```

### 8.2 NotificationPolicy（每个 Station 可配置）

```yaml
# ontology/notification_policies/<station_id>.yaml
station_id: ST-001
rules:
  - event_type: alarm.created
    condition: "alarm.priority == 'P1'"
    channels: [feishu_immediate, sse]
    recipients:
      roles: [station_supervisor, station_operator]
    cooldown_seconds: 60 # 同设备同类型告警防刷屏
  - event_type: alarm.created
    condition: "alarm.priority == 'P2'"
    channels: [feishu_card]
    recipients:
      roles: [station_operator]
    batch_window_seconds: 300 # 5分钟内批量合并一条消息
  - event_type: workorder.state.changed
    channels: [feishu_card]
    recipients:
      from_workorder_field: assignee_id # 动态：工单指定人
```

---

## 九、Developer / Implementer 体验（DX）

### 9.1 本地开发环境（标准化）

```bash
# 最小 Phase A 开发环境（单命令启动）
cd clawtwin-platform/platform-api
CLAWTWIN_AUTH_DEV=1 \
CLAWTWIN_WORKORDER_DB=1 \
CLAWTWIN_ALARM_DB=1 \
CLAWTWIN_AUDIT_DB=1 \
uvicorn main:app --reload

# 带前端
cd clawtwin-studio/refine-clawtwin
VITE_CLAWTWIN_MSW=0 \
VITE_CLAWTWIN_API_BASE=http://127.0.0.1:8000 \
pnpm dev

# 检查 Ontology schema 合法性
python -m clawtwin.ontology.check

# 跑目标测试
cd clawtwin-platform/platform-api
python -m pytest tests/test_equipment_route.py -v
```

### 9.2 新增 Object Type 标准流程（5 步）

```
Step 1: 写 YAML
  ontology/object_types/maintenance_record.yaml
  · 必填：api_name, display_name, properties, source_of_truth_strategy
  · 可选：traits（继承 BaseAsset）, computed_properties, links

Step 2: 跑 schema check
  python -m clawtwin.ontology.check --type maintenance_record
  → 输出：向后兼容性检查 + 必填字段验证

Step 3: 生成 Alembic revision
  python -m clawtwin.ontology.gen_migration maintenance_record
  → 生成 platform-api/alembic/versions/XXXX_maintenance_record.py

Step 4: 应用迁移
  cd platform-api && alembic upgrade head

Step 5: 验证
  curl http://127.0.0.1:8000/v1/objects/types/maintenance_record
  → 返回 Object Type schema（已自动暴露）
```

### 9.3 Industry Pack 开发流程

```
初始化：
  clawtwin pack init --id my-pack --industry chemical

开发：
  · 在 ontology/ 写 Object/Action/Function YAML
  · 在 pipelines/ 写 Pipeline YAML
  · 在 playbooks/ 写 Playbook YAML
  · 在 knowledge/ 放 L0/L1 文档（PDF/MD）

验证：
  clawtwin pack validate          # schema + 依赖检查
  clawtwin pack test              # 运行 tests/ 下冒烟测试

安装到本地：
  clawtwin pack install --env dev my-pack/

打包发布：
  clawtwin pack build → my-pack-1.0.0.clawtwin
  clawtwin pack publish（需 Pack Registry Token）
```

---

## 十、完整性检查矩阵（更新版 v2）

**在 DESIGN-COHERENCE-AUDIT §四 基础上，补入 6 项新检查：**

| #   | 问题                                 | 本文覆盖                         |
| --- | ------------------------------------ | -------------------------------- |
| 13  | **Playbook 失败了怎么补偿回滚？**    | §一.1.2 `on_failure: compensate` |
| 14  | **数字孪生的「实时状态」是什么？**   | §二 Twin State Model 四层        |
| 15  | **知识冲突了谁赢？**                 | §三.3 冲突解决规则               |
| 16  | **HQ 如何看所有站场的汇总？**        | §四 Organization Hierarchy       |
| 17  | **平台用久了会变得更好吗？**         | §五 Platform Flywheel 四条路径   |
| 18  | **通知发给谁、怎么发、怎么防刷屏？** | §八 Notification Routing         |

---

## 十一、铁律扩展（待团队确认后写入 SKILL.md）

```
【铁律 39】Twin State 四层读写规则
  Layer 3（语义）只能通过 ActionExecutor 写
  Layer 2（影子）只能通过 Bridge/Pipeline 写
  Layer 4（预测）只读；TTL 到期自动 invalidate
  禁止：业务代码直接写 Redis shadow 或直接 UPDATE equipment.health_score

【铁律 40】Event 必须使用 Platform Event Envelope
  任何跨模块/跨服务事件必须携带 event_id / trace_id / occurred_at
  禁止：裸 dict 作为事件跨模块传递（无法追踪 + 无法 replay）

【铁律 41】知识上线必须经过层级审核
  L3（站级）：站级 KB Admin 审核
  L2（企业）：org KB Admin 审核
  L1/L0（行业/通用）：仅 ClawTwin 团队或 Pack maintainer
  禁止：普通用户直接 POST /v1/kb/documents 后即刻被检索（需审核 flag）

【铁律 42】Playbook 版本冻结
  每个 PlaybookRun 启动时锁定 playbook_version
  运行中禁止 hot-patch Playbook 定义
  禁止：scheduler 每次 re-read YAML 而不锁版本（可能引发不一致运行）

【铁律 43】通知渠道降级
  飞书不可达时，关键告警（P1）必须有降级通道（短信 / 站内 SSE / 邮件）
  notification_policy 中 P1 告警必须声明 fallback_channel
  禁止：单点依赖飞书通道发关键安全告警
```

---

_本文件在 Phase B 开始前应与 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` 作一次整合评审，决定哪些内容可以合并进主权威文档。_
