# ClawTwin Nexus 工业 AI 操作系统架构

> **版本**：v1.1 · 2026-05-11（批判性修订版）  
> **洞察来源**：对比 OpenClaw agent-loop 源码与传统 intent 识别架构  
> **核心主张**：Nexus 不是一个应用，而是一个工业 AI 操作系统  
> **v1.1 修订**：补充 Nexus 内部 LLM 调用架构（InternalAIService），修正写工具安全设计，修正分期目标  
> **向量栈（Phase A）**：知识向量以 **PostgreSQL pgvector**（`kb_chunks`）为准（**SKILL 铁律 20**、**DESIGN-FINAL-LOCK**）；独立 **Milvus** 仅 **Phase C** 备选。下文 **MilvusService** 伪代码 = **`kb_chunks` 嵌入 UPSERT** 语义。

---

## 一、从 Intent 识别到 Tool 调用：范式转变

### 旧方式（传统 Agent 开发）

```python
# 传统方式：你必须预先识别所有意图
def handle_message(user_input: str):
    intent, entities = nlp.parse(user_input)  # ← 意图识别，脆弱且有限

    if intent == "check_equipment":
        return check_equipment(entities["equipment_id"])
    elif intent == "create_workorder":
        return create_workorder(entities["equipment_id"], entities["issue"])
    elif intent == "acknowledge_alarm":
        return acknowledge_alarm(entities["alarm_id"])
    elif intent == "query_production":
        return query_production(entities["station_id"], entities["date"])
    # ... 需要预先枚举 100+ 种意图，每一种都是硬编码路径
    # 新场景 = 改代码 + 重训练意图分类器 + 测试 + 部署
```

**问题**：意图有限、组合爆炸、脆弱易错、扩展成本高。

---

### OpenClaw 的方式（Agent Loop + 工具调用）

```javascript
// OpenClaw agent-loop.js 核心（实际源码逻辑）
async function runLoop(context, config) {
  while (true) {
    // 1. LLM 接收所有工具定义 + 对话历史
    const response = await llm.stream({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: context.tools, // ← 所有工具全部暴露给 LLM
    });

    // 2. LLM 自己决定调用哪个工具（或不调用，直接回复）
    const toolCalls = response.content.filter((c) => c.type === "toolCall");

    if (toolCalls.length > 0) {
      // 3. 并行执行工具调用
      const results = await executeToolCalls(toolCalls);
      // 4. 把结果加入消息历史，继续循环
      context.messages.push(...results);
      // 5. 回到步骤1，LLM 看到工具结果后决定下一步
    } else {
      break; // LLM 认为任务完成，停止循环
    }
  }
}
```

**革命性的点**：LLM 自己决定调用哪些工具、以什么顺序、调用几次。没有 if-else 路由，没有意图分类器，代码 **极简**，能力 **无限**。

---

## 二、两种架构对比

```
传统 Intent 架构（ClawTwin 如果不改）：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
用户："C-001 振动高，帮我处理一下"
        ↓
  意图识别器（你必须预先训练这个）
        ↓
  路由到"振动告警处理器"（你必须预先写这个）
        ↓
  硬编码流程：查设备 → 查知识库 → 建工单 → 通知
        ↓
  每一步都是 if-else，每个新场景改代码

问题：新场景必改代码，业务变更必改代码，意图识别准确率80%


OpenClaw Agent Loop 架构（ClawTwin 应该做的）：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
用户："C-001 振动高，帮我处理一下"
        ↓ (OpenClaw 接收消息，无需意图识别)
  LLM 获得全部工具定义（~30个工具）
        ↓
  [Turn 1] LLM 决定：先了解情况
    → 调用 get_equipment_context("C-001")
    → 调用 get_active_alarms(station_id)
    ← 返回：振动4.5mm/s，P2告警，predicted_breach=83min
        ↓
  [Turn 2] LLM 决定：查找处理方案
    → 调用 search_knowledge_base("轴承磨损 振动超限 SY/T 6320")
    ← 返回：SY/T 6320 §5.3.2 轴承检查规程（含引用）
        ↓
  [Turn 3] LLM 决定：创建工单（HITL for 写操作）
    → 调用 create_work_order(equipment_id="C-001", type="corrective",
                              title="轴承振动超限检查", priority="urgent",
                              description="振动4.5mm/s超限，建议...",
                              citations=[...])
    ← 返回：WO-001 (state=draft, 等待审批)
        ↓
  [Turn 4] LLM 决定：通知主管
    → 调用 notify_user(role="supervisor", message="WO-001已创建，请审批")
    ← 返回：已通知张主管
        ↓
  LLM 回复用户："已完成：发现P2振动告警，查阅了SY/T 6320标准，
  创建了工单WO-001（待张主管审批），并已通知主管。"

新场景？不改代码，只更新 Skill 提示词即可。
```

---

## 三、Nexus 作为工业 AI 操作系统

### 3.1 类比：Nexus ≈ Linux 内核

```
Linux 内核模型：                  Nexus 工业 OS 模型：
━━━━━━━━━━━━━━━                  ━━━━━━━━━━━━━━━━━━━━
内核（Kernel）                    Nexus Platform
  系统调用（syscalls）              MCP 工具集（30+ 原子操作）
  文件系统（filesystem）            数据层（PG/TimescaleDB/**pgvector**）
  进程管理（process mgmt）          业务规则（FSM/ABAC/HITL）
  设备驱动（device drivers）        OT 适配器（OPC-UA/MQTT/Modbus）

Shell / 命令行                    clawtwin CLI
  脚本（bash scripts）              工作流脚本
  管道（pipes）                     工具链组合
  cron 定时任务                     调度器（Scheduler）

应用程序（apps）                   Sage Skills
  系统配置（apt install xxx）        skills install industrial-xxx
  运行时决策（ls|grep|awk|xargs）   LLM 链式工具调用

用户                              工业操作员/主管/工程师
  → 运行命令 / 写脚本              → 自然语言 / Studio UI
  → 系统完成工作                   → Nexus 完成工业操作
```

### 3.2 核心洞察：复杂业务 = 简单原子操作的组合

```
不需要预先编写"振动告警处理流程"这个大型函数。

只需要这些原子工具：
  get_equipment_context()    ← 读设备状态
  search_knowledge_base()    ← 查知识
  create_work_order()        ← 写工单
  notify_user()              ← 通知

LLM 自动组合 → 实现任意复杂的业务流程

这就像 Linux 不需要预先写"安装Python"这个命令，
而是有 wget / tar / make / cp 这些原子操作，
用户（或脚本）自己组合。
```

---

## 四、扩展 MCP 工具集（工业 OS 系统调用表）

> 当前：8 个（只读）→ 目标：30+ 个（含写操作，HITL保护高风险操作）

### 4.1 读取类工具（安全，无副作用）

```python
# 设备与状态
get_equipment_context(equipment_id)          # 设备完整上下文+决策包
get_equipment_readings(equipment_id, metric?, hours?)  # 历史时序数据
get_equipment_trend(equipment_id, metric, hours)       # 趋势分析（增/减/平稳）
list_equipment(station_id, status?)          # 设备列表（可按状态过滤）
get_station_overview(station_id)             # 场站概览

# 告警
get_active_alarms(station_id, priority?)     # 活跃告警
get_alarm_kpi(station_id, period)            # ISA-18.2 KPI指标

# 工单
get_work_order(work_order_id)               # 工单详情
list_work_orders(station_id, state?, type?) # 工单列表
get_work_order_history(equipment_id)        # 设备历史工单

# 知识库
search_knowledge_base(query, layer?, equipment_type?)  # 三层语义搜索

# 生产运营
get_production_kpi(station_id, period?)     # 生产KPI（输量/可用率/能耗）
get_shift_status(station_id)               # 当前班次信息
get_overdue_inspections(station_id)        # 逾期巡检列表

# 用户与权限
get_user_info(user_id?)                     # 当前/指定用户信息
list_station_operators(station_id, role?)   # 场站人员列表
```

### 4.2 写入类工具（需 HITL 或权限控制）

```python
# 告警操作（operator 可执行）
acknowledge_alarm(alarm_id, reason?)          # 确认告警
shelve_alarm(alarm_id, duration_minutes, reason)  # 搁置告警（reason必填）

# 工单操作（operator 创建，supervisor 审批）
create_work_order(equipment_id, work_type, title, description,
                  priority?, permit_required?, checklist_items?)
update_work_order_note(work_order_id, note)   # 添加工单备注
complete_work_order(work_order_id, completion_notes, evidence_urls?)
submit_work_order_for_approval(work_order_id) # 提交审批

# 生产运营（operator 可执行）
record_production_data(station_id, date, data)  # 录入日报
submit_shift_handover(station_id, handover_to_id, notes?)  # 发起交接班
trigger_inspection(schedule_id, assignee_id?)  # 触发巡检工单创建

# 知识库（engineer+ 可执行）
add_knowledge_entry(title, content, layer, equipment_type?)  # 添加知识条目

# 通知（所有角色）
notify_user(user_id_or_role, message, urgency?)  # 发送飞书通知

# 高风险操作（supervisor+ 且需明确确认）
approve_work_order(work_order_id)       # 工单审批（HITL强制）
reject_work_order(work_order_id, reason)
update_equipment_status(equipment_id, new_status, reason)  # 手动更改设备状态
```

### 4.3 系统管理工具（sys_admin）

```python
get_system_health()                      # 系统健康状态
list_users(station_id?)                  # 用户列表
create_user(username, role, station_ids) # 创建用户
assign_station(user_id, station_id)      # 分配场站权限
invalidate_cache(scope?)                 # 清除缓存
seed_knowledge_base(layer, source_url)   # 触发知识库导入
```

---

## 五、clawtwin CLI — 让 LLM 可以脚本化整个系统

### 5.1 设计原则

每个 MCP 工具 = 一个 CLI 命令。CLI 和 MCP 共用同一套业务逻辑。

```
clawtwin <模块> <操作> [参数]

clawtwin alarm list --station=1 --priority=P1
clawtwin alarm acknowledge 156 --reason "检修中预期"
clawtwin alarm shelve 157 --duration=60 --reason "备用机切换中"

clawtwin workorder create --equipment=C-001 --type=corrective \
  --title="轴承振动超限" --priority=urgent
clawtwin workorder approve WO-001
clawtwin workorder done WO-001 --notes="更换轴承，振动恢复正常"

clawtwin production record --station=1 --date=today \
  --gas=21.36 --runtime=23.5 --energy=4820
clawtwin shift handover --to=operator_zhang --notes="注意C-001趋势"
clawtwin inspection trigger --schedule=3

clawtwin equipment status C-001
clawtwin kb search "压缩机轴承故障判断"

clawtwin doctor  # 系统健康检查（clawtwin doctor 命令）
```

### 5.2 LLM 可以生成和执行 CLI 命令

```python
# 当 LLM 需要执行复杂操作时，可以通过 bash 工具运行 clawtwin CLI
# 这让 LLM 的能力和 CLI 的能力等价

# 示例：用户说"把今天所有P2告警都搁置60分钟，原因是周末维护"
# LLM 生成并执行：
clawtwin alarm list --station=1 --priority=P2 --status=active --format=ids | \
  xargs -I{} clawtwin alarm shelve {} --duration=60 --reason="周末计划维护"
```

### 5.3 CLI 实现方式（Typer）

```python
# platform/cli.py
import typer
from platform.services import AlarmService, WorkOrderService, ProductionService

app = typer.Typer(name="clawtwin", help="ClawTwin Industrial AI OS CLI")

@app.command()
def alarm_list(station: int, priority: str = None, status: str = "active"):
    """列出告警（支持过滤）"""
    alarms = AlarmService.list(station_id=station, priority=priority, status=status)
    for a in alarms:
        typer.echo(f"[{a.priority}] {a.id}: {a.message} ({a.equipment_id})")

@app.command()
def alarm_shelve(alarm_id: int, duration: int = 60, reason: str = typer.Option(...)):
    """搁置告警（reason必填，ISA-18.2合规）"""
    result = AlarmService.shelve(alarm_id, duration_minutes=duration, reason=reason)
    typer.echo(f"✅ 告警 {alarm_id} 已搁置至 {result.shelved_until}")

# ... 所有 MCP 工具对应的 CLI 命令
```

---

## 六、复利效应：Nexus 越用越强

```
每次交互产生的价值：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

操作员问"C-001振动高怎么处理"
    ↓
LLM调用工具 → 创建工单 WO-001 → 工单完成 → 轴承更换成功
    ↓ 自动提炼（Scheduler Job: workorder_to_knowledge）
L3知识条目："高坪站 C-001 振动超限 → 轴承磨损 → 更换型号 SKF-6205 → 解决"
    ↓ 下次同类问题
LLM搜索知识库 → 找到这条L3经验 → 更快更准确的建议

每关闭一张工单 → 知识库增长一条
每增长一条知识 → AI下次更聪明
这是工业知识的"复利"积累
```

```
资产积累维度：
┌─────────────────────────────────────────────────────┐
│  积累的资产          产生的价值                      │
├─────────────────────────────────────────────────────┤
│  工单历史            → 故障模式识别，预测性维护      │
│  告警规则库          → 智能告警，减少误报            │
│  知识库（L0-L3）     → AI回答更准，引用有据          │
│  巡检记录            → 设备劣化趋势发现              │
│  技改方案文档        → 跨站场经验复用                │
│  操作员对话历史      → 个性化AI助理                  │
│  设备本体知识        → 新设备接入更快                │
│  工作流模板          → 自定义场景一键复用             │
└─────────────────────────────────────────────────────┘
用户每天使用 → 系统越来越懂这个站场 → 价值越来越高 → 替换成本越来越高
```

---

## 七、框架化优势：不是一个应用，是一个平台

### 7.1 新场景扩展：0 代码改动

```
场景：新增"碳排放监控"需求

旧方式：
  ① 写碳排放计算代码
  ② 写碳排放 API
  ③ 写碳排放 UI
  ④ 测试部署
  (2-4周)

Nexus OS 方式：
  ① 添加 energy_records 表（新增能耗记录）
  ② 添加 get_energy_consumption() MCP 工具
  ③ 更新 industrial-analytics Skill 的 prompt（增加碳排放计算说明）
  ④ 操作员即可用自然语言查询碳排放
  (1-2天)
```

### 7.2 不同客户的定制：Skill 即定制

```
# 标准版（通用油气站场）
industrial-twin/SKILL.md     ← 通用设备诊断
industrial-kb/SKILL.md       ← 通用知识库

# 甲客户定制（LNG 储罐站场）
industrial-lng/SKILL.md      ← LNG专属诊断
  triggers: [BOG速率, 液位偏差, 汽化器效率]
  tools: [get_bog_rate, check_tank_level, analyze_vaporizer]
  knowledge: LNG行业标准 GB50646

# 乙客户定制（炼化装置）
industrial-refinery/SKILL.md  ← 炼化专属
  ...
```

**每个客户的专属 Skill = 他们的定制成本极低，Nexus 核心不动**。

### 7.3 升级迭代：工具渐进扩展

```
Phase A（现在）：8个只读工具
  LLM 可以：分析、诊断、建议
  人类：还需要手动执行操作

Phase B（+6个月）：30个工具（含写操作）
  LLM 可以：分析 + 自动执行 + HITL审批
  人类：只处理需要审批的关键决策

Phase C（+18个月）：AI自主执行
  LLM 可以：发现问题 → 分析 → 执行 → 验证 → 总结
  人类：监督和最终确认
  (AI自主度 Level 2→3→4，见 ECOSYSTEM-AND-EXPERIENCE-VISION.md)
```

---

## 八、Nexus 工业 OS 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                   用户（自然语言 / Studio UI）                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │  Feishu Bot / HTTP API
┌──────────────────────────▼──────────────────────────────────────┐
│                    OpenClaw（AI Agent 运行时）                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Sage Skills（Skill prompt 定义AI行为和工具选择策略）     │    │
│  │  industrial-twin / kb / workorder / shift / production  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Agent Loop（pi-agent-core）：                                   │
│  while(有工具调用): LLM决策 → 调用工具 → 处理结果 → 继续         │
└──────────────────────────┬──────────────────────────────────────┘
                           │  MCP Protocol（JSON-RPC 2.0）
┌──────────────────────────▼──────────────────────────────────────┐
│                 Nexus MCP Server（工业 OS 系统调用层）             │
│                                                                  │
│  读取工具（15+）          写入工具（12+）       管理工具（6+）     │
│  get_equipment_context   acknowledge_alarm    get_system_health  │
│  search_knowledge_base   create_work_order   list_users         │
│  get_active_alarms       shelve_alarm        assign_station     │
│  get_production_kpi      record_production   invalidate_cache   │
│  get_shift_status        submit_handover     seed_knowledge     │
│  get_alarm_kpi           notify_user         ...                │
│  ...                     ...                                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │  FastAPI 路由 / 业务服务层
┌──────────────────────────▼──────────────────────────────────────┐
│                 Nexus Business Logic（工业 OS 内核）               │
│                                                                  │
│  认证鉴权（ABAC）  工单FSM  告警引擎(ISA-18.2)  调度器           │
│  知识库(RAG)       Pulse Engine  AgentConnector  审计日志         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      数据层（工业 OS 存储）                        │
│                                                                  │
│  PostgreSQL+TimescaleDB+**pgvector**   Redis（缓存+队列）   （独立 Milvus：Phase C）      │
│  设备/告警/工单/生产/班次+知识向量       决策包缓存           超大规模备选                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│               OT 接入层（工业 OS 驱动层）                          │
│   OPC-UA Bridge → Kafka → Pulse Engine → TimescaleDB            │
│   （设备物理世界 → 数字世界的桥梁）                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 八点五、关键架构澄清：Nexus 内部调用 LLM 的规则

> v1.2 修正：v1.1 中引入的 InternalAIService 违反了架构铁律，已删除并更正为正确实现。

### 8.5.1 铁律重申（不可违反）

```
DEVELOPMENT-CONTRACT.md §三 架构红线：

  Platform 内部永远不直接调 vLLM 做 LLM 推理。
  Platform 只调用：
    ① bge-m3 embedding API（用于知识库向量检索）
    ② MOIRAI 2.0 time-series API（用于设备趋势预测）
  所有语言理解/生成任务，全部由 OpenClaw 处理。
```

### 8.5.2 后台 Job 的正确分工表

```
任务                      Phase A 实现           Phase B 升级
────────────────────────────────────────────────────────────────
L3 知识沉淀（工单→KB）    结构化复制（无LLM）    OpenClaw Skill 提炼
晨报摘要                  Jinja2 模板渲染        OpenClaw Skill 生成
告警预分类                规则引擎（阈值）        OpenClaw Skill 分析
决策包计算                规则 + MOIRAI 2.0      维持不变
时序趋势预测              MOIRAI 2.0             维持不变
用户诊断/对话             OpenClaw（始终如此）    维持不变
```

Phase A 的后台 Job 不依赖 LLM，这是设计上的简洁性，不是功能缺失。
LLM 在 Phase A 只出现在用户交互路径，由 OpenClaw 负责。

### 8.5.3 Phase A 后台 Job 正确实现

```python
# 知识沉淀 = 结构化复制（不调 LLM，符合铁律）
@scheduler.scheduled_job("cron", hour=3, minute=0)
async def workorder_to_knowledge_job():
    completed = await WorkOrderService.get_completed_yesterday()
    for wo in completed:
        # 质量门禁：有备注 + 有证据（结构化检查，非 AI 判断）
        if not wo.execution_notes or len(wo.execution_notes) < 80:
            continue
        if not wo.evidence_urls:
            continue
        # 直接结构化写入 L3（无 LLM 调用）
        await KBService.add_structured_entry(
            title=f"[{wo.equipment_id}] {wo.title}",
            content=wo.to_structured_knowledge(),   # 格式化结构数据
            layer="L3",
            status="pending_review",                # 人工审核后才发布
            station_id=wo.station_id,
            source_work_order_id=wo.id,
        )
        # 向量写入：bge-m3 embed → **pgvector** / `kb_chunks`（实现名可仍为向量服务门面）
        await KBVectorService.upsert(wo.id, wo.to_embedding_text())

# 晨报 = Jinja2 模板渲染（不调 LLM）
@scheduler.scheduled_job("cron", hour=7, minute=0)
async def morning_report_job():
    ctx = await ReportService.build_morning_context()
    text = MORNING_REPORT_TEMPLATE.render(ctx)  # 模板，非 AI
    await FeishuClient.send_group_message(ctx.station_id, text)
```

### 8.5.4 Phase B：LLM 增强后台 Job 的正确路径

```python
# Phase B：LLM 提炼知识（正确路径：AgentConnector → OpenClaw → vLLM → 回调）
async def workorder_to_knowledge_v2(wo_id: int):
    await AgentConnector.trigger_session(
        skill="industrial-kb",
        task={"type": "extract_knowledge", "work_order_id": wo_id},
        callback_url=f"/v1/ai/jobs/{wo_id}/result",  # OpenClaw 完成后回调
    )
    # OpenClaw 会调用 MCP 工具获取工单数据、生成摘要、回调写入 KB
    # Nexus 全程不调 vLLM（OpenClaw 负责推理）
```

---

## 九、实现优先级：让系统变成 OS

### 9.1 Phase A 必须完成（让 LLM 能做基础操作）

**每个写操作工具必须有明确的安全契约（Safety Contract）：**

```python
# 写工具的安全契约示例
create_work_order:
  - 单次调用，只能创建 1 个工单（不支持批量）
  - state 服务端强制 = "draft"（LLM 无法创建已批准的工单）
  - LLM 必须在回复中展示草稿内容，让用户确认后才视为"已创建"
  - 触发飞书卡片通知 supervisor（人在循环）

shelve_alarm:
  - duration 上限：480 分钟（8小时），超出需 supervisor 角色
  - reason 最少 10 字符（防止 LLM 填 "ok"、"."）
  - 单次一个 alarm_id，不接受列表

acknowledge_alarm:
  - 仅当 alarm 状态为 active 时有效
  - 自动记录操作人（从 ServiceToken 中取，不接受 LLM 传参）

record_production_data:
  - outage_minutes > 60 时 reason 必填（DESIGN-FINAL-LOCK §二a 铁律）
  - 同一站场同一日期只能录入一次（幂等保护）

notify_user:
  - 频率限制：同一用户同类消息，10分钟内最多 1 条（防骚扰）
  - 只能通知本 station_id 内的用户（跨站推送需 admin）
```

### 9.2 clawtwin CLI（Phase A 一并实现）

```bash
# 每个 MCP 工具对应一个 CLI 命令
# 实现方式：共享 Business Service 层，不重复逻辑
platform/cli.py  ← Typer 应用，所有命令
                     ↕ 共用
platform/services/*.py  ← 业务服务层
                     ↕ 同样被
platform/routers/mcp.py  ← MCP Server
```

### 9.3 workorder_to_knowledge 知识飞轮（Phase A Scheduler）

⚠️ **必须有质量控制**：垃圾工单 → 垃圾知识 → AI 越用越差。

```python
# Phase A：结构化复制（不调 LLM，符合 DEVELOPMENT-CONTRACT §三 架构铁律）
@scheduler.scheduled_job("cron", hour=3, minute=0)
async def workorder_to_knowledge_job():
    """工单完成 → 结构化写入 L3 知识库（Phase A 无 LLM，Phase B 由 OpenClaw 提炼）"""
    completed = await WorkOrderService.get_completed_yesterday()

    for wo in completed:
        # 质量门禁（规则检查，不需要 LLM）
        if not wo.execution_notes or len(wo.execution_notes) < 80:
            continue
        if not wo.evidence_urls:   # 无现场证据 → 跳过
            continue

        # Phase A：结构化写入（直接格式化工单数据，无 AI 生成）
        await KBService.add_structured_entry(
            title=f"[{wo.equipment_id}] {wo.title}",
            content=wo.to_structured_knowledge(),  # 格式化字段，非 AI 生成
            layer="L3",
            status="pending_review",               # 人工审核后才发布
            station_id=wo.station_id,
            equipment_type=wo.equipment.type,
            source_work_order_id=wo.id,
        )
        # 向量写入：bge-m3 embed → **pgvector** / `kb_chunks`（实现名可仍为向量服务门面）
        await KBVectorService.upsert(wo.id, wo.to_embedding_text())

# Phase B：升级为 OpenClaw 提炼（LLM 推理由 OpenClaw 负责，Nexus 不直调 vLLM）
# await AgentConnector.trigger_session(skill="industrial-kb",
#     task={"type": "extract_knowledge", "work_order_id": wo.id},
#     callback_url=f"/v1/ai/jobs/{wo.extraction_job_id}/result")
```

**分期目标修正（v1.0 有内部矛盾，已更正）：**

```
Phase A（当前，Week 1-12）：13 个工具（8读 + 5写）
  写操作：create_work_order / acknowledge_alarm /
          shelve_alarm / record_production / notify_user
  HITL：所有写操作 state=draft，必须人工确认才生效

Phase B（+6个月）：再增加 10 个工具
  增加：submit_handover / trigger_inspection / approve_work_order
  增加：批量操作（限定场景，有次数上限保护）

Phase C（+18个月）：AI 自主执行工具（Level 3-4 自主度）
  AI 可在人类定义的边界内自主执行（需独立 OT 安全评审）
```

---

## 十、这不仅仅是技术架构，这是商业护城河

```
用户越用 → Nexus 越聪明（知识积累）
            Nexus 越懂这个站场（L3知识）
            替换成本越高（数据资产沉淀）
            新需求满足越快（工具+Skill扩展）

这是平台商业模式的精髓：
  Amazon：卖家越多 → 选品越多 → 买家越多 → 卖家越多（飞轮）
  Nexus：用户越多 → 知识越多 → AI越强 → 用户越粘性（工业知识飞轮）

竞争对手必须：
  ① 从零构建全套 MCP 工具（6-12个月）
  ② 重新积累工业知识库（需要真实用户运营）
  ③ 重新建立工具信任度（安全/准确性验证）
  Nexus 的先发积累 → 难以追赶的差距
```

---

_本文档定义了 ClawTwin Nexus 从"业务系统"到"工业 AI 操作系统"的架构跃迁。_  
_核心变化：扩展 MCP 工具集（30+），实现 clawtwin CLI，建立知识飞轮 Scheduler Job。_  
_参考：OpenClaw agent-loop.js（工具调用循环机制），INDUSTRIAL-SCENARIOS-COMPLETE.md（工业场景）_
