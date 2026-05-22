# ClawTwin 工业场景完整性审计

> **版本**：v1.0 · 2026-05-11  
> **目的**：从真实油气站场运营视角，全面审查设计覆盖度，识别架构缺口  
> **依据**：SY/T 6320（管道运行规程）、ISA-18.2（告警管理）、ISO 55000（资产管理）  
> **范围**：无人化/少人化天然气/原油管输站场

---

## 一、工业场景全景图

```
站场日常运营
├── 1. 实时监控与态势感知
│   ├── 设备健康监控（传感器读数、阈值告警）
│   ├── 工艺过程监控（压力、流量、温度）
│   ├── 站场全景视图（Fleet View）
│   └── 数据质量监控
│
├── 2. 告警管理（ISA-18.2）
│   ├── 告警优先级（P1 紧急 / P2 高 / P3 中 / P4 低）
│   ├── 告警确认与搁置
│   ├── 告警根因分析
│   ├── 持续/闪烁告警管理
│   └── 告警 KPI（告警率、MTTD、MTTR）
│
├── 3. 设备维护管理
│   ├── 故障抢修（Corrective Maintenance）
│   ├── 预防性维护（Preventive Maintenance/PM）
│   ├── 计划检修（Scheduled Shutdown）
│   ├── 状态维护（CBM - Condition Based Maintenance）
│   └── 应急处置（Emergency Response）
│
├── 4. 巡检管理
│   ├── 日常巡检计划（Route-based Inspection）
│   ├── 设备点检（Equipment Point Check）
│   ├── 视觉巡检（AI Vision Inspection）
│   └── 缺陷发现与工单转化
│
├── 5. 安全作业管理
│   ├── 作业许可证（PTW - Permit to Work）
│   ├── 锁能隔离（LOTO - Lockout/Tagout）
│   ├── HSE 事件记录
│   └── 动火/受限空间作业许可
│
├── 6. 班次管理
│   ├── 班次排班
│   ├── 交接班报告
│   ├── 接班确认
│   └── 本班事件汇总
│
├── 7. 生产数据管理
│   ├── 生产数据记录（日产量）
│   ├── 运行时长统计
│   ├── 关键绩效指标（KPI）
│   └── 生产日/月报
│
├── 8. 能耗管理
│   ├── 设备能耗统计
│   ├── 效率趋势分析
│   ├── 能耗基准对比
│   └── 碳排放核算
│
├── 9. 设备台账管理
│   ├── 设备全生命周期记录
│   ├── 备件管理
│   ├── 技术参数档案
│   └── 维修历史记录
│
├── 10. 知识与学习
│    ├── 工业标准检索
│    ├── 设备手册 Q&A
│    ├── 历史工单经验
│    └── 知识飞轮积累
│
└── 11. 报表与分析
     ├── 设备可用率（Availability）
     ├── 平均故障间隔（MTBF）
     ├── 平均修复时间（MTTR）
     ├── 站场对比报告
     └── 合规报告
```

---

## 二、场景覆盖度审计结果

### 评级说明

```
✅ 完整设计   — 有数据模型、API、UI 三层设计
🔶 基础设计   — 有 API 但数据模型或 UI 不完整
⚠️  局部遗漏   — 有功能思路但关键部分缺失
❌ 完全缺失   — 无设计，Phase A 需补
📅 Phase B    — 有意识到但归到 Phase B，Phase A 有预留钩子
```

| 场景                   | 覆盖状态 | 缺失内容                                       | Phase       |
| ---------------------- | -------- | ---------------------------------------------- | ----------- |
| **1.1 实时设备监控**   | ✅       | —                                              | A           |
| **1.2 工艺过程监控**   | 🔶       | 缺流量平衡校验、压力梯度分析                   | A/B         |
| **1.3 站场全景视图**   | ✅       | —                                              | A           |
| **1.4 数据质量监控**   | 🔶       | 缺数据质量 Dashboard API                       | A           |
| **2.1 告警优先级**     | ✅       | —                                              | A           |
| **2.2 告警确认/搁置**  | ✅       | —                                              | A           |
| **2.3 告警根因分析**   | 🔶       | 缺 AI 联动根因分析                             | A           |
| **2.4 持续/闪烁告警**  | ⚠️       | 有字段定义但缺自动识别逻辑                     | A           |
| **2.5 告警 KPI**       | ⚠️       | 有设计框架但缺实际计算 API                     | A           |
| **3.1 故障抢修**       | ✅       | —                                              | A           |
| **3.2 预防性维护**     | ⚠️       | 工单类型有，缺 PM Schedule 管理                | A/B         |
| **3.3 计划检修**       | ⚠️       | 缺停机计划管理模块                             | B           |
| **3.4 状态维护 CBM**   | 🔶       | 有 AI 诊断，缺 CBM 决策规则                    | B           |
| **3.5 应急处置**       | ⚠️       | 有工单类型，缺紧急响应 SOP                     | A           |
| **4.1 巡检计划**       | ❌       | 完全缺失，仅有视觉 AI 巡检                     | **A（补）** |
| **4.2 设备点检**       | ❌       | 完全缺失                                       | **A（补）** |
| **4.3 视觉巡检 AI**    | 📅       | Phase B，有 Qwen2.5-VL 规划                    | B           |
| **4.4 缺陷→工单**      | ⚠️       | 可通过现有工单创建实现                         | A           |
| **5.1 作业许可证 PTW** | ⚠️       | industrial-workorder Skill 提到，无 Nexus 支持 | **A 预留**  |
| **5.2 LOTO**           | ❌       | 完全缺失                                       | B           |
| **5.3 HSE 事件**       | ❌       | 完全缺失                                       | B           |
| **5.4 动火/受限空间**  | ❌       | 完全缺失                                       | B           |
| **6.1 班次排班**       | ❌       | 完全缺失                                       | **A（补）** |
| **6.2 交接班报告**     | 🔶       | 有 API 无数据模型，无接班确认                  | **A（补）** |
| **6.3 接班确认**       | ❌       | 完全缺失                                       | **A（补）** |
| **7.1 日产量记录**     | ❌       | **完全缺失！**                                 | **A（补）** |
| **7.2 运行时长统计**   | ⚠️       | 可从时序数据计算，无 API                       | A           |
| **7.3 KPI 计算**       | ⚠️       | 框架有，具体计算缺失                           | A           |
| **7.4 生产日/月报**    | 🔶       | 有飞书日报但无结构化数据                       | A/B         |
| **8.1 能耗统计**       | ⚠️       | 有规划，无 API                                 | B           |
| **8.2 效率分析**       | 📅       | Phase B，有 CoolProp 规划                      | B           |
| **9.1 设备台账**       | 🔶       | 有基础字段，缺完整生命周期                     | A/B         |
| **9.2 备件管理**       | ❌       | 完全缺失                                       | B           |
| **9.3 维修历史**       | ✅       | 通过工单记录实现                               | A           |
| **10.1-10.4 知识库**   | ✅       | —                                              | A           |
| **11.1 可用率计算**    | ⚠️       | 需要设备状态历史                               | B           |
| **11.2 MTBF/MTTR**     | ⚠️       | 需要完整设备历史数据                           | B           |
| **11.3 站场对比**      | 📅       | Phase B                                        | B           |

---

## 三、Phase A 必须补充的架构缺口（已确认）

### 3.1 设备状态枚举不完整（最严重）

**现状**：只有 `normal / warn / alarm / offline`  
**问题**：油气设备有更多业务状态，直接影响告警逻辑和工单逻辑

**正确枚举（终态）：**

```python
class EquipmentStatus(str, Enum):
    RUNNING   = "running"      # 运行中（正常）
    STANDBY   = "standby"      # 备用状态（冷备/热备）
    WARN      = "warn"         # 告警（达到警告阈值）
    ALARM     = "alarm"        # 告警（达到告警阈值，需处理）
    FAULT     = "fault"        # 故障停机（已停运，需抢修）
    MAINTENANCE = "maintenance"  # 检修中（有工单在进行）
    COMMISSIONED = "commissioned"  # 调试中（新设备）
    OFFLINE   = "offline"      # 停用/退役/不在用

# 告警逻辑：MAINTENANCE 状态的设备不触发 P3/P4 告警（检修中预期）
# 工单关联：状态切换到 MAINTENANCE 时自动关联在途工单
```

**影响**：`equipment` 表、`Equipment` ORM、所有 API 响应、Studio 状态颜色、告警评估器

### 3.2 工单类型枚举不统一（严重）

**现状**：MODULE-DESIGN-PLATFORM 中至少 3 处不一致定义：

- 一处：`inspection|lubrication|seal_check|filter_replace|vibration_analysis`
- 一处：`inspection|maintenance|anomaly_check|...`
- 一处：`inspection|maintenance|emergency|calibration`

**正确枚举（终态）：**

```python
class WorkOrderType(str, Enum):
    CORRECTIVE   = "corrective"    # 故障处理（计划外，因告警触发）
    PREVENTIVE   = "preventive"    # 预防性维护（计划内，基于时间/运行小时）
    INSPECTION   = "inspection"    # 例行点检/巡检
    SHUTDOWN     = "shutdown"      # 停机大修（需停产）
    EMERGENCY    = "emergency"     # 紧急处置（P1 告警触发）
    CALIBRATION  = "calibration"   # 仪表校准
    IMPROVEMENT  = "improvement"   # 技改优化
```

**子类型（work_subtype，可选细化）：**

```
corrective    → seal_replacement | bearing_check | lubrication | filter_replace
preventive    → oil_change | vibration_analysis | thermal_imaging | ...
inspection    → daily_round | monthly_inspection | annual_inspection
```

### 3.3 生产数据完全缺失（严重）

**现状**：无任何生产数据相关设计  
**问题**：油气站场的核心业务是"站场每天输送了多少油/气"，无此数据则系统无法替代 SCADA 生产日报

**Phase A 最小化设计：**

```sql
-- 新增表：production_records（生产日报核心数据）
CREATE TABLE production_records (
    id          SERIAL PRIMARY KEY,
    station_id  INT NOT NULL REFERENCES stations(id),
    record_date DATE NOT NULL,
    shift_type  VARCHAR(20),          -- 全天/早班/中班/晚班

    -- 输量数据（根据站场类型选用）
    oil_volume_m3    DECIMAL(12,3),   -- 原油输量（m³）
    gas_volume_m3    DECIMAL(12,3),   -- 天然气输量（m³ 或 万方）
    water_volume_m3  DECIMAL(12,3),   -- 含水量（m³）
    throughput_m3    DECIMAL(12,3),   -- 综合输量

    -- 运行数据
    runtime_hours    DECIMAL(5,2),    -- 设备运行时长（小时）
    energy_kwh       DECIMAL(10,2),   -- 耗电量（kWh）

    -- 异常情况
    outage_minutes   INT DEFAULT 0,   -- 停输时间（分钟）
    outage_reason    TEXT,            -- 停输原因

    notes           TEXT,
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(station_id, record_date, shift_type)
);
```

**Phase A API（最小化）：**

```
GET  /v1/production/records?station_id=&date_from=&date_to=   日报列表
POST /v1/production/records                                    创建/更新日报
GET  /v1/production/summary?station_id=&period=month          月度汇总
GET  /v1/production/kpi?station_id=                          关键指标（可用率/完成率）
```

### 3.4 班次管理不完整（重要）

**现状**：只有 `POST /v1/shifts/handover`，无数据模型  
**问题**：无法记录谁当班、交班未确认不可追溯

**Phase A 最小化设计：**

```sql
-- 新增表：shift_records（班次记录）
CREATE TABLE shift_records (
    id                  SERIAL PRIMARY KEY,
    station_id          INT NOT NULL REFERENCES stations(id),
    shift_date          DATE NOT NULL,
    shift_type          VARCHAR(20) NOT NULL,  -- morning|afternoon|night（早中晚）
    start_time          TIMESTAMPTZ NOT NULL,
    end_time            TIMESTAMPTZ,           -- 交班时填充

    -- 人员
    on_duty_operator_id  INT REFERENCES users(id),   -- 在班操作员
    handover_to_id       INT REFERENCES users(id),   -- 接班人

    -- 交接状态
    status              VARCHAR(20) DEFAULT 'active',  -- active|pending_handover|completed
    handover_summary    TEXT,                          -- AI 生成的交接摘要
    key_events          JSONB DEFAULT '[]',            -- 本班关键事件
    outstanding_issues  JSONB DEFAULT '[]',            -- 未完成事项
    active_work_orders  JSONB DEFAULT '[]',            -- 在途工单 ID 列表

    -- 接班确认
    confirmed_at        TIMESTAMPTZ,
    confirmed_by        INT REFERENCES users(id),

    created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

**Phase A API（最小化）：**

```
GET  /v1/shifts/current?station_id=         当前班次信息
POST /v1/shifts/                           开始新班次（登录自动触发）
POST /v1/shifts/{id}/handover              发起交接（生成 AI 交接摘要）
POST /v1/shifts/{id}/confirm               接班确认（接班人签收）
GET  /v1/shifts?station_id=&date=          班次历史记录
```

### 3.5 巡检管理缺失（重要）

**Phase A 最简方案**：不建单独模块，通过工单类型 `inspection` 实现

```python
# 巡检工单的额外字段（work_orders 表扩展）
class WorkOrder(Base):
    ...
    work_type       = Column(String(50))       # 如果 = "inspection"
    inspection_route = Column(String(100))    # 巡检路线（如"泵房A→压缩机组→计量间"）
    checklist_items = Column(JSONB)           # 点检项目清单 JSON
    checklist_results = Column(JSONB)         # 点检结果 JSON
```

**巡检计划（PM Schedule）—— Phase A 简单版：**

```sql
-- inspection_schedules（巡检计划，简单版）
CREATE TABLE inspection_schedules (
    id          SERIAL PRIMARY KEY,
    station_id  INT NOT NULL,
    name        VARCHAR(200),              -- 如"每日早班巡检"
    frequency   VARCHAR(50),              -- daily|weekly|monthly
    route       TEXT,                     -- 巡检路线描述
    checklist   JSONB NOT NULL,           -- 点检项目列表
    assignee_role VARCHAR(50),            -- 责任角色
    is_active   BOOLEAN DEFAULT TRUE,
    next_due_at TIMESTAMPTZ,              -- 下次到期时间
    last_done_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**API（最小化）：**

```
GET  /v1/inspection/schedules?station_id=     巡检计划列表
POST /v1/inspection/schedules/{id}/trigger   触发创建巡检工单
GET  /v1/inspection/overdue?station_id=       逾期未完成的巡检
```

### 3.6 作业许可证（PTW）Phase A 预留

PTW 系统复杂，Phase A 只做**最小预留**，Phase B 完整实现：

```python
# work_orders 表新增字段（Phase A 预留）
class WorkOrder(Base):
    ...
    permit_required  = Column(Boolean, default=False)  # 是否需要作业许可证
    permit_type      = Column(String(50))               # hot_work|cold_work|confined_space|electrical
    permit_number    = Column(String(100))              # 许可证编号（手工填入，Phase B 自动生成）
    permit_status    = Column(String(50))               # pending|approved|active|closed
```

**铁律补充**：**工单 `state=in_progress` 时，如果 `permit_required=True` 且 `permit_number` 为空，Nexus 拒绝开工。**

---

## 四、告警管理 ISA-18.2 完整性补充

### 4.1 缺失的告警字段

```sql
-- alarms 表需要补充的字段
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS
    acknowledged_at     TIMESTAMPTZ,           -- 确认时间
    acknowledged_by     INT REFERENCES users(id),
    shelved_until       TIMESTAMPTZ,           -- 搁置到期时间
    shelved_by          INT REFERENCES users(id),
    shelved_reason      TEXT,                  -- 搁置原因（ISA-18.2 要求记录）
    standing_since      TIMESTAMPTZ,           -- 持续告警：首次触发时间
    chat_count          INT DEFAULT 1,         -- 闪烁次数（用于识别 chattering alarm）
    last_triggered_at   TIMESTAMPTZ DEFAULT NOW();
```

### 4.2 缺失的告警 KPI API

```
GET /v1/alarms/kpi?station_id=&period=24h   告警 KPI 指标：
  返回：
    alarm_rate_per_10min: float    当前告警率（ISA-18.2 建议 < 1/10min）
    standing_alarms: int           持续超过 24h 的告警数
    chattering_alarms: int         闪烁告警数
    unacknowledged_count: int      未确认告警数
    p1_response_time_avg_min: float  P1 告警平均响应时间（分钟）
    shelved_count: int             搁置中的告警数
```

### 4.3 告警升级策略（Phase A 必须）

```python
# services/alarm_escalation.py（新增）
ESCALATION_RULES = {
    "P1": {
        "ack_timeout_minutes": 5,    # 5 分钟未确认 → 升级
        "escalate_to": "supervisor", # 推送给主管
        "feishu_notify": True
    },
    "P2": {
        "ack_timeout_minutes": 30,
        "escalate_to": "supervisor",
        "feishu_notify": True
    }
}
# Scheduler: alarm_escalation_job → 每 5 分钟检查超时未确认告警
```

---

## 五、架构补全后的完整数据模型

### 5.1 最终数据库表清单（终态）

```
基础表（Phase A 必须）：
  stations                  场站
  users                     用户
  user_station_assignments  用户场站权限
  equipment_types           设备类型本体
  equipment_type_metrics    设备类型指标定义
  equipment                 设备实例（status 枚举扩展为 7 种）
  equipment_readings        时序读数（TimescaleDB hypertable）
  alarm_rules               告警规则
  alarms                    告警（补充 ISA-18.2 字段）
  work_orders               工单（work_type 统一为 7 种）
  work_order_evidence       完工证据
  kb_documents              知识库文档
  kb_chunks                 文档切片
  ai_jobs                   AI 异步任务
  audit_logs                审计日志
  webhook_subscriptions     Webhook 注册

Phase A 新增表（本文补充）：
  production_records        生产日报（日产量记录）
  shift_records             班次记录（交接班）
  inspection_schedules      巡检计划

Phase B 表：
  pm_schedules              预防性维护计划
  work_permits              作业许可证（PTW）
  spare_parts               备件台账
  equipment_lifecycle       设备生命周期记录
  energy_records            能耗记录
  hse_incidents             HSE 事件记录
```

---

## 六、Phase A API 补充清单（本次新增）

```
# 生产数据
GET  /v1/production/records?station_id=&date_from=&date_to=
POST /v1/production/records
GET  /v1/production/summary?station_id=&period=month
GET  /v1/production/kpi?station_id=

# 班次管理
GET  /v1/shifts/current?station_id=
POST /v1/shifts/
POST /v1/shifts/{id}/handover
POST /v1/shifts/{id}/confirm
GET  /v1/shifts?station_id=&date=

# 巡检
GET  /v1/inspection/schedules?station_id=
POST /v1/inspection/schedules/{id}/trigger
GET  /v1/inspection/overdue?station_id=

# 告警 KPI
GET  /v1/alarms/kpi?station_id=&period=

# 设备 KPI
GET  /v1/equipment/kpi?station_id=     MTBF/MTTR/可用率（数据量足时）
```

---

## 七、Studio UI 补充需求

### 7.1 缺失的 UI 组件/页面

| 组件                    | 说明                         | Phase     |
| ----------------------- | ---------------------------- | --------- |
| `ProductionPage.tsx`    | 生产数据录入和查看           | A         |
| `ShiftHandoverPage.tsx` | 交接班完整页面（含确认按钮） | A         |
| `InspectionPage.tsx`    | 巡检计划和任务管理           | A         |
| `AlarmKPIDashboard.tsx` | ISA-18.2 告警 KPI 面板       | A         |
| `PTWBadge.tsx`          | 工单中显示许可证状态标识     | A（预留） |

### 7.2 工单表单扩展

```typescript
// WorkOrderForm 需要新增字段
interface WorkOrderForm {
  // 已有
  equipment_id: string;
  work_type: WorkOrderType;
  title: string;
  description: string;
  priority: Priority;

  // 新增
  inspection_route?: string; // inspection 类型时显示
  checklist_items?: ChecklistItem[]; // inspection 类型时显示
  permit_required?: boolean; // 是否需要作业许可证
  permit_type?: PermitType; // hot_work|cold_work|confined_space
  permit_number?: string; // 许可证编号（手工填入）
  pm_schedule_id?: number; // 关联的 PM 计划（preventive 类型）
}
```

---

## 八、Sage Skills 完整性检查

### 8.1 当前 Skills 覆盖

| Skill                  | 覆盖场景               | 状态       |
| ---------------------- | ---------------------- | ---------- |
| `industrial-twin`      | 设备状态读取、异常分析 | ✅         |
| `industrial-kb`        | 知识库检索、标准文档   | ✅         |
| `industrial-workorder` | 工单创建、状态查询     | ✅         |
| `industrial-analytics` | 趋势分析、KPI 计算     | 🔶         |
| `industrial-admin`     | 系统运维管理           | ✅（新增） |

### 8.2 缺失的 Skills（Phase A 建议补充）

```
industrial-shift        # 班次交接 Skill（生成交接报告、提醒接班人）
industrial-production   # 生产数据 Skill（录入日报、查询产量）
industrial-inspection   # 巡检管理 Skill（查看逾期巡检、生成巡检报告）
```

---

## 九、修正后的 Phase A 里程碑影响

**原 Phase A 范围**（12 周）需补充：

- Week 1-2：新增 `production_records`、`shift_records`、`inspection_schedules` 表 Alembic 迁移
- Week 3-4：新增生产数据 API（4 个端点）
- Week 5-6：班次管理 API + 交接班飞书卡片升级
- Week 7：巡检计划触发 API
- Week 8：告警 KPI API + 告警升级 Scheduler
- Week 9：Studio ProductionPage + ShiftHandoverPage
- Week 11-12：集成测试，确认所有工业场景通路可用

---

## 十、不在 ClawTwin 范围内的场景（明确边界）

以下场景**不是 ClawTwin 的责任范围**，应集成第三方系统：

| 场景               | 说明             | 推荐集成        |
| ------------------ | ---------------- | --------------- |
| SCADA/DCS 控制指令 | AI 不直控工艺    | DCS 专有系统    |
| 财务/采购流程      | 工单到物料采购   | ERP（SAP/金蝶） |
| HR/排班管理        | 员工信息/排班    | HR 系统         |
| OPC-UA 数据采集    | 边界已明确       | opcua-bridge    |
| 法规合规申报       | 向监管部门报告   | 专业合规系统    |
| 工艺仿真计算       | CoolProp/HYSYS   | Phase B+        |
| AR 现场辅助        | 现场维修 AR 指导 | Phase C         |

---

_本文档确立 ClawTwin Phase A 工业场景的完整边界。开发时以此为场景验收基准。_
