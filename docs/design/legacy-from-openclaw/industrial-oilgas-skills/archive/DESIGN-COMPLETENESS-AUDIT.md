# 设计完成度审计报告

**版本**：3.0，2026-05-11（工业场景补全后终态）  
**目的**：评估 ClawTwin Phase A 设计的完整性，识别歧义/遗漏/冲突，为并行开发提供清单  
**评分标准**：

- ✅ 完整：有权威设计文档，无歧义，可直接开发
- ⚠️ 基本：有设计但细节不足，开发时需要判断
- ❌ 缺失：没有足够设计，开发会走弯路
- 🔴 冲突：多处定义不一致，必须先统一

> **最新更新（v3.0）**：工业场景审计补全（INDUSTRIAL-SCENARIOS-COMPLETE.md），新增  
> 生产数据/班次管理/巡检管理三大模块设计，设备状态枚举扩展为 8 种，工单类型统一为 7 种。

---

## 一、总体完成度仪表盘（v3.0 终态）

```
模块                         完成度    说明
────────────────────────────────────────────────────────────────────────
[后端核心]
  Auth + 用户管理             ✅ 95%   实现细节完整，可直接开发
  Equipment + Station        ✅ 90%   Schema 完整（状态枚举已扩展为8种）
  OT 数据摄入管道             ✅ 85%   核心设计完整，Kafka 消息格式已定义
  知识库 RAG                  ✅ 88%   三层融合搜索完整，**pgvector / `kb_chunks`** 设计完整（铁律 20）
  告警管理 ISA-18.2           ✅ 85%   搁置/确认/KPI/升级全设计，代码需实现
  工单 FSM + HITL             ✅ 92%   状态机完整，work_type 枚举已统一
  Pulse Engine                ⚠️ 78%  设计思路完整，代码级实现待补充
  Decision Package            ✅ 80%   Schema 已定义，API 路径已裁定
  AI Jobs 异步                ✅ 88%   设计完整，task_id 模式清晰
  Scheduler                   ⚠️ 75%  任务清单完整（含巡检触发/告警升级），helpers 需实现
  Admin API                   ✅ 82%   路由完整定义，实现细节开发时决定
  SSE 实时推流                ✅ 82%   事件类型已定，连接管理设计完整

  ★ 生产数据                  ✅ 90%   4 个 API + DB schema + Studio 页面全设计
  ★ 班次管理                  ✅ 90%   5 个 API + DB schema + 飞书推送 + 接班确认
  ★ 巡检管理                  ✅ 85%   3 个 API + DB schema + 工单集成 + Skill

[数据库]
  DB Schema（主表）           ✅ 95%   DESIGN-FINAL-LOCK §二a 为权威，含3张新表
  Alembic 迁移                ⚠️ 65%  有 setup 指南和迁移代码框架，需实际生成
  TimescaleDB 连续聚合        ⚠️ 68%  设计有，SQL 模板在 DESIGN-COMPLETION.md
  **pgvector** / `kb_chunks`   ✅ 88%   与 LOCK §二、SIMPLIFICATION 一致；独立 Milvus 仅 Phase C

[前端 Studio]
  Auth + Shell 骨架           ✅ 88%   组件结构完整
  DeviceIntelPanel            ✅ 92%   布局规则清晰，Props 明确
  AlarmQueuePanel             ✅ 82%   ISA-18.2 KPI 面板设计已加入
  WorkOrder 看板               ✅ 88%   设计完整，工单类型枚举已统一
  ProductionPage              ✅ 85%   生产数据录入表单设计完整
  ShiftHandoverPage           ✅ 85%   交接班页面含 AI 摘要 + 接班确认
  InspectionPage              ✅ 82%   巡检计划列表 + 逾期提醒
  3D 孪生（Babylon.js）       ⚠️ 65%  框架有，3D 内容依赖实际资产（Phase B 重点）
  知识库 UI                   ⚠️ 70%  基本设计，上传流程 Phase A 可简化
  Admin UI                    ✅ 80%   路由结构完整，页面内容覆盖 §三十三
  MSW Mock 体系               ⚠️ 55%  有规范，需补充新 API mock 数据文件

[集成]
  飞书 Webhook                ✅ 90%   鉴权 + 事件处理设计完整（仅 card.action）
  飞书 Bot 卡片格式            ✅ 78%   工单/P1告警/晨报/交接班卡片模板完整
  OpenClaw Skill 接入         ✅ 85%   Tool API 契约完整，7个 Skill 设计完毕
  OPC-UA Bridge               ✅ 85%   独立设计文档（OPCUA-BRIDGE-DESIGN.md）

[UI 架构]
  状态管理分层                ✅ 92%   新文档已定义（STUDIO-UI-ARCHITECTURE.md）
  SSE 连接管理                ✅ 88%   useSSEConnection 设计完整
  组件分层规则                ✅ 92%   Layer 1-4 定义清晰
  3D 集成模式                 ✅ 80%   TwinSceneManager 模式完整

[商业/安全]
  License 架构                ✅ 92%   COMMERCIAL-ARCHITECTURE.md 完整
  开源策略（修正版）          ✅ 95%   BUSL 1.1 策略已修正
  ABAC 权限模型               ✅ 92%   require_station/require_role 完整
  审计日志                   ✅ 88%   触发点已定义

[工业场景覆盖度]
  实时监控/告警/工单          ✅ 92%   核心运营闭环完整
  生产数据管理                ✅ 90%   ★ v3.0 新增
  班次交接管理                ✅ 88%   ★ v3.0 新增（含接班确认铁律）
  巡检管理                   ✅ 85%   ★ v3.0 新增（Phase A 简版，Phase B 增强）
  作业许可证（PTW）           ⚠️ 55%  Phase A 预留字段，Phase B 完整实现
  能耗/碳排放                 ⚠️ 45%  有规划（CRITICAL-REVIEW §3.3），Phase B
  HSE 事件管理                ⚠️ 30%  Phase B，当前无设计

加权总体完成度：约 87%（v3.0 工业场景补全后，Phase A 可以全面启动）
────────────────────────────────────────────────────────────────────────
  v1.0（初始）：78%
  v2.0（文档冲突裁定后）：98%（但漏掉工业场景）
  v3.0（工业场景补全后）：87% → 这是真实的"可开发完成度"，更诚实

  注：v2.0 的 98% 是"已有设计文档的模块"完成度；v3.0 引入新模块后重新计算加权分
```

> **v3.0 评估结论**（2026-05-11）：  
> 设备状态/工单类型枚举统一，生产数据/班次/巡检三大工业场景补全，API 参考手册同步更新。  
> Phase A 所有核心场景均有完整设计，**可以全面启动并行开发**。  
> 剩余 13% 不完整度主要是：MSW Mock 文件（需开发时补充）、PTW 完整实现（Phase B）、能耗/HSE（Phase B）。
>
> | 原缺失项                         | 补全状态  | 补全位置                              |
> | -------------------------------- | --------- | ------------------------------------- |
> | MSW Mock 数据文件                | ✅ 已补全 | DESIGN-COMPLETION.md §一              |
> | 飞书卡片 JSON 模板               | ✅ 已补全 | DESIGN-COMPLETION.md §二              |
> | TimescaleDB 连续聚合 SQL         | ✅ 已补全 | DESIGN-COMPLETION.md §三              |
> | Admin API 完整路由               | ✅ 已补全 | DESIGN-COMPLETION.md §四              |
> | Pulse Engine 代码骨架            | ✅ 已补全 | DESIGN-COMPLETION.md §五              |
> | 本体 API 路由                    | ✅ 已补全 | DESIGN-COMPLETION.md §六              |
> | Kafka 消息格式                   | ✅ 已补全 | DESIGN-COMPLETION.md §七              |
> | Alembic 初始迁移                 | ✅ 已补全 | DESIGN-COMPLETION.md §八              |
> | settings.py 含 Agent 配置        | ✅ 已补全 | DESIGN-COMPLETION.md §九              |
> | Agent 运行时抽象（HiAgent 适配） | ✅ 已补全 | NEXUS-FRAMEWORK-ARCHITECTURE.md §十一 |
> | OA 审批流 + Context API          | ✅ 已补全 | NEXUS-HEADLESS-INTEGRATION.md         |
> | "OpenHermes"错误说法修正         | ✅ 已修正 | ADR-8-AGENT-INTEGRATION.md §一        |
> | Agent 双向连接架构               | ✅ 已补全 | ADR-8-AGENT-INTEGRATION.md §三、§四   |
> | MSW 定义与用法说明               | ✅ 已补全 | ADR-8-AGENT-INTEGRATION.md §二        |
> | L0/L1 知识库种子内容清单         | ✅ 已补全 | KB-SEED-CONTENT.md                    |
> | 开发环境快速启动指南             | ✅ 已补全 | DEV-QUICKSTART.md                     |
>
> **剩余 2%（P3 级，Phase A 交付后处理）**：
>
> - Storybook 组件故事文件规范（前端可先用 MSW + Vitest 替代）
> - Grafana Dashboard JSON 配置（监控看板，Phase A 先用默认面板）

---

## 二、必须立即修复的 ❌ 缺失项

### 缺失 1：MSW Mock 数据文件（阻碍前端并行开发）

**问题**：前端开发需要 MSW Mock，但没有任何 Mock 数据文件和 handler 定义。

**影响**：所有前端 Task（U1-U6）都无法在后端就绪前独立开发。

**需要创建的文件**：

```
studio/src/lib/mock/
├── handlers/
│   ├── auth.handlers.ts          ← /v1/auth/login, /v1/auth/me
│   ├── equipment.handlers.ts     ← /v1/equipment, /v1/equipment/:id, /v1/equipment/:id/decision-package
│   ├── workorder.handlers.ts     ← /v1/workorders, /v1/hitl/workorders/:id/*
│   ├── alarm.handlers.ts         ← /v1/alarms
│   ├── kb.handlers.ts            ← /v1/kb/search, /v1/kb/documents
│   └── ai-jobs.handlers.ts       ← /v1/ai/jobs
├── fixtures/
│   ├── equipment.ts              ← Mock 设备数据（10台设备）
│   ├── decision-packages.ts      ← Mock 决策包（normal/warning/critical 三种）
│   ├── work-orders.ts            ← Mock 工单数据
│   ├── alarms.ts                 ← Mock 告警数据
│   └── user.ts                   ← Mock 用户数据（各角色）
└── browser.ts                    ← MSW 初始化入口
```

**Mock DecisionPackage 三种状态**（最重要，必须包含）：

```typescript
// fixtures/decision-packages.ts

export const normalDecisionPackage: DecisionPackageSchema = {
  equipment_id: 1,
  computed_at: new Date().toISOString(),
  health_score: 91,
  health_status: "good",
  health_trend: "stable",
  active_alarm_count: 0,
  highest_alarm_level: null,
  primary_action: {
    action_id: "monitor_001",
    label: "继续监测",
    urgency: "low",
    estimated_min: 0,
    action_type: "monitor",
  },
  data_quality: "high",
  proactive_insight: null,
  ai_confidence: null,
  relevant_kb_ids: [],
};

export const warningDecisionPackage: DecisionPackageSchema = {
  equipment_id: 2,
  computed_at: new Date().toISOString(),
  health_score: 62,
  health_status: "warning",
  health_trend: "declining",
  active_alarm_count: 1,
  highest_alarm_level: "P3",
  primary_action: {
    action_id: "workorder_002",
    label: "创建工单：检查轴承振动",
    urgency: "medium",
    estimated_min: 60,
    action_type: "create_workorder",
  },
  data_quality: "high",
  proactive_insight:
    "设备振动频率在过去 6 小时内持续上升，当前振动峰值已接近 ISO 10816-3 告警阈值。历史数据显示，2023年12月同型设备出现类似模式，最终原因为轴承磨损，建议提前进行预防性检修。",
  ai_confidence: "medium",
  relevant_kb_ids: [12, 35, 47],
};

export const criticalDecisionPackage: DecisionPackageSchema = {
  equipment_id: 3,
  computed_at: new Date().toISOString(),
  health_score: 23,
  health_status: "critical",
  health_trend: "rapid_decline",
  active_alarm_count: 3,
  highest_alarm_level: "P1",
  primary_action: {
    action_id: "emergency_001",
    label: "立即停机并通知主管",
    urgency: "immediate",
    estimated_min: 5,
    action_type: "emergency_stop",
  },
  data_quality: "high",
  proactive_insight:
    "P1 告警：出口压力骤降至 3.2MPa（阈值 4.0MPa），同时出口温度异常升高至 185°C（阈值 160°C），判断可能为泄漏或密封失效。",
  ai_confidence: "high",
  relevant_kb_ids: [8, 21],
};
```

---

### 缺失 2：飞书卡片消息格式（阻碍飞书集成开发）

**问题**：飞书消息卡片的 JSON 格式没有完整定义，无法实现 C1 任务。

**需要定义**（需要补充到 MODULE-DESIGN-PLATFORM.md §十三 或新建 FEISHU-CARD-TEMPLATES.md）：

```json
// 工单审批卡片格式
{
  "config": { "wide_screen_mode": true },
  "header": {
    "template": "orange",
    "title": { "tag": "plain_text", "content": "🔔 工单待审批" }
  },
  "elements": [
    {
      "tag": "div",
      "fields": [
        { "is_short": true, "text": { "tag": "lark_md", "content": "**工单号**\n{{wo_id}}" }},
        { "is_short": true, "text": { "tag": "lark_md", "content": "**设备**\n{{equipment_tag}}" }},
        { "is_short": false, "text": { "tag": "lark_md", "content": "**症状描述**\n{{symptom}}" }},
        { "is_short": false, "text": { "tag": "lark_md", "content": "**AI 建议操作**\n{{suggested_action}}" }}
      ]
    },
    {
      "tag": "action",
      "actions": [
        { "tag": "button", "text": { "tag": "plain_text", "content": "✅ 批准" },
          "type": "primary", "value": { "action": "approve", "wo_id": "{{wo_id}}" }},
        { "tag": "button", "text": { "tag": "plain_text", "content": "❌ 驳回" },
          "type": "danger", "value": { "action": "reject", "wo_id": "{{wo_id}}" }}
      ]
    }
  ]
}

// P1 告警紧急通知卡片格式
{
  "config": { "wide_screen_mode": true },
  "header": {
    "template": "red",
    "title": { "tag": "plain_text", "content": "🚨 P1 紧急告警" }
  },
  "elements": [
    {
      "tag": "div",
      "text": { "tag": "lark_md",
                "content": "**设备**：{{equipment_tag}}\n**告警**：{{alarm_message}}\n**时间**：{{triggered_at}}" }
    },
    {
      "tag": "action",
      "actions": [
        { "tag": "button", "text": { "tag": "plain_text", "content": "查看 Studio" },
          "type": "primary", "url": "{{studio_url}}/studio?equipment={{equipment_id}}" }
      ]
    }
  ]
}
```

---

### 缺失 3：TimescaleDB Continuous Aggregate SQL

**问题**：设计提到用 TimescaleDB 连续聚合代替批量 KPI，但没有实际 SQL。

**需要补充到 MODULE-DESIGN-PLATFORM.md §二（DB Schema）**：

```sql
-- 1小时粒度聚合（用于 24h 趋势图）
CREATE MATERIALIZED VIEW equipment_readings_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', ts) AS bucket,
  equipment_id,
  metric,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  LAST(value, ts) AS last_value,
  COUNT(*) AS sample_count
FROM equipment_readings
GROUP BY bucket, equipment_id, metric
WITH NO DATA;

-- 刷新策略（最近数据 5 分钟刷新，历史数据 1 小时刷新）
SELECT add_continuous_aggregate_policy('equipment_readings_1h',
  start_offset => INTERVAL '2 hours',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes'
);

-- 压缩策略（7天以上数据压缩）
ALTER MATERIALIZED VIEW equipment_readings_1h SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'bucket',
  timescaledb.compress_segmentby = 'equipment_id,metric'
);
```

---

### 缺失 4：Admin API 路由完整实现

**问题**：Admin 路由在 §二十三.4 有设计概述，但没有完整实现规范。

**需要补充的 Admin API**：

```
POST /v1/admin/users              ← 创建用户（含密码）
PUT  /v1/admin/users/{id}        ← 更新用户（角色/场站权限）
POST /v1/admin/stations           ← 创建场站
POST /v1/admin/equipment          ← 批量导入设备（JSON/CSV）
PUT  /v1/admin/equipment/{id}    ← 更新设备配置（阈值/本体类型）
GET  /v1/admin/system/health     ← 系统健康检查（DB/Redis/**pgvector** 扩展等）
GET  /v1/admin/system/metrics    ← 关键指标（API P95/告警率/AI 调用量）
POST /v1/admin/kb/seed           ← 触发种子数据导入
```

---

## 三、⚠️ 需要细化的设计项

### 细化 1：Pulse Engine 代码级实现

**现状**：业务逻辑和数据结构已定义，但缺少具体代码实现框架。

**需要补充**（可直接在 PARALLEL-DEV-TASKSPEC.md Task B2 中补充，或新增到 MODULE-DESIGN-PLATFORM.md）：

```python
# engines/pulse_engine.py

class PulseEngine:
    """
    30s 心跳：计算所有活跃设备的健康分和决策包，缓存到 Redis。
    """

    def __init__(self, db_session_factory, redis, alarm_repo):
        self.db = db_session_factory
        self.redis = redis
        self.alarm_repo = alarm_repo

    async def run_cycle(self) -> None:
        """单次 30s 周期：遍历所有活跃设备"""
        async with self.db() as db:
            active_equipment = await db.execute(
                select(Equipment).where(Equipment.is_active == True)
            )
            tasks = [self._refresh_equipment(eq, db) for eq in active_equipment.scalars()]
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _refresh_equipment(self, eq: Equipment, db) -> None:
        """计算单台设备的决策包"""
        readings = await self._get_latest_readings(eq.id)
        alarms = await self.alarm_repo.get_active(eq.id)
        forecast = await self._get_moirai_forecast(eq.id)

        health = self._compute_health_score(readings, alarms, forecast)
        action = self._compute_primary_action(health, alarms, forecast)

        pkg = DecisionPackage(
            equipment_id=eq.id,
            computed_at=utcnow(),
            health_score=health.score,
            health_status=health.status,
            health_trend=health.trend,
            active_alarm_count=len(alarms),
            highest_alarm_level=alarms[0].level if alarms else None,
            primary_action=action,
            data_quality=health.data_quality,
        )

        await self._cache_to_redis(pkg)

    def _compute_health_score(self, readings, alarms, forecast) -> HealthResult:
        """
        纯规则引擎（不调 LLM）：
        基础分 100，按告警等级扣分，按预测分扣分
        P1: -50, P2: -30, P3: -15, P4: -5
        MOIRAI > 0.9: -30, > 0.7: -20, > 0.5: -10
        """
        score = 100
        for alarm in alarms:
            score -= {"P1": 50, "P2": 30, "P3": 15, "P4": 5}[alarm.level]
        if forecast and forecast.anomaly_score > 0.5:
            score -= int((forecast.anomaly_score - 0.5) * 60)
        return HealthResult(
            score=max(0, score),
            status="critical" if score < 40 else "warning" if score < 70 else "good" if score < 90 else "excellent",
            trend=self._compute_trend(score),
            data_quality="stale" if readings is None else "high",
        )

    def _compute_primary_action(self, health, alarms, forecast) -> PrimaryAction:
        """
        决策树（优先级从高到低）：
        1. P1 告警 → immediate + emergency_stop
        2. MOIRAI > 0.85 → high + create_workorder
        3. P2 告警 → high + create_workorder
        4. health < 60 → medium + request_ai
        5. P3/P4 告警 → medium + acknowledge_alarm
        6. 正常 → low + monitor
        """
        p1_alarms = [a for a in alarms if a.level == "P1"]
        if p1_alarms:
            return PrimaryAction(action_type="emergency_stop", urgency="immediate",
                                 label="立即停机：P1 告警触发", estimated_min=5)
        if forecast and forecast.anomaly_score > 0.85:
            return PrimaryAction(action_type="create_workorder", urgency="high",
                                 label="创建预防性工单", estimated_min=30)
        # ... 其余规则
```

---

### 细化 2：Kafka 消息格式（OT → Platform）

**现状**：提到用 Kafka，但消息格式不清晰。

**需要确认的消息 Schema**（补充到 OPCUA-BRIDGE-DESIGN.md 或 MODULE-DESIGN-PLATFORM.md §摄入）：

```python
# Kafka Topic: ot.readings.{station_id}
# Message Schema:
{
  "tag": "C-101",              # 设备位号（OPC-UA Node ID 映射后）
  "metric": "p_out",           # 指标名（Platform Ontology 中定义）
  "value": 6.8,
  "unit": "MPa",
  "ts": "2026-05-11T02:30:00Z",  # UTC ISO8601
  "quality": "good" | "uncertain" | "bad",
  "source": "opcua-bridge-v1",
  "station_id": 1,             # 场站 ID（bridge 填入）
}
```

---

### 细化 3：本体层 API（Ontology API）

**现状**：设计提到 `/v1/ontology/*` 但没有完整路由定义。

**需要补充**：

```
GET /v1/ontology/equipment-types
  Response: [{ type_code: "centrifugal_compressor", name_cn: "离心式压缩机",
               metrics: [...], actions: [...] }]

GET /v1/ontology/equipment-types/{type_code}/metrics
  Response: [{ metric_code: "p_in", name_cn: "进口压力", unit: "MPa",
               normal_range: [5.0, 8.0], alarm_thresholds: {...} }]

POST /v1/ontology/equipment-types (sys_admin only)
  Request:  { type_code, name_cn, metrics, actions }
  Response: ok(EquipmentTypeSchema)
```

---

## 四、🔴 冲突需要统一的设计

### 冲突 1：Decision Package API 路径

| 文档                             | 路径定义                                  |
| -------------------------------- | ----------------------------------------- |
| COMMERCIAL-ARCHITECTURE.md §三   | `GET /v1/equipment/{id}/decision-package` |
| PARALLEL-DEV-TASKSPEC.md Task B2 | 同上                                      |
| MODULE-DESIGN-PLATFORM.md §18.6  | 未提及                                    |

**裁定**：路径为 `GET /v1/equipment/{id}/decision-package`，MODULE-DESIGN-PLATFORM.md §18.6 需要补充此路由。

---

### 冲突 2：SSE 端点路径

| 文档                             | 路径定义                                                          |
| -------------------------------- | ----------------------------------------------------------------- |
| MODULE-DESIGN-PLATFORM.md §21.3  | `GET /v1/sse/station/{id}`                                        |
| STUDIO-UI-ARCHITECTURE.md §五    | `GET /v1/sse/station/{stationId}`                                 |
| PARALLEL-DEV-TASKSPEC.md Task C3 | `GET /v1/sse/equipment/{id}` 和 `GET /v1/sse/station/{id}/alarms` |

**裁定**：统一为两个端点：

- `GET /v1/sse/station/{id}` → 推送该场站所有设备的读数/健康/告警更新
- `GET /v1/sse/ai-jobs/{task_id}` → 推送特定 AI Job 的状态更新

---

### 冲突 3：AI Job 触发路径

| 文档                             | 路径定义                                      |
| -------------------------------- | --------------------------------------------- |
| MODULE-DESIGN-PLATFORM.md §27.5  | `POST /v1/ai/jobs`                            |
| PARALLEL-DEV-TASKSPEC.md Task B3 | `POST /v1/ai/jobs`（一致）                    |
| MODULE-DESIGN-PLATFORM.md §22.3  | `POST /v1/tools/diagnose_equipment`（旧路径） |

**裁定**：旧路径已废弃（§错误 33），唯一正确路径为 `POST /v1/ai/jobs`。

---

## 五、文档权威层级（更新版）

```
新增文档（2026-05-11，优先级最高）：
  STUDIO-UI-ARCHITECTURE.md    ← UI 架构原则（比 MODULE-DESIGN-STUDIO 权威）
  PARALLEL-DEV-TASKSPEC.md     ← 并行开发接口契约（API 定义权威）
  COMMERCIAL-ARCHITECTURE.md   ← 商业架构（含修正开源策略）
  DESIGN-COMPLETENESS-AUDIT.md ← 本文档（设计状态快照）

冲突时的优先顺序：
  1. PARALLEL-DEV-TASKSPEC.md（最新，锁定接口）
  2. MODULE-DESIGN-PLATFORM.md §十九+（最新章节号更高）
  3. SKILL.md §1（架构铁律）
  4. 较新的 ADR 文档
```

---

## 六、Phase A 开发就绪评估

```
评估：当前设计完成度是否足以启动 Phase A 并行开发？

Track A（基础设施）：✅ 可以立即启动
  · A1 Auth：完整，可立即开始
  · A2 Equipment CRUD：完整，可立即开始
  · A3 OT 摄入：基本完整（确认 Kafka 消息格式后）
  · A4 KB RAG：完整，可立即开始
  · A5 Alarm：基本完整，代码细节开发时决定
  · A6 Studio Shell：完整，可立即开始

Track B（业务逻辑）：⚠️ 需要 A1+A2 完成后启动
  · B1 WorkOrder FSM：完整，等 A1+A2
  · B2 Pulse Engine：需要先补充代码框架（见细化 1）
  · B3 AI Jobs：完整
  · B4 Scheduler：基本完整

Track C（集成）：⚠️ 需要 B 完成后启动
  · C1 飞书：需要先完整定义卡片 JSON（见缺失 2）

Track UI（前端）：⚠️ 需要先创建 MSW Mock 文件（见缺失 1）
  · 创建 MSW 文件后可以和 B 并行

结论：
  ✅ 立即启动：A1, A2, A4, A6（完全无依赖）
  🔧 修复后启动：UI Track（补充 MSW Mock），B2（补充代码框架）
  ⏰ 等待依赖：B 等 A，C 等 B

最小可行并行度（今天可以开 4 个 Cursor 会话）：
  会话 1: A1 Auth
  会话 2: A2 Equipment
  会话 3: A4 KB RAG
  会话 4: A6 Studio Shell + MSW Mock 文件创建
```

---

## 七、下一步行动清单（按优先级）

```
P0（立即做，阻塞开发）：
  □ 创建 MSW Mock 文件（studio/src/lib/mock/）—— 前端开发必须
  □ 在 MODULE-DESIGN-PLATFORM.md 补充 Decision Package 路由
  □ 统一 SSE 端点路径（见冲突 2 裁定）

P1（一周内，避免歧义）：
  □ 飞书卡片 JSON 模板（工单审批/P1告警/晨报）
  □ Pulse Engine 代码框架（engines/pulse_engine.py 骨架）
  □ TimescaleDB 连续聚合 SQL
  □ Admin API 路由完整定义

P2（两周内，提升质量）：
  □ L0 种子知识库内容（至少 10 篇行业文档）
  □ Storybook stories（DeviceIntelPanel 三种状态）
  □ Alembic 迁移文件（在 Dev 环境实际生成）
  □ 本体层 API 补充（/v1/ontology/*）

P3（Phase A 交付前）：
  □ 完整 E2E 测试用例（登录→查看设备→告警→工单→审批→完成）
  □ 性能基准测试（Decision Package < 50ms P95）
  □ 安全扫描（权限矩阵测试）
```

---

_本文档是 2026-05-11 的设计完成度快照。_  
_随着开发推进，P0/P1 项会被逐渐解决，每 2 周更新一次本文档。_
