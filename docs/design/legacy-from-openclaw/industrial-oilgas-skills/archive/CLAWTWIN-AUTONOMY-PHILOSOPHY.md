# ClawTwin 自主运行架构哲学（Autonomy-First Design Philosophy）

> **版本**：v1.0 · 2026-05-12  
> **地位**：ClawTwin 设计哲学的最深层文档。本文定义「为什么这样设计」，上层文档定义「设计是什么」。  
> **核心命题**：物理世界能够自主运行；数字孪生系统应以同样的方式设计——**闭环自洽为默认，人类介入为策略性选择**。

---

## 一、设计哲学的根本转变

### 1.1 两种世界观的对比

```
传统工业软件世界观（以人为中心）：
  「系统是工具，人是决策者。」
  数据 → 显示给人看 → 人判断 → 人操作 → 系统执行
  AI 的位置：辅助人看数据（可视化、报警）

自主运行世界观（以系统为中心）：
  「物理世界有自己的运行规律；数字孪生应当忠实映射并按同样规律运行。」
  数据 → 系统理解 → 系统判断 → 系统执行
  人的位置：高风险决策节点的参与者、系统边界的守护者
  AI 的位置：每一个需要「理解上下文才能判断」的节点的能力提供者
```

**关键洞察**：  
工厂里的压缩机，在没有人干预时，它按照热力学规律运转。  
管道里的流体，按照流体动力学规律流动。  
这些物理系统是**自主运行的闭环**——能量守恒、质量守恒。  
问题不是「物理系统能不能自主运行」，而是「我们的数字系统为什么要假设必须有人在每个节点盯着？」

### 1.2 人类系统的本质

所有人类构建的运营系统（工厂、油气站场、电网调度）都是**设计为可以持续自主运行的**：

- 操作员不是让系统运转的，系统原本就在运转
- 操作员是在系统**偏离设计包络**时进行干预的
- 设计好的系统，操作员一班 8 小时里大部分时间是在「监视」而不是「操作」

**这意味着：**

- 系统的正常运行路径应该是**无人介入的自动路径**
- 人的介入应该是**例外路径**，而不是必要路径
- 当前工业软件的设计倒置了这个关系

---

## 二、HCPS 框架（Human-Cyber-Physical Systems）

这个哲学在学术界和工业界已有成熟表达：

```
传统 CPS（Cyber-Physical Systems，2010s）：
  Physical Layer ←→ Cyber Layer（传感、计算、控制）
  人在系统外部，是操作者

HCPS（Human-Cyber-Physical Systems，2020s 主流）：
  Physical Layer ←→ Cyber Layer ←→ Human Layer
  人是系统的一个组成部分，与 AI 和物理过程并列

                    ┌──────────────────────┐
                    │   Human Layer        │
                    │  （决策节点之一）      │
                    └─────────┬────────────┘
                              │ 双向交互
                    ┌─────────┴────────────┐
                    │   Cyber Layer (AI)   │
                    │  （主要决策执行层）    │
                    └─────────┬────────────┘
                              │ 传感/控制
                    ┌─────────┴────────────┐
                    │  Physical Layer      │
                    │  （物理世界，自主运行）│
                    └──────────────────────┘
```

**ClawTwin 的对应**：

- Physical Layer → OPC-UA Bridge + 传感器时序数据
- Cyber Layer → Ontology + 孪生状态 + AgentRuntime（智能决策）
- Human Layer → HITL checkpoint + 飞书审批 + Studio 操作

---

## 三、自主运行金字塔（Autonomy Pyramid）

类比汽车自动驾驶的 SAE L0–L5，工业系统也有自主运行等级：

```
Level 5: 全自主运行（Fully Autonomous）
  系统根据物理状态和业务策略完全自主决策和执行
  人只负责策略制定和系统边界监督
  · 适用场景：极成熟、低风险、高频的例行操作（每小时跑 N 次的数据聚合、定期校验）

Level 4: 有条件自主（Conditional Autonomous）
  在已定义的「运行包络」内完全自主
  超出包络时自动降级到 L3
  · 适用场景：P3/P4 普通告警的自动确认和工单创建

Level 3: 有监督自主（Supervised Autonomous）
  AI 执行，同时通知人类；人类在超时前可以否决
  · 适用场景：非紧急的 P2 告警处理、例行维修工单生成

Level 2: AI 建议（AI-Assisted）
  AI 生成带置信度的建议，人类一键采纳或修改
  · 适用场景：复杂诊断、不常见故障、涉及多设备联动

Level 1: AI 解释（AI-Informed）
  AI 展示相关数据、历史案例、知识检索结果；人类完全决策
  · 适用场景：高风险作业（动火作业票、安全泄放）、首次发生的故障类型

Level 0: 纯人工（Manual）
  纯规则或纯人工；AI 不参与
  · 适用场景：法规要求必须人工操作的安全仪表系统（SIS/SIL 相关）
```

**ClawTwin 的设计原则**：

- **默认从 L3 开始**，而不是从 L1 开始，然后逐步提升
- **不同 Action Type 的 autonomy_level 是配置的**，不是硬编码的
- **系统在积累了足够 OutcomeEvent 数据后**，可以安全地将 autonomy_level 提升

---

## 四、「Agent 作为 if/else 替代」的精确架构

### 4.1 传统决策节点 vs 智能决策节点

```python
# 传统方式：硬编码规则
def handle_alarm(alarm):
    if alarm.priority == "P1":
        create_workorder(alarm, priority="urgent")
        notify(role="supervisor")
    elif alarm.priority == "P2":
        if alarm.duration > 30:  # minutes
            create_workorder(alarm)
    # else: ignore

# 问题：
# · alarm.priority 由谁设置？一个更底层的 if/else
# · 同样的 P2，在夜班和白班应该处理方式一样吗？
# · 同样的 P2，在同设备上的第 3 次和第 1 次一样吗？
# · 这段逻辑无法学习和改进
```

```python
# 智能决策节点方式
def handle_alarm(alarm, context: InvocationContext):
    # 1. 评估当前情境（物理状态 + 运行历史 + 知识）
    decision = agent.evaluate(
        event=alarm,
        twin_state=get_twin_state(alarm.equipment_id),
        history=get_alarm_history(alarm.equipment_id, window="30d"),
        knowledge=search_kb(f"{alarm.equipment_type} {alarm.type}", layers=["L3","L2"]),
        policy=get_policy(context)
    )
    # decision 包含：recommended_action, confidence, reasoning, autonomy_level

    # 2. 根据置信度和策略选择执行模式
    if decision.confidence >= policy.auto_threshold and \
       decision.autonomy_level <= context.policy.max_auto_level:
        # 自动执行
        execute_action(decision.recommended_action, ctx=context)
        emit_event("alarm.decision.auto", decision)
    elif decision.confidence >= policy.suggest_threshold:
        # 推送建议，等待人类确认
        present_to_human(decision, timeout=policy.hitl_timeout)
        # 人类确认后恢复执行，或修改
    else:
        # 置信度不足，直接升级给人类并提供 AI 分析背景
        escalate_to_human(alarm, ai_analysis=decision)

# 优势：
# · 同一告警，在不同班次、设备历史、当前 KB 知识下，得到不同的决策
# · 决策过程留下 reasoning_trace，可审计
# · 随 OutcomeEvent 积累，confidence 模型不断改进
# · autonomy_level 是可配置的策略，不是硬编码
```

### 4.2 IntelligentDecisionNode：核心新抽象

这是「Agent 替代 if/else」的架构实体：

```yaml
# ontology/decision_nodes/<id>.yaml（建议新增 Object Type）
api_name: IntelligentDecisionNode
description: 业务流程中一个需要「理解上下文才能决策」的节点

properties:
  node_id: string
  domain: string # alarm_handling | workorder_creation | maintenance_scheduling

  # 触发条件（此节点何时激活）
  trigger_condition: jexl_expr

  # 决策逻辑（按优先级顺序评估）
  decision_logic:
    - type: rule # 先尝试确定性规则（快、可审计）
      condition: jexl_expr
      action: string
      confidence: 1.0 # 规则 = 100% 置信度
    - type: agent_function # 规则无法覆盖时，调用 AI
      function: string # Function Type api_name
      min_confidence: 0.75 # 低于此值不自动执行

  # 执行策略（按 autonomy_level 决定如何执行结果）
  execution_policy:
    autonomy_level: enum # L0-L5（见金字塔）
    operational_envelope: # 满足这些条件才允许 L3+
      time_of_day: "06:00-22:00"
      equipment_age_days_max: 365 # 新设备不允许自主处理
      recent_similar_resolved: true # 近期有成功案例
    fallback_level: int # 包络不满足时降级到此 level

  # 结果测量（与 OutcomeEvent 对齐）
  outcome_measurement:
    delay_minutes: 60
    success_metric: "equipment.status == 'normal'"
```

---

## 五、数字孪生的「自洽运行」模型

### 5.1 物理世界 vs 数字世界的对应

```
物理世界的闭环：
  压缩机运转 → 产生热量 → 冷却系统响应 → 温度平衡
  （无需人类介入，物理规律自动平衡）

数字孪生的闭环：
  传感数据入库 → Twin State 更新 → 规则/Agent 评估 → 决策执行
  → OutcomeEvent → 知识更新 → 下次更好的决策
  （无需人类介入，系统按策略自动平衡）

人类的角色：
  物理世界：设计压缩机的参数、设定冷却规格
  数字世界：定义 Autonomy Policy、审核 AI 改进的知识、处理超出包络的异常

  两者共同点：人类设定「规律」，系统执行「规律」
```

### 5.2 完整的自主运行循环

```
                ┌──────────────────────────────────────┐
                │         物理世界持续运行              │
                │  设备运转·流体流动·化学反应           │
                └─────────────────┬────────────────────┘
                                  │ 传感器采集（被动）
                ┌─────────────────▼────────────────────┐
                │         数字孪生层（实时镜像）         │
                │  Twin Shadow(Redis) + History(TSDB)   │
                └─────────────────┬────────────────────┘
                                  │ 异常检测（主动）
                ┌─────────────────▼────────────────────┐
                │   IntelligentDecisionNode 评估层      │
                │   ┌──────────┐   ┌──────────────┐   │
                │   │  规则引擎 │   │  Agent 推理  │   │
                │   │(确定性)  │   │(不确定性)    │   │
                │   └──────────┘   └──────────────┘   │
                │         ↓ Decision + Confidence      │
                └─────────────────┬────────────────────┘
                                  │ 路由：按 autonomy_level
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
       [L4-L5 自动执行]    [L2-L3 推送给人]    [L0-L1 升级给人]
       ActionExecutor      飞书卡片/Studio     紧急通知+AI背景
              │                   │                    │
              └───────────────────┴────────────────────┘
                                  │ 所有路径都执行
              ┌───────────────────▼────────────────────┐
              │         OutcomeEvent 测量层             │
              │  执行后 N 分钟：物理状态是否恢复正常？   │
              └───────────────────┬────────────────────┘
                                  │ 反馈
              ┌───────────────────▼────────────────────┐
              │         知识与策略更新层                │
              │  L3 KB 更新 · EvalRun · Autonomy 校准  │
              └───────────────────┬────────────────────┘
                                  │ 回到起点
                                  ▼
                        下一次更好的决策
```

**这个循环与物理世界的闭环是同构的**——物理世界靠「物理规律」自洽，数字系统靠「策略 + 学习」自洽。

---

## 六、人类在系统中的精确定位

### 6.1 人类不是「主宰」，而是「特殊节点」

```
人类在 HCPS 中的三种角色（同一个人可能同时扮演）：

角色 A：策略设计者（Strategy Designer）
  · 定义 Autonomy Policy（哪些事系统可以自主处理）
  · 定义 Operational Envelope（在什么条件下允许自主）
  · 审核 AI 改进的知识和决策模板
  · 频率：低（周/月级别）
  · 这是人类「最有价值」的角色

角色 B：异常处理者（Exception Handler）
  · 处理系统判断「置信度不足」的案例
  · 处理超出 Operational Envelope 的情况
  · 处理首次出现的故障类型
  · 频率：中（每班数次）
  · 这是人类「认知价值」的发挥

角色 C：监督者（Supervisor/Auditor）
  · 查看 Playbook 运行历史和 AI 决策记录
  · 在安全合规要求的场景做最终确认
  · 频率：高（但每次耗时短）
  · 这是人类「存在价值」（监管、合规、责任承担）
```

**设计原则：最大化角色 A，最小化角色 B，保留必要的角色 C。**

### 6.2 人类参与的「精确度」

当前问题：系统把所有决策都推给人，导致操作员「告警疲劳」和「决策疲劳」。  
改进：系统只在 **真正需要人类认知** 的地方请示人类，且每次请示都携带：

- AI 对情况的完整分析（不是「有问题，请处理」）
- 推荐的行动（不是「请你想」）
- 置信度（「我 82% 确定，但这是我不确定的部分」）
- 行动的代价（「如果批准，会产生以下影响」）

这样人类的决策成本**大幅降低**，每次请示都值得。

---

## 七、业界参考系统与设计思想

### 7.1 工业侧

| 系统/平台                                    | 自主运行程度 | 核心设计思想                                                       |
| -------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| **Palantir AIP for Defense/Industrial**      | L3-L4        | AI 作为操作辅助主体，人类设定策略并处理例外；「Human-centered AI」 |
| **Siemens Digital Enterprise + MindSphere**  | L3-L4        | 数字孪生驱动生产优化；AI 循环调度，人类监督                        |
| **Honeywell Forge Operational Intelligence** | L2-L3        | 预测性维护 + 工作流自动化；AI 建议，人类批准                       |
| **ABB Ability OCTOPUS**                      | L3-L4        | 船舶自主运行；Agent 处理航行决策，船员监督                         |
| **GE Digital APM**                           | L2-L3        | 资产绩效管理；AI 分析故障模式，自动生成维修计划                    |
| **AVEVA System Platform**                    | L2-L3        | 过程工业数字孪生；规则 + AI 协同决策                               |

### 7.2 更广泛的设计思想参考

**① Viable System Model（VSB，Stafford Beer，1970s）**

> 组织/系统的本质是一个递归的自调节结构。每一层都有自己的感知、决策、执行能力，只在处理不了的时候向上请示。  
> **ClawTwin 对应**：IntelligentDecisionNode 是 VSB 中每个层级的「感知+决策+执行」单元。

**② Autonomous Systems Engineering（ASE）**

> 系统设计应明确定义「自主包络」（在哪些条件下系统可以自主）和「降级路径」（包络外如何安全地移交控制权）。  
> **ClawTwin 对应**：OperationalEnvelope + autonomy_level fallback。

**③ Human Factors Engineering（人因工程）**

> 著名的「99%规则」：设计应使 99% 的操作无需人工干预；只有 1% 的异常情况需要人类介入——但这 1% 的界面设计要极其优秀。  
> **ClawTwin 对应**：L3-L5 处理日常，L0-L2 精心设计的飞书卡片/Studio 界面处理异常。

**④ Digital Thread（数字线索）**

> GE 提出：产品从设计、制造、使用到退役，存在一条连续的数字记录。任何时刻都能通过数字线索追溯任何状态。  
> **ClawTwin 对应**：Lineage + LLM Trace + OutcomeEvent 构成的完整决策线索。

**⑤ Closed-Loop Manufacturing（SAP / Siemens）**

> MES（制造执行）和 PLM（产品生命周期）的双向闭环。不只是「执行计划」，而是「执行 → 测量 → 反馈 → 改进计划」。  
> **ClawTwin 对应**：Platform Flywheel 四条路径。

---

## 八、这个哲学对 ClawTwin 架构的具体影响

### 8.1 核心业务逻辑的差异

```
传统（人机交互中心）：
  核心问题：「如何帮助人做出更好的决策？」
  逻辑形态：显示数据 → 等待输入 → 执行命令
  AI 位置：提供更好的信息展示（可视化、推荐）
  系统状态：等待中

自主运行哲学（系统自治为主）：
  核心问题：「系统如何在没有人的情况下正确运行？人在哪些点上增加了价值？」
  逻辑形态：感知变化 → 评估情境 → 选择行动 → 执行 → 测量结果
  AI 位置：每个「评估情境」节点的能力来源
  系统状态：持续运行
```

### 8.2 需要改变的三个核心设计

**改变 1：Playbook 的默认模式**

- 之前：Playbook 以 `hitl_checkpoint` 为正常路径，自动执行为特殊情况
- 改变后：Playbook 以**自动执行为正常路径**，`hitl_checkpoint` 为策略性节点

```yaml
# 改变后的默认 Playbook 哲学：
steps:
  - id: diagnose
    type: function
    # 诊断结果直接用于下一步
  - id: decide
    type: intelligent_decision_node # 新增 step 类型
    node: alarm-handling-node
    # 这里会根据 autonomy_level 自动决定：
    # · L4+ → 自动执行推荐的 action
    # · L2-3 → 推送卡片给人类
    # · L0-1 → 升级
```

**改变 2：Action Type 增加 Autonomy 声明**

```yaml
# ontology/action_types/create_workorder.yaml 增加：
autonomy:
  default_level: 3 # 默认 L3（有监督自主）
  max_level: 4 # 策略允许最高 L4（条件自主）
  envelope_required: # L4 要求满足的包络条件
    - equipment_age_days_max: 365
    - recent_outcome: recovered # 近期类似操作成功
  escalation_reason_required: true # 超出包络必须说明原因
```

**改变 3：System Default State = Running，not Idle**  
系统启动后应进入「持续监控 + 自主处理」状态，而不是「等待用户操作」状态。  
Scheduler 不只是「定时任务」，而是**系统的心跳**——每个 tick 都在评估是否有需要处理的状态变化。

### 8.3 新增的核心 Object：`OperationalEnvelope`

```yaml
api_name: OperationalEnvelope
description: 定义系统在无人干预下可以自主处理的「安全边界」
properties:
  scope: station | equipment_type | action_type
  conditions:
    - type: time_window
      value: "06:00-22:00" # 只有白班可以自主处理
    - type: equipment_age
      max_days: 365 # 设备投用超过 1 年才允许
    - type: recent_success_rate
      function_type: DiagnoseEquipment
      min_rate: 0.85 # 近 30 次诊断准确率 > 85%
    - type: similar_outcome_exists
      lookback_days: 90 # 近 3 个月有相似成功案例
    - type: not_in_maintenance
      check: equipment.status != 'maintenance'
  current_status: enum # active | degraded | suspended
  last_evaluated: datetime
  suspended_reason: string | null
```

---

## 九、安全边界：什么不应该被自主化

这是「最大化 AI 替代」哲学中**最重要的限制**，不是保守，而是工程理性：

```
绝对不允许自主化（Level 0，永远需要人）：
  · 安全仪表系统（SIS/SIL）的操作
  · 紧急停车（ESD）
  · 涉及生命安全的作业许可（动火票、受限空间进入）
  · 首次部署新 Playbook/Policy 的批准
  · 设备退役决定
  · 影响超过 N 万元的预算决策

谨慎自主化（L2-L3，默认需要人确认，可升级到 L4）：
  · P1 告警的处理
  · 计划外停机的工单创建
  · 超过阈值时间的搁置告警
  · 涉及多设备的关联操作

可以完全自主化（L4-L5，满足包络条件时）：
  · P3/P4 普通告警的确认
  · 定期巡检任务的触发
  · 晨报/日报的生成和发送
  · 知识文档的 L3 草稿生成（需 KB Admin 最终审核）
  · 传感器数据的异常标记（quarantine）
  · 历史数据的聚合和归档
```

---

## 十、对既有 ClawTwin 设计的审视

**哪些设计已经与此哲学一致（不需要改变）：**

- ✅ Agent 作为能力提供者（AgentRuntime 抽象）
- ✅ Action Type 有 risk_level（基础的自主化判断）
- ✅ Pipeline 自动运行（数据面已经是自主的）
- ✅ Scheduler 持续触发（心跳机制已有）
- ✅ OutcomeEvent（结果反馈）
- ✅ HITL 作为可选节点（而不是必须节点）

**需要增补的设计：**

- ❌ IntelligentDecisionNode（显式的决策节点抽象）
- ❌ Autonomy Level 在 Action/Playbook 上的声明
- ❌ OperationalEnvelope（自主运行边界）
- ❌ 自主降级路径（包络失败时的安全降级）
- ❌ 「系统默认运行」的 Scheduler 主循环设计

---

## 十一、最终定位语（修订版）

**之前（技术定位）：**  
「ClawTwin = 以工业本体为核心的企业业务平台；智能体是可插拔能力。」

**更新（哲学定位）：**  
「ClawTwin = 工业物理世界的**自洽数字镜像**。  
本体与孪生是物理世界的精确映射，  
每一个决策节点都由规则或 AI 自主处理，  
人类是系统的**策略制定者**和**边界守护者**，  
而不是每个操作的执行者。」

---

_本文档定义 ClawTwin 的设计哲学，不含具体实现。实现见 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`（架构）、`CLAWTWIN-ARCHITECTURE-DEEPENING.md`（Schema）。_  
_在每次产品战略评审时，先确认本文的哲学立场，再评估技术实现是否与之一致。_
