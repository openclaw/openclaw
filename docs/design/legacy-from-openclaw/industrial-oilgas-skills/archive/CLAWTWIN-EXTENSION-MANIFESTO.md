# ClawTwin 扩展架构宣言（Extension Architecture Manifesto）

> **版本**：v1.0 · 2026-05-12  
> **地位**：ClawTwin 可扩展性的权威指南。定义系统的最小核心、扩展轴、能力注册机制。  
> **上层文档**：`CLAWTWIN-AUTONOMY-PHILOSOPHY.md`（哲学）；本文是哲学在工程层面的约束。

---

## 一、系统的五条内在规律

这个系统必须像物理系统一样，遵守自己的规律。任何违反这些规律的设计都是技术债。

### 规律 1：本体守恒

> 所有有业务意义的实体，必须是 Ontology 中的 Object Type。

违反特征：直接建数据库表而不注册 Object Type。  
例外：纯基础设施表（audit_log、migrations、sessions）不属于业务实体。

```
正确路径：  Robot → ObjectType.Robot → ObjectStore.get/list/patch
错误路径：  Robot → 直接 SQLAlchemy Model + 裸 SQL
```

### 规律 2：事件因果律

> 每一个状态变化必须由一个可追溯的事件产生，并经过 EventDispatcher。

违反特征：`db.commit()` 改变实体状态但不产生任何事件。

```
正确路径：  alarm.state: open → acknowledged
              → EventDispatcher.dispatch(alarm.acknowledged, ...)
              → [SSE] [Webhook Outbox] [Audit]

错误路径：  alarm.state: open → acknowledged
              → db.commit()   # 状态改了，但没有人知道
```

### 规律 3：数据守恒（信息不消失）

> 进入系统的信息必须可以被追溯到它的最终去向。

违反特征：一次告警诊断产生了 AI 结论，但 AI 结论没有被存储，每次查询重新执行。  
违反特征：WorkOrder 完成，但没有 OutcomeEvent 闭环，不知道维修有没有效果。

### 规律 4：读写对称

> 任何 POST 写入的字段，必须能被 GET 读出。任何 GET 返回的字段，必须有明确的写入来源。

违反特征：字段存在于 Model 但 API 响应不包含。  
违反特征：字段在 API 响应里，但没有代码负责写它（`baseline_snapshot` 的历史问题）。

### 规律 5：最小能量原理（零配置可运行）

> 去掉所有可选能力后，系统核心必须仍然可以完整运行一件有意义的事。

**ClawTwin 零扩展核心能力（不可去掉）：**

- 设备状态管理（Equipment CRUD + OT readings）
- 阈值告警（基于规则，不依赖 LLM）
- 手动工单（创建/审批/完成，全流程）
- 审计日志

**以下必须是可选的（去掉不影响核心）：**

- LLM 诊断（无 LLM → 规则引擎降级）
- Feishu 通知（无配置 → 静默，仅审计）
- Playbook 引擎（无配置 → 只有手动操作）
- pgvector RAG（无扩展 → 关键词搜索）
- 机器人集成（Phase B+）

---

## 二、ClawTwin 扩展轴（类比 OpenClaw 的扩展体系）

| OpenClaw 扩展轴 | ClawTwin 对应             | 注册方式                               | 去掉的影响                    |
| --------------- | ------------------------- | -------------------------------------- | ----------------------------- |
| Channel         | Connector                 | YAML manifest + adapter class          | 对应数据源停止流入            |
| Agent           | AgentRuntime              | Python class 实现 `_base.AgentRuntime` | AI 降级为规则引擎             |
| Plugin          | IndustryPack              | ZIP/目录包 + `pack.yaml` manifest      | 行业知识/本体/Playbook 不可用 |
| Provider        | LLMProvider               | env 变量 + provider class              | AI 降级                       |
| Skill           | ActionType + FunctionType | YAML 注册到 ontology registry          | 对应 Action 不可调用          |
| MCP             | MCP Server                | 已有，原样保留                         | 外部 Agent 失去工具访问       |
| Hook            | EventDispatcher Sink      | 实现 `_FanoutSink.send()`              | 对应通知通道静默              |

---

## 三、能力注册与检测机制

`infra/capabilities.py` 实现了能力自动检测：

```python
from infra.capabilities import Capability, is_enabled, require

# 降级路径（推荐用于有意义降级的场景）
if is_enabled(Capability.AI):
    result = await llm_diagnose(equipment_id)
else:
    result = rule_based_screening(equipment_id)

# 硬依赖（无降级可能时）
require(Capability.FEISHU)  # 如果 Feishu 未配置，抛出 CapabilityUnavailableError
```

能力自动检测规则：

| Capability | 检测条件                                                     |
| ---------- | ------------------------------------------------------------ |
| `ai`       | `CLAWTWIN_LLM_PROVIDER` 或 `OPENAI_API_KEY` 等 LLM 凭证存在  |
| `feishu`   | `FEISHU_APP_ID` + `FEISHU_APP_SECRET` 同时存在               |
| `pgvector` | `CLAWTWIN_PGVECTOR != 0`（默认开启，若 DB 无扩展则优雅失败） |
| `kb`       | 始终开启（降级到关键词搜索）                                 |
| `playbook` | `ai` 开启且 `CLAWTWIN_PLAYBOOK != 0`                         |
| `robot`    | `CLAWTWIN_ROBOT_ENABLED=1`                                   |

**覆盖方式**：`CLAWTWIN_CAPABILITIES=ai,feishu,-robot` 强制开启 ai/feishu，强制关闭 robot。

---

## 四、IndustryPack 扩展包规范（最小形式化）

一个 IndustryPack 是一个目录，包含：

```
packs/oil-gas-station/
  pack.yaml                 # Pack 元数据（必须）
  ontology/
    object_types/           # 新 Object Type 声明（叠加到全局 Ontology）
    action_types/           # 新 Action Type 声明
    function_types/         # 新 Function Type 声明
  playbooks/                # Playbook YAML 定义
  knowledge/
    L1/                     # 行业领域知识（seed documents）
    L2/                     # 企业策略知识
  pipelines/                # 数据处理 Pipeline 声明
  components/               # 可选：前端组件 / 报告模板
```

`pack.yaml` 最小格式：

```yaml
id: oil-gas-station
display_name: 油气站场运维包
version: 1.2.0
clawtwin_min_version: 2026.5.0
capabilities_required:
  - ai # 此 pack 需要 AI 能力
  - feishu # 此 pack 需要飞书通知
dependencies: []
```

**Pack 加载优先级**：  
Pack 声明的 Object/Action/Function Type 叠加到全局 Ontology Registry。  
同名 Object Type：Pack 声明优先（允许行业专用化）。  
同名 Playbook：版本号高者优先。

---

## 五、最小能量配置示例

### 配置 A：纯本地、零 AI、零云服务

```env
# 无 LLM 凭证 → AI capability = disabled
# 无 Feishu 配置 → Feishu = disabled
CLAWTWIN_PGVECTOR=0         # 纯关键词搜索
CLAWTWIN_PLAYBOOK=0         # 纯手动操作
```

**可以做什么：**

- 读取 OPC-UA 数据
- 规则告警（基于 `alarm_rules` 表）
- 手动创建/审批/完成工单
- 查询知识库（关键词搜索）
- 完整审计日志

**不可以做什么（降级提示，不崩溃）：**

- AI 诊断 → 返回规则引擎结果 + `"evaluated_by": "rule_engine"`
- Feishu 通知 → 静默（仅审计日志）
- Playbook 自动化 → 不展示 Playbook 界面

### 配置 B：标准 SaaS 部署

```env
OPENAI_API_KEY=sk-...
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
CLAWTWIN_PGVECTOR=1
```

**额外激活：**

- AI 诊断（真实 LLM）
- Feishu 通知（真实推送）
- pgvector RAG 搜索
- Playbook 引擎

### 配置 C：完整 + 机器人集成（Phase B）

```env
# 以上所有 +
CLAWTWIN_ROBOT_ENABLED=1
```

---

## 六、EventDispatcher 扩展：如何添加新的通知渠道

只需要继承 `_FanoutSink` 并在应用启动时注册：

```python
# 示例：添加钉钉通知渠道
from infra.event_dispatcher import _FanoutSink, PlatformEvent, register_sink

class DingTalkSink(_FanoutSink):
    name = "dingtalk"

    def send(self, event: PlatformEvent) -> None:
        if event.event_type not in {"alarm.created", "workorder.created"}:
            return
        # ... 调用钉钉 API

# 在 app startup 中：
register_sink(DingTalkSink())
```

不需要修改任何现有代码。这就是 Hook 机制的设计意图。

---

## 八、控制论三定理（系统正确工作的充要条件）

这三个定理来自状态空间控制理论，是数字孪生系统**能否做出正确决策**的充要条件。违反任何一条，AI 诊断的结论都不可信。

### 定理 1：可观测性（Observability）

**定义**：能否从有限传感器完整重建物理状态？

```
代理指标：MetricCoverage = 实际收到的指标 / 期望的指标总数

MetricCoverage = 1.0  → 完全可观测，AI 诊断可信
MetricCoverage < 0.8  → 部分可观测，AI 应降低置信度
MetricCoverage < 0.5  → 严重不可观测，应触发传感器检查工单
```

**实现**：`twin_correspondence.compute_twin_fidelity()` — `metric_coverage` 字段

### 定理 2：可控性（Controllability）

**定义**：能否通过可用的 Action Types 将设备从故障状态恢复到健康状态？

```
对每个 故障模式 f，需要存在：
  ActionSequence(f) = [A₁, A₂, ..., Aₙ]
  使得执行后 health_score > critical_threshold
```

**实现状态**：`equipment_type_action` 表（已有），需要补充 `applicable_fault_modes` 字段  
**Phase B 任务**：建立"故障模式 → Action 映射"的形式化表达

### 定理 3：稳定性（Stability）

**定义**：工单执行后，设备健康分数是否真的上升（Lyapunov 函数收敛）？

```
Lyapunov 函数 V(t) = health_score(t)

稳定 ⟺ ΔV = health_score(t₁) - health_score(t₀) > 0
          （t₀ = 工单创建时，t₁ = 工单完成后 90 分钟）

ΔV < 0 说明：(1)诊断错误，(2)处置不足，(3)新故障引入
```

**实现**：`OutcomeEvent.metric_delta` 就是在测量 ΔV。  
**Knowledge Flywheel 规则**：`ΔV > 0` → 允许生成 L3 KB；`ΔV < 0` → 标记 `needs_review`

---

_以上三定理的详细推导见 `CLAWTWIN-PHYSICS-FOUNDATIONS.md §二`。_

| 违反规律 | 位置                                              | 严重程度  | 修复方向                               |
| -------- | ------------------------------------------------- | --------- | -------------------------------------- |
| 规律 1   | PlaybookRun/OutcomeEvent 直接是裸 DB 表           | 🟡 P1     | Phase B 注册为 Object Type             |
| 规律 2   | alarm FSM 状态变更不经过 EventDispatcher          | 🔴 P0     | `alarm_fsm.py` 中调用 `dispatch()`     |
| 规律 2   | workorder 状态变更不经过 EventDispatcher          | 🔴 P0     | `workorder_fsm.py` 中调用 `dispatch()` |
| 规律 3   | WorkOrder.baseline_snapshot 有字段无写入          | 🔴 P0     | `create_workorder` 时快照设备状态      |
| 规律 4   | `equipment_readings.time` 是 String 不是 DateTime | 🟡 P1     | migration 修改列类型                   |
| 规律 5   | diagnose_equipment 曾经在 AI 未配置时无降级       | ✅ 已修复 | `infra/capabilities.py` 实现           |

---

_本文档定义规律，`CRITICAL-ARCHITECTURE-REVIEW.md` 追踪违反情况。_
