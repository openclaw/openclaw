# Nexus 无界集成架构：作为工业 AI 底座的设计

**版本**：1.0，2026-05-11  
**核心命题**：Studio 是 Nexus 的一个"消费端"，不是 Nexus 的全部。  
**关键洞见**：企业 IT 部门可以不用 Studio，直接把 Nexus 作为 AI 数据底座，接入自己的 OA/BPM/ERP/MES 系统。

---

## 一、架构哲学：Nexus 的"无界"定位

### 1.1 错误认知 vs 正确认知

```
❌ 错误认知：
  Nexus 是一个"带 Studio UI 的工业软件"
  用户必须打开 Studio 才能获得 AI 辅助
  OA 审批流是另一套系统，Nexus 和它无关

✅ 正确认知：
  Nexus 是"工业 AI 语义层"（Industrial AI Semantic Layer）
  任何需要工业设备智能的系统，都可以调用 Nexus
  Studio 只是众多"消费端"之一

  消费端谱系：
    Studio（我们自研）      → 最完整的操作体验
    飞书 Bot（我们自研）    → 移动端 + 即时审批
    OA 审批流（客户系统）   → 现有流程 AI 增强
    ERP/CMMS（客户系统）    → 数据集成
    自研大屏（客户定制）    → 可视化展示
    API 直调（客户开发）    → 完全自主集成
```

### 1.2 类比：OpenClaw 的"渠道"概念

```
OpenClaw 的架构启示：
  Core 智能（LLM + 知识 + 工具）与 Channel（渠道/界面）完全分离
  同一个 AI 助手可以通过 Telegram、Discord、Slack、飞书提供服务
  Channel 只是"传递智能的媒介"

ClawTwin 的对应设计：
  Core 智能（Pulse Engine + KB + 工单 FSM + AI Jobs）与 Interface 完全分离
  同一个工业 AI 可以通过 Studio、飞书 Bot、OA 接口、REST API 提供服务
  Interface 只是"传递智能的媒介"

产品化表达：
  "无论您使用哪个系统——Studio、飞书、OA、ERP——
   ClawTwin Nexus 始终在后台为您的每一个工业决策提供 AI 支持。"
```

---

## 二、Nexus 的三层接口架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                    Interface Layer（接口层）                             │
│  ┌───────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────┐  │
│  │  Studio   │  │ 飞书 Bot │  │  OA/BPM  │  │ ERP/CMMS │  │  API  │  │
│  │（我们自研）│  │（我们自研）│  │（客户系统）│  │（客户系统）│  │（直调）│  │
│  └─────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬───┘  │
│        │              │              │              │              │      │
└────────┼──────────────┼──────────────┼──────────────┼──────────────┼────┘
         │              │              │              │              │
┌────────▼──────────────▼──────────────▼──────────────▼──────────────▼────┐
│                    API Gateway Layer（统一 API 网关）                     │
│                                                                          │
│  ┌─────────────────────┐  ┌───────────────────┐  ┌──────────────────┐  │
│  │  User API（用户态）   │  │  Context API     │  │  Webhook 订阅    │  │
│  │  /v1/equipment/*    │  │  /v1/ctx/*（富上下文）│  │  /v1/webhooks/* │  │
│  │  /v1/workorders/*   │  │  OA/ERP 集成专用   │  │  事件推送        │  │
│  │  /v1/kb/*           │  └───────────────────┘  └──────────────────┘  │
│  │  JWT 鉴权           │                                                 │
│  └─────────────────────┘                                                 │
│  ┌─────────────────────┐  ┌───────────────────┐                         │
│  │  Tool API（机器态）   │  │  Embed Widget API │                         │
│  │  /v1/tools/*         │  │  /v1/embed/*      │                         │
│  │  Service Token 鉴权  │  │  JS Widget 嵌入   │                         │
│  └─────────────────────┘  └───────────────────┘                         │
└──────────────────────────────────────────────────────────────────────────┘
         │
┌────────▼─────────────────────────────────────────────────────────────────┐
│                    Nexus Core（工业 AI 核心）                              │
│  Pulse Engine / KB / WorkOrder FSM / AI Jobs / Alarm / Ontology          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 三、OA 审批流的 AI 增强架构

### 3.1 场景：飞书 OA 审批单中的 AI 辅助

```
传统 OA 审批流（无 Nexus）：
  1. 操作员在 OA 中填写"设备维修申请"
  2. 主管在 OA 中收到审批请求
  3. 主管查看基本信息（申请人/设备名/问题描述）
  4. 主管凭经验判断是否批准
  → 问题：主管可能不知道设备的实际状态，决策质量差

接入 Nexus 后的 OA 审批流：
  1. 操作员在 OA 中填写"设备维修申请"
     · OA 调用 Nexus /v1/ctx/ai-draft-form 预填建议内容
     · 症状描述、建议操作、紧急程度自动预填（操作员确认即可）
  2. 操作员提交 → OA 触发 Nexus Webhook（新工单）
     · Nexus 自动异步启动 AI 分析
  3. 主管在 OA 中收到审批请求
     · OA 调用 Nexus /v1/ctx/workorder/{id} 获取 AI 决策上下文
     · 在 OA 审批界面内显示：
       ─────────────────────────────────────
       🤖 AI 辅助决策信息（由 ClawTwin 提供）
       设备健康分：62/100 ⚠️ 警告
       AI 诊断：轴承振动频率持续升高，预计 48h 内超阈值
       推荐操作：更换轴承衬套（预计 4 小时工期）
       参考案例：3 起相似案例（均在 60 天内复发）
       置信度：85% | 数据截止：2 分钟前
       ─────────────────────────────────────
  4. 主管看到 AI 上下文后决策，点击批准/驳回
  5. OA 审批结果通过 Nexus Webhook 回调 → 更新工单状态
```

### 3.2 Context API 设计（OA 集成核心）

```
Context API 的设计原则：
  · 一次调用返回所有决策所需信息（减少 OA 集成复杂度）
  · 响应为"决策友好"格式（文字摘要，而非原始数据）
  · Service Token 鉴权（OA 系统是机器身份）
  · 限流：OA 每个审批项最多调用 3 次（防止滥用）
```

**Context API 完整定义**：

```
GET /v1/ctx/workorder/{wo_id}
  鉴权：X-Nexus-Service-Token（OA 系统专用 Service Token）

  Response 200:
  {
    "workorder": {
      "wo_id": "W-20260511001",
      "title": "C-101 轴承振动异常处理",
      "state": "pending_approval",
      "created_by": { "name": "张三", "emp_id": "E001" },
      "created_at": "2026-05-11T02:30:00Z",
      "symptom": "进口压缩机振动超标，持续 6 小时",
      "suggested_action": "停机检查并更换轴承衬套"
    },
    "equipment_context": {
      "tag": "C-101",
      "name": "1号进站压缩机",
      "equipment_type_cn": "离心式压缩机",
      "health_score": 62,
      "health_status_cn": "警告",
      "health_trend_cn": "持续下降",
      "critical_metrics": [
        { "name_cn": "振动速度", "value": 7.2, "unit": "mm/s",
          "status": "warning", "threshold": 6.0 }
      ],
      "active_alarm_count": 1,
      "highest_alarm_level": "P3"
    },
    "ai_analysis": {
      "summary": "轴承振动频率在过去 6 小时内从 4.8mm/s 持续升至 7.2mm/s，上升速率约 0.4mm/s/h。根据历史数据和 MOIRAI 预测模型，预计在 36-48 小时内将超过 P2 告警阈值（8.0mm/s）。建议在下次计划停机窗口（72 小时后）前提前更换轴承衬套。",
      "confidence_label": "较高（85%）",
      "recommended_action_cn": "更换轴承衬套（预防性维护）",
      "estimated_repair_hours": 4,
      "urgency_label": "较紧急，建议 48 小时内处理",
      "similar_incidents_count": 3,
      "data_freshness": "2 分钟前",
      "citations": [
        { "title": "离心压缩机振动标准 ISO 10816-3", "id": 12 },
        { "title": "轴承磨损预防性维护规程 SY/T 0600", "id": 35 }
      ]
    },
    "last_maintenance": {
      "completed_at": "2025-11-20T08:00:00Z",
      "description": "年度大修，更换轴封",
      "days_ago": 172
    },
    "context_generated_at": "2026-05-11T02:32:00Z"
  }

GET /v1/ctx/equipment/{equipment_id}
  用途：OA 中发起设备相关申请时获取当前状态
  Response：同上 equipment_context + ai_analysis（无工单信息）

GET /v1/ctx/station/{station_id}/summary
  用途：管理层 OA 报告/例会中获取场站概况
  Response：站场级别摘要（设备总数/告警数/工单数/整体健康分）

POST /v1/ctx/ai-draft-form
  用途：OA 表单预填（操作员填写申请单时调用）
  Request:  { "equipment_id": 1, "user_description": "振动异常，不知道什么原因" }
  Response: {
    "suggested_title": "C-101 轴承振动异常处理",
    "suggested_symptom": "振动速度 7.2mm/s，超过阈值 6.0mm/s，持续 6 小时",
    "suggested_action": "停机检查轴承，预期需更换轴承衬套",
    "urgency": "medium",
    "estimated_hours": 4,
    "citations": [...]
  }
```

### 3.3 OA Webhook 集成（双向事件）

```
Nexus → OA（推送事件）：
  · alarm.triggered（P1/P2）→ 在 OA 中发起紧急审批流
  · workorder.pending_approval → 在 OA 中创建审批项
  · equipment.health.degraded → 在 OA 中触发预防性工单申请
  · morning_report.generated → 将日报推送到 OA 公告

OA → Nexus（回调事件）：
  · 审批通过 → POST /v1/hitl/workorders/{id}/approve（OA Service Token）
  · 审批驳回 → POST /v1/hitl/workorders/{id}/reject
  · 申请发起 → POST /v1/workorders/（OA 代发，携带发起人 emp_id）

Webhook 订阅 API：
  POST /v1/webhooks/subscriptions
  Request: {
    "target_url": "https://oa.company.com/nexus-callback",
    "events": ["workorder.pending_approval", "alarm.triggered"],
    "secret": "签名密钥（Nexus HMAC-SHA256 签名，OA 验证）",
    "station_ids": [1, 2]  // 只订阅哪些场站的事件
  }
```

---

## 四、Nexus 作为 IT 底座的产品形态

### 4.1 三种部署使用模式

```
模式 A：完整产品（Studio + Nexus）
  目标用户：一体化采购的工业客户
  特点：Studio 提供最优操作体验，Nexus 是后端
  适用场景：新建场站、数字化改造、专业操作团队

模式 B：飞书优先（飞书 Bot + Nexus）
  目标用户：已深度使用飞书的企业
  特点：操作员全程在飞书中操作，Studio 作为管理后台
  适用场景：分散场站、移动作业为主、IT 基础薄弱

模式 C：IT 底座（Nexus API + 客户自研界面）
  目标用户：有 IT 团队、已有 OA/ERP/MES 的大型企业
  特点：Nexus 提供 AI 智能数据层，客户用自己的系统展示
  适用场景：集团企业、已有大量 IT 投资、不想引入新 UI

  模式 C 的典型 IT 架构：
  ┌─────────────────────────────────────────────────────┐
  │              企业已有系统                             │
  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
  │  │ 飞书 OA  │  │SAP ERP   │  │ 自研运营大屏     │  │
  │  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
  │       │              │                  │             │
  │  ┌────▼──────────────▼──────────────────▼──────────┐ │
  │  │         ClawTwin Nexus（AI 底座）                 │ │
  │  │  Context API / Webhook / Tool API               │ │
  │  └─────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────┘

  IT 部门的工作：
  · 在 Nexus 中配置场站/设备/本体（通过 Admin API 或批量导入）
  · 在 Nexus 中配置 Webhook（哪些事件推送到哪个 URL）
  · 在自己的 OA 中调用 Context API（获取 AI 决策上下文）
  · 在自己的大屏中调用 /v1/equipment/* 和 /v1/analytics/*
  · Studio 只作为"Nexus Admin 后台"使用（非主要操作界面）
```

### 4.2 Nexus Admin API（专为 IT 底座模式设计）

```
IT 部门通过 Admin API 管理 Nexus（无需 Studio UI）：

# 批量导入设备（CSV 格式）
POST /v1/admin/equipment/batch-import
  Request: multipart/form-data（CSV 文件）
  CSV 格式: tag,name,equipment_type,station_id,area,ims_asset_id

# 配置 Webhook 订阅
POST /v1/webhooks/subscriptions

# 生成 Service Token（供 OA/ERP 系统使用）
POST /v1/admin/service-tokens
  Request: { "name": "SAP ERP 集成", "permissions": ["context:read", "workorder:write"] }
  Response: { "token": "svc_...", "warning": "只显示一次，请妥善保存" }

# 查询系统运行状态
GET /v1/admin/system/health

# 获取 API 调用统计（用于计量计费）
GET /v1/admin/billing/usage?month=2026-05
```

### 4.3 嵌入式 Widget（Phase B，OA 免集成开发）

```
为了降低 OA 系统的集成成本，Phase B 提供 Embed Widget：

<!-- 在飞书 OA 自定义表单中嵌入 AI 决策卡 -->
<script src="https://nexus.company.com/embed/v1/widget.js"></script>

<nexus-context-card
  type="workorder"
  wo-id="{{wo_id}}"           // OA 系统动态填入
  token="embed_token_abc"      // 嵌入专用 Token（只读权限）
  theme="light"
  compact="true">              // 紧凑模式（适合 OA 侧边栏）
</nexus-context-card>

Widget 效果：
  ┌──────────────────────────────────────────────┐
  │ 🤖 AI 辅助决策  ClawTwin Nexus               │
  ├──────────────────────────────────────────────┤
  │ C-101 1号进站压缩机                           │
  │ 健康分 ●●●●●●○○○○ 62/100 ⚠️警告             │
  │                                              │
  │ AI诊断：轴承振动持续上升，建议48h内检修        │
  │ 置信度：高（85%）                             │
  │ 参考：ISO 10816-3, SY/T 0600               │
  │                                              │
  │ [查看完整分析 ↗]                              │
  └──────────────────────────────────────────────┘

实现方式：
  · Web Component（框架无关，飞书/钉钉/自研 OA 均可嵌入）
  · 通过 embed token 鉴权（无需用户登录 Studio）
  · CORS 白名单（只允许注册的 OA 域名调用）
  · 只读权限（Widget 不能修改任何数据）
```

---

## 五、OA 集成的典型业务流程设计

### 5.1 场景 A：操作员通过 OA 发起维修申请

```
步骤 1：操作员填写 OA 申请单
  · OA 表单：填写设备位号（如 C-101）
  · OA 调用 Nexus POST /v1/ctx/ai-draft-form
  · Nexus 返回：自动填充症状描述、建议操作、紧急程度
  · 操作员确认/修改后提交
  · [AI 已帮操作员写好了专业的症状描述，质量大幅提升]

步骤 2：OA 系统处理提交
  · OA 发送 Webhook 到 Nexus：POST /v1/workorders/（代发，携带 emp_id）
  · Nexus 创建工单（state=draft → pending_approval）
  · Nexus 异步启动 AI 分析（AI Job）
  · Nexus 向 OA 回调：工单已创建，审批流程已启动

步骤 3：审批人收到 OA 审批通知（5-10 分钟后 AI 分析完成）
  · 审批人打开 OA 审批单
  · OA 调用 Nexus GET /v1/ctx/workorder/{wo_id}
  · OA 在审批界面显示 AI 决策上下文（健康分/诊断/推荐操作）
  · 审批人在 OA 中点击"批准"/"驳回"

步骤 4：OA 审批结果回调 Nexus
  · OA 调用 Nexus POST /v1/hitl/workorders/{id}/approve（OA Service Token）
  · Nexus 更新工单状态为 approved
  · Nexus 发飞书通知操作员："您的维修申请已批准"

步骤 5：工单执行完成
  · 操作员通过飞书 Bot 上传执行照片，标记完成
  · 或：在 Studio 中标记完成（如果有 Studio）
  · 或：操作员在 OA 中填写"执行反馈"→ Webhook → Nexus 标记 done
  · Nexus 触发 L3 知识沉淀
```

### 5.2 场景 B：IT 部门集成场景（无 Studio，纯 API）

```
大型集团企业的典型集成方案：

已有系统：
  · 飞书 OA（审批流）
  · SAP PM（设备管理）
  · 自研运营 BI 系统（Tableau / 自研 Web）

ClawTwin Nexus 的角色：
  · AI 计算层（Pulse Engine + MOIRAI + KB）
  · 工单 HITL 协调层（不拥有工单，协调 SAP PM）
  · 决策上下文提供层（Context API）

集成流程：

1. SAP PM 工单 → Nexus 同步（单向，SAP 是主）
   · SAP PM 创建工单 → 调用 Nexus POST /v1/workorders/（mode=external_managed）
   · Nexus 不真正管理工单，只提供 AI 分析支持
   · Nexus 的工单状态跟随 SAP PM 变化

2. Nexus AI 分析 → SAP PM 追加
   · Nexus 完成 AI 分析 → 调用 SAP PM 的 API，追加"AI 建议"附件
   · SAP PM 原有审批流程不变，只是多了 AI 附件

3. 自研 BI 系统调用 Nexus 实时数据
   · Nexus /v1/analytics/kpi?station_id=1（实时指标）
   · Nexus /v1/equipment?station_id=1（设备状态列表）
   · BI 系统负责展示，Nexus 负责数据

4. 飞书 OA 中嵌入 Widget
   · 审批人打开 OA 时看到 Nexus AI 决策卡（Phase B Embed Widget）
   · 无需改造 OA，只需在 OA 表单中插入一个 Widget 标签
```

---

## 六、"Nexus 作为底座"的架构影响

### 6.1 必须新增到设计的组件

```
新增 1：Context API 路由（/v1/ctx/*）
  · 独立于 User API（/v1/equipment/*）
  · 面向外部系统，聚合多个数据源，返回"决策摘要"
  · Service Token 鉴权（不需要用户 JWT）
  · 响应体包含中文化的自然语言描述（方便 OA 直接展示）

新增 2：Webhook 订阅管理（/v1/webhooks/*）
  · 外部系统注册感兴趣的事件
  · Nexus 事件触发时主动调用外部 URL
  · HMAC-SHA256 签名验证（防伪造）
  · 失败重试（3 次，指数退避）

新增 3：Service Token 权限粒度
  · 现有：全局 Tool API 权限
  · 新增粒度：
    context:read        → 只能读 Context API
    workorder:write     → 只能创建/更新工单
    alarm:acknowledge   → 只能确认告警
    webhook:subscribe   → 只能管理 Webhook 订阅
  · 最小权限原则：OA 系统只需要 context:read + workorder:write

新增 4：外部托管工单模式（mode=external_managed）
  · 工单真正由 SAP PM/CMMS 管理
  · Nexus 只提供 AI 分析附属服务
  · 避免与客户现有工单系统冲突
```

### 6.2 对现有设计的调整（最小影响）

```
调整 1：鉴权中间件增加 Service Token 权限粒度检查
  · 现有：只验证 Token 是否有效
  · 调整：验证 Token 是否有操作所需的权限范围（scope）
  · 影响：auth/depends.py 增加 require_scope() 依赖

调整 2：工单创建支持 source 字段
  · source: "studio" | "feishu_bot" | "oa_integration" | "api"
  · 用于统计和审计：不同来源的工单质量对比
  · 影响：work_order 表增加 source 字段

调整 3：事件总线输出到 Webhook
  · 现有：Kafka 事件只在内部消费（Pulse Engine / Scheduler 订阅）
  · 调整：增加 WebhookDispatcher 订阅 Kafka，转发给外部订阅方
  · 影响：新增 services/webhook_dispatcher.py

以上调整不破坏现有 API，向后兼容。
```

---

## 七、IT 底座模式的商业价值分析

```
对客户 IT 部门的价值主张：

"您不需要放弃现有 OA/ERP 系统，也不需要培训操作员使用新 UI。
 只需集成 ClawTwin Nexus API，您的现有系统就立即获得：
  · 设备 AI 健康评分（自动计算，实时更新）
  · AI 辅助的 OA 审批决策信息
  · 预测性故障预警（提前 48-72 小时）
  · 自动知识积累（工单完成后自动学习）"

对我们的商业价值：
  · 降低销售阻力：客户不需要整体替换现有系统
  · 提高切入点：从"AI 数据层"切入，比"整体方案"更容易首单
  · 扩大市场：有 OA/ERP 的企业都可以是客户（不局限于愿意用全套的）
  · 后续扩张：先用 API，再升级到 Studio（渐进式扩张）

定价：
  · API 模式（无 Studio）：¥1-3万/月/场站（Context API 调用量计费）
  · Studio 模式（含 Studio）：¥3-8万/月/场站
  · IT 底座差额 = Studio 授权费（¥2-5万/月/场站）
  → 意味着：客户先用 API，后加购 Studio，我们有明确的升级路径
```

---

## 八、Nexus 产品形态总结（更新版）

```
ClawTwin Nexus 的完整产品形态：

核心引擎（所有模式共享）：
  · Pulse Engine（设备健康计算）
  · Knowledge Engine（KB + RAG）
  · WorkOrder FSM（工单状态机）
  · AI Jobs（异步 AI 分析）
  · Alarm Manager（ISA-18.2）
  · Ontology Registry（设备本体）

面向人的界面（可选，按需组合）：
  · Studio（我们自研，最完整）
  · 飞书 Bot（我们自研，移动端）

面向系统的接口（核心 API 能力）：
  · User API（/v1/*，JWT，人调用）
  · Tool API（/v1/tools/*，Service Token，机器调用）
  · Context API（/v1/ctx/*，Service Token，OA/ERP 集成）      ← 新增
  · Webhook 订阅（/v1/webhooks/*，事件推送）                  ← 新增
  · Admin API（/v1/admin/*，sys_admin，配置管理）

Phase B 增加：
  · Embed Widget（JS Web Component，OA 内嵌 AI 卡）
  · nexus-sdk（Python/Node.js，降低集成成本）
  · Partner Portal（SI 合作伙伴管理）

一句话定位（面向 IT 部门）：
  "ClawTwin Nexus 是工业设备的 AI 大脑——
   无论您用飞书、SAP、自研系统还是我们的 Studio，
   它始终在为您的每一个工业决策提供 AI 支持。"
```

---

## 九、API 安全增强（外部系统集成专项）

```python
# auth/service_token.py（扩展）

class ServiceTokenScope(str, Enum):
    """Service Token 权限范围（细粒度）"""
    CONTEXT_READ    = "context:read"       # 读 Context API
    WORKORDER_WRITE = "workorder:write"    # 建/改工单
    WORKORDER_READ  = "workorder:read"     # 读工单列表
    ALARM_ACK       = "alarm:acknowledge"  # 告警确认
    WEBHOOK_MANAGE  = "webhook:subscribe"  # Webhook 管理
    TOOL_CALL       = "tool:call"          # Tool API（完整）
    ADMIN           = "admin"              # 管理员操作


def require_scope(required: ServiceTokenScope):
    """路由层 scope 检查依赖"""
    def _dep(token: ServiceToken = Depends(get_service_token)):
        if required not in token.scopes:
            raise HTTPException(
                status_code=403,
                detail=f"Service Token 缺少权限范围：{required}，当前范围：{token.scopes}"
            )
        return token
    return _dep

# Context API 路由使用示例
@router.get("/v1/ctx/workorder/{wo_id}")
async def get_workorder_context(
    wo_id: str,
    _: ServiceToken = Depends(require_scope(ServiceTokenScope.CONTEXT_READ))
):
    # ...
```

---

## 十、与现有文档的关系

```
本文档新增的设计，与现有文档的关系：

新增（本文档定义）：
  · Context API（/v1/ctx/*）完整规范
  · Webhook 订阅 API 完整规范
  · Service Token 权限粒度（scopes）
  · 外部托管工单模式（mode=external_managed）
  · Embed Widget 概念（Phase B）
  · IT 底座部署模式（模式 C）

引用已有设计（本文档不重复）：
  · 工单 FSM → NEXUS-BUSINESS-LOGIC.md
  · AI Jobs → PARALLEL-DEV-TASKSPEC.md Task B3
  · 飞书集成 → ADR-5
  · 安全模型 → ADR-6

需要更新的现有文档：
  · MODULE-DESIGN-PLATFORM.md：
    - 新增 §二十九：Context API 路由实现
    - 新增 §三十：Webhook 订阅路由实现
    - 更新 §十八.6：添加 /v1/ctx/* 和 /v1/webhooks/* 到路由表
  · PARALLEL-DEV-TASKSPEC.md：
    - 新增 Task D4：Context API + Webhook（依赖 B1+B2）
  · PRODUCT-NAMING-AND-MODULES.md §四.2：
    - 在 API 清单中增加 Context API 和 Webhook 类别
```

---

_本文档创建于 2026-05-11，定义了 ClawTwin Nexus 的"无界集成"架构。_  
_核心洞见：Studio 是 Nexus 的一个消费端，不是全部。Nexus 的价值对任何系统可用。_
