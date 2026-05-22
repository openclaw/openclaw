# CLAWTWIN-INTEGRATION-ARCHITECTURE.md

> **Tesla 数字孪生与 AI 架构师视角深度审视**
> Version 1.0 | 2026-05-13 | 完整三方协作分工 + 性能优化蓝图

---

## 一、一句话定位（再次澄清）

```
OpenClaw        = 用户的 AI 助手（对话、推理、跨工具自主行动）
ClawTwin Studio = 运营人员的业务驾驶舱（调查 / 配置 / 深度分析）
ClawTwin Platform = 设备世界的语义内核（状态机 / 规则引擎 / 可靠交付）
```

三者各自完备、互不替代；但最强状态是**三者深度耦合**，用户从任何入口都能无缝完成工作。

---

## 二、Tesla 视角的批判性审视

### 2.1 Tesla Digital Twin 的核心设计原则

Tesla 让每辆车成为"可观测 + 可控制 + 持续学习"的数字孪生，关键设计如下：

| Tesla 原则                 | Tesla 实现                             | ClawTwin 对应                    | 当前差距                         |
| -------------------------- | -------------------------------------- | -------------------------------- | -------------------------------- |
| 影子模式 (Shadow)          | 新模型先静默运行不行动，验证 OK 再激活 | FunctionType `shadow_mode` 标志  | ❌ 未实现                        |
| 置信度门 (Confidence Gate) | 只有 FSD 置信度 > 阈值才启用自动驾驶   | Playbook L0-L5 自主级别          | ⚠ 级别定义有，但无动态置信度计算 |
| 舰队学习 (Fleet Learning)  | 一辆车的异常教训推送给所有同型车       | OutcomeEvent → CBR               | ⚠ 仅单站学习，跨站知识共享未实现 |
| OTA 能力更新               | 软件/模型在车上热更新                  | IndustryPack + ReloadPlan 热加载 | ✅ 已实现                        |
| 边缘快速响应               | 车内低延迟决策，不依赖云端             | Scheduler worker 本地规则        | ⚠ 依赖 LLM 时延迟高              |

### 2.2 当前架构最关键的三个问题

#### 问题 A：OpenClaw ↔ ClawTwin 是单向的（M1.6 已部分解决）

```
当前：   OpenClaw ──MCP──▶ ClawTwin  （OpenClaw 主动调用 ClawTwin 工具）✅
M1.6：   MCP 增加平台查询工具 x3（list_pending_hitl / get_alarm_summary / get_station_health）✅
待做：   ClawTwin 作为 OpenClaw 官方 Plugin（Phase B 目标）
```

**当前状态**：OpenClaw 现在可以通过 MCP 主动查询平台运营状态，但 Platform 仍不能主动推送事件驱动 OpenClaw 发起对话。"ClawTwin 注册为 OpenClaw Plugin 并贡献 Skill/Hook" 是 Phase B 目标。

#### 问题 B：Feishu HITL 卡片是哑卡（已解决 ✅）

```
M1.6 已实现：  [报警详情卡片] [✓ 批准] [✗ 拒绝] HMAC 签名按钮
              → 用户点击 → feishu_webhook card.action.trigger 处理
              → PlaybookExecutor.resume_run() / cancel_run()
              → Playbook 继续 → 工单创建
```

全链路审批从 4 分钟/5 步跳转缩短为 **30 秒/飞书一键点击**。

#### 问题 C：LLM 调用无缓存（已解决 ✅）

同一设备、同一小时内相同读数被多个报警触发，每次都调用 LLM：

- 延迟：每次增加 1-3 秒
- 成本：重复 token 消耗
- 可靠性：LLM 故障会阻塞诊断

---

## 三、优化后的三方协作架构

### 3.1 完整双向集成图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        用户交互入口                                       │
│                                                                          │
│   飞书/钉钉              ClawTwin Studio            API / 第三方          │
│   (日常快速操作)          (深度调查/配置)              (ERP/MES/自动化)      │
└──────────┬──────────────────────┬──────────────────────┬────────────────┘
           │                      │                      │
           ▼                      ▼                      ▼
   ┌───────────────┐    ┌─────────────────┐    ┌────────────────────┐
   │   OpenClaw    │    │  Studio Frontend│    │  REST API / MCP    │
   │  (对话智能体)  │    │  (Gotham UI)    │    │  (外部系统集成)     │
   │               │    │                 │    │                    │
   │ ● 多轮对话    │    │ ● 对象时间线    │    │ ● WebHook 订阅     │
   │ ● 跨系统推理  │    │ ● 调查图谱      │    │ ● SSE 实时流       │
   │ ● 主动推送    │    │ ● 复杂审批      │    │ ● OpenAPI 3.1      │
   │ ● 卡片审批    │    │ ● 配置管理      │    │                    │
   └───────┬───────┘    └────────┬────────┘    └─────────┬──────────┘
           │  MCP tools           │  REST API             │  REST API
           │  + Card Callback     │                       │
           └──────────────────────┴──────────────────────┘
                                  │
                    ┌─────────────▼─────────────────┐
                    │     ClawTwin Platform          │
                    │   (State Machine + AI Engine)  │
                    │                                │
                    │  ┌──────────────────────────┐  │
                    │  │  Semantic Layer (L2.5)   │  │
                    │  │  Ontology / ObjectStore  │  │
                    │  │  FSM / EventBus          │  │
                    │  └────────────┬─────────────┘  │
                    │               │                │
                    │  ┌────────────▼─────────────┐  │
                    │  │  AI Action Layer          │  │
                    │  │  Playbook / HITL          │  │
                    │  │  FunctionExecutor         │  │
                    │  │  AgentRuntime → OpenClaw  │  │
                    │  └────────────┬─────────────┘  │
                    │               │                │
                    │  ┌────────────▼─────────────┐  │
                    │  │  Ops Layer (Reliability)  │  │
                    │  │  Outbox / Doctor / Health │  │
                    │  │  Rate Limit / Dedupe      │  │
                    │  └──────────────────────────┘  │
                    └────────────────────────────────┘
                                  │
                    ┌─────────────▼─────────────────┐
                    │      OT/IT 数据底层            │
                    │  OPC-UA / MQTT / Modbus        │
                    │  ERP/MES/CMMS Connectors       │
                    │  时序DB / 关系DB                │
                    └────────────────────────────────┘
```

### 3.2 OpenClaw Plugin Contract（应该实现的标准接口）

ClawTwin 应该以 **OpenClaw Plugin** 形式注册，不只是 MCP Server：

```typescript
// extensions/clawtwin/src/manifest.ts (OpenClaw 扩展，非 ClawTwin 内部)
export const manifest: PluginManifest = {
  id: "clawtwin",
  displayName: "ClawTwin Operations",
  skills: ["clawtwin_ops"], // 工厂/站场运营 Skill
  hooks: [
    "alarm.created", // 报警创建时 → OpenClaw 主动推送
    "playbook.hitl_paused",
  ], // 需要 HITL 审批时 → 发送交互卡片
  mcpServers: [
    {
      id: "clawtwin",
      baseUrl: "${CLAWTWIN_API_URL}",
    },
  ],
};
```

**这意味着**：

- OpenClaw 知道「当 ClawTwin 报警时要做什么」— 自动推送到对应频道
- 用户在飞书收到的是**带审批按钮的交互卡**，而不是纯文本链接
- OpenClaw 的 multi-agent workflow 可以把 ClawTwin 的 MCP 工具当作普通工具调用

### 3.3 精确分工矩阵（修订版）

| 功能场景                              | 由谁负责                                   | 为什么                                       |
| ------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| 自然语言查询 "C-001 泵现在状态怎么样" | **OpenClaw**                               | 语义理解、多轮对话是 OpenClaw 核心能力       |
| 报警实时推送（飞书/钉钉）             | **OpenClaw** (via Hook)                    | OpenClaw 管理频道连接，Platform 不直接持连接 |
| Feishu 卡片内联审批                   | **OpenClaw** 收 Feishu 事件 → Platform API | OpenClaw 作为 Feishu Bot 宿主，转发用户操作  |
| 设备时间线、历史趋势                  | **Studio**                                 | 可视化数据分析是 Studio 专属                 |
| 复杂多步审批（含附件）                | **Studio**                                 | 需要完整 UI 上下文                           |
| Ontology 配置、Pack 管理              | **Studio**                                 | 管理操作不适合对话                           |
| 单次 AI 诊断函数调用                  | **Platform** FunctionExecutor              | 确定性、可审计、快速                         |
| 复杂多轮 AI 推理                      | **OpenClaw** via AgentRuntime              | 多步骤、tool use、不确定性高                 |
| 流程编排 (Playbook)                   | **Platform** PlaybookEngine                | 状态持久化、可恢复、事件驱动                 |
| 数据持久化、对象状态                  | **Platform** ObjectStore                   | 单一事实来源                                 |
| 设备学习记忆 (CBR)                    | **Platform**                               | 需要结构化检索，不适合 LLM 记忆              |

---

## 四、用户旅程优化（Before vs After）

### 旅程 A：处理紧急报警

**Before（当前）：4 分钟，5 步跳转**

```
1. 飞书收到文本通知 "报警 A-007"
2. 手动打开浏览器
3. 登录 Studio
4. 找到该报警对应的 Playbook 审批单
5. 查看详情 → 点击批准
```

**After（优化后）：30 秒，0 跳转**

```
1. 飞书收到交互卡片：
   ┌─────────────────────────────────┐
   │ 🔴 紧急报警：C-001 泵压异常      │
   │ 当前压力：8.2 MPa（阈值 7.5）    │
   │ AI 诊断：密封圈磨损，建议更换    │
   │ 置信度：82% | 历史相似案例 3 次  │
   │ [✓ 批准维修] [△ 降级处理] [✗ 忽略] │
   └─────────────────────────────────┘
2. 点击"批准维修" → 飞书发 POST 到 ClawTwin
3. Playbook 继续执行
```

### 旅程 B：自然语言运营查询

**Before**：打开 Studio → 找设备 → 翻历史数据
**After**：飞书/OpenClaw 对话

```
用户: "最近一周哪台泵报警最多？"
OpenClaw: [调用 MCP list_alarms] → "A-003 泵 7 次，集中在夜班..."
用户: "帮我创建巡检工单"
OpenClaw: [调用 MCP create_action, type=work_order] → "工单 WO-2024-0089 已创建"
```

### 旅程 C：管理员配置新规则

**Before → After（无变化，Studio 是正确入口）**：
Studio → Playbook 编辑器 → 配置触发条件 → 发布
（这个旅程 Studio 是最合适的，不需要优化路径）

---

## 五、性能架构优化

### 5.1 LLM 结果缓存（短期 TTL）

```python
# core/function_executor/ai_cache.py
# 缓存 key: SHA256(system_prompt + user_prompt)
# TTL: 60s（相同设备相同读数，60秒内结果一致）
# 大小: 最多 512 条（LRU 淘汰）

cache = LRUCache(maxsize=512, ttl=60)
# 命中率目标：同一站场同一小时内 > 60%
```

**效果**：

- P99 延迟从 3s → 50ms（命中时）
- 报警风暴场景（10台设备同时触发）：LLM 调用从 10 次 → 2-3 次

### 5.2 模型分级路由（fast/smart）

```yaml
# ontology/function_types/xxx.yaml
implementation:
  type: ai_model
  model_preference: fast # ← fast=小模型, smart=大模型（默认）
  shadow_mode: false # ← true=静默运行，不执行建议
```

路由逻辑：

- `fast` → 环境变量 `CLAWTWIN_AI_FAST_MODEL`（默认 `gpt-4o-mini`）
- `smart` → 环境变量 `CLAWTWIN_AI_SMART_MODEL`（默认 `gpt-4o`）
- 置信度 < 60% → 自动升级到 smart 模型重新调用

**成本估算**：

- fast 调用（诊断初筛）：~$0.001/次
- smart 调用（复杂分析）：~$0.02/次
- 混合使用比纯 smart：成本降低 70%

### 5.3 边缘-云分层响应策略

```
响应时间要求         处理位置          实现
< 100ms (实时告警)  → Platform Scheduler rules（无 LLM）
100ms-2s (诊断建议) → Platform FunctionType + fast model + cache
> 2s (深度分析)     → OpenClaw AgentRuntime（异步，结果推送）
```

### 5.4 连接池 & 会话优化

| 资源            | 当前       | 优化后                          |
| --------------- | ---------- | ------------------------------- |
| DB 连接         | 每请求创建 | pgbouncer 池化，max_overflow=10 |
| LLM HTTP 连接   | 每次新建   | httpx.AsyncClient 全局单例      |
| Feishu Bot 连接 | 每次 OAuth | Token 缓存，提前 5min 刷新      |
| SSE 连接        | 无限制     | 单用户最多 5 个并发 SSE         |

---

## 六、学习飞轮（Tesla 舰队学习对标）

### 6.1 当前：孤岛学习

```
站场 A 报警 → 人工处理 → OutcomeEvent 记录 → CBR 只给站场 A 用
站场 B 相同问题 → 重新摸索
```

### 6.2 目标：跨站知识共享

```
站场 A 报警 → 处理 → OutcomeEvent{equipment_model="C300", outcome="seal_replaced"}
                           ↓
                    知识萃取（KnowledgeBase）
                    "C300型泵 当压力>8MPa且运行>3000h → 密封圈磨损 置信度85%"
                           ↓
                    推送给所有站场的 C300 泵 CBR 知识库
站场 B 相同报警 → CBR 直接给出 85% 置信建议，无需人工
```

**实现路径（Phase B）**：

1. OutcomeEvent 增加 `equipment_model` 字段（跨站抽象）
2. 跨站 CBR 聚合 job（每日批量，非实时）
3. 知识库的"通用知识" vs "站场私有知识"分级

### 6.3 影子模式（Tesla Shadow Mode 对标）

当新 Pack / 新 FunctionType 部署时，可以先用 `shadow_mode: true` 运行：

- AI 照常分析，给出建议
- **不执行**任何操作，不触发 Playbook
- 输出写入 `shadow_run_logs` 表
- 运维人员在 Studio 对比"影子建议" vs "实际操作"
- 验证 2 周无问题 → 切换为 `shadow_mode: false`

```yaml
# packs/oilgas/manifest.yaml
shadow_mode: true # Pack 级影子模式开关
```

---

## 七、OpenClaw 生态充分利用指南

### 7.1 应该用 OpenClaw 的（不要自己造轮子）

| 能力                          | OpenClaw 扩展                    | ClawTwin 如何使用                             |
| ----------------------------- | -------------------------------- | --------------------------------------------- |
| 用户多轮对话                  | OpenClaw core                    | 只提供 MCP tools，让 OpenClaw 管对话          |
| IM 频道连接（飞书/钉钉/微信） | extensions/feishu, dingtalk      | 不要自己维护 Bot Token，通过 OpenClaw channel |
| 报警推送格式化                | OpenClaw Skill（可定制）         | 写 clawtwin Skill，定义通知模板               |
| 文档 OCR & 知识提取           | extensions/document-extract      | 直接复用，不要自建 OCR                        |
| 网页搜索辅助诊断              | extensions/brave, exa            | 诊断时 OpenClaw 自动补充外部知识              |
| 语音指令                      | extensions/azure-speech          | 巡检人员语音操作 ClawTwin                     |
| LLM Provider 管理             | extensions/openai/anthropic etc. | 不要在 ClawTwin 内管理 LLM key，委托 OpenClaw |

### 7.2 ClawTwin 应该向 OpenClaw 贡献的 MCP Tools（完整清单）

```
查询类（只读）：
  get_equipment_status(id)           设备当前状态
  list_active_alarms(station_id)     活跃报警列表
  get_station_overview(id)           站场概览
  query_objects(type, filters)       通用对象查询
  get_cbr_recommendation(alarm_id)   CBR 推荐

操作类（需权限）：
  create_action(type, params)        创建动作（工单/命令/通知）
  approve_playbook_run(run_id)       批准 HITL 审批
  reject_playbook_run(run_id)        拒绝 HITL 审批
  trigger_playbook(id, context)      手动触发 Playbook
  update_equipment_tag(id, tags)     更新设备标签

分析类：
  diagnose_equipment(id, timerange)  设备诊断
  get_trend_analysis(id, metric)     趋势分析
  list_outcome_events(equipment_id)  历史处理结果
```

### 7.3 不应该由 ClawTwin 做的

❌ **管理 Feishu Bot 的 token 刷新** → OpenClaw extensions/feishu 负责
❌ **LLM Provider 配置 UI** → 在 OpenClaw Studio 里配置
❌ **用户对话历史存储** → OpenClaw 管理对话上下文
❌ **复杂多步 agent workflow** → 由 OpenClaw Skill 编排，ClawTwin 只提供工具

---

## 八、架构自洽验证（Closed-Loop Check）

### 8.1 完整事件流（修订版，含飞书内联审批）

```
设备传感器
    │ OPC-UA reading
    ▼
OpcuaCollector worker
    │ EquipmentReading写入 + PlatformEvent(equipment.reading.new)
    ▼
EventDispatcher
    │ 触发 PlaybookTriggerSink + SSE
    ▼
PlaybookEngine：执行「压力监控」Playbook
    │
    ├─[step: diagnose_equipment FunctionType]
    │         │ 查 ObjectStore 设备历史 + KB + CBR
    │         │ 调用 ai_runner → LLM（含缓存）
    │         │ 置信度 82%
    │         ▼
    │    [step: HITL if confidence < 90%]
    │         │ Playbook 暂停
    │         ▼
    │    EventDispatcher → channel_notification_sink
    │         │ 通过 Outbox → 发送 Feishu 交互卡片（带按钮）
    │         ▼
    │    用户在飞书点击「批准」
    │         │ Feishu → POST /v1/feishu/events card.action.trigger
    │         │ feishu_webhook 验证签名 → 调用 PlaybookExecutor.resume_run()
    │         ▼
    │    Playbook 恢复
    │
    ├─[step: create_action type=work_order]
    │         │ ActionExecutor 执行
    │         │ effects: emit action_completed 事件
    │         ▼
    ├─[step: notify engineer]
    │         │ `dispatch(playbook_run.notification)` → Feishu channel Outbox → 文本通知（与 HITL 卡片同属可靠投递链）
    │         ▼
    └─ OutcomeEvent 写入（供 CBR 学习）
           │
           ▼
    KnowledgeBase 更新
    CBR 知识库更新（本站 + 可选跨站共享）
```

### 8.2 模块依赖矩阵（单向性验证）

```
Platform Core  ← 不依赖 OpenClaw（Platform 可独立运行）
Platform Core  ← 不依赖 Studio（API 解耦）
Studio         ← 依赖 Platform REST API / SSE（单向）
OpenClaw       ← 依赖 Platform MCP API（单向）
Platform Core  → 可调用 OpenClaw AgentRuntime（可选，通过 agent_runtimes 配置）
```

**结论**：依赖关系有向无环 ✅，Platform 可独立运行 ✅，各层可独立测试 ✅

---

## 九、Phase A 闭环核对 → Phase B 路线图

### Phase A+ 已落地（原「立即修复」清单 — 代码已对齐，本节仅作存档）

以下项曾在早期稿中列为「Phase A+ 增补」；**截至 2026-05-13 已在 `platform-api` 闭环**，不再视为待办：

| 项                                                            | 落地位置                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feishu 交互卡片 + `card.action.trigger`                       | `infra/feishu_card.py`、`apps/http/routes/feishu_webhook.py`                                                                                      |
| LLM 结果短 TTL 缓存                                           | `core/function_executor/ai_cache.py`、`ai_runner.run_completion()`                                                                                |
| FunctionType `model_preference`（fast/smart）                 | `ai_runner._resolve_model()` + 本体 schema                                                                                                        |
| Playbook `notification` 步骤走统一 `dispatch` + Feishu Outbox | `core/playbook_engine/executor.py`（`playbook_run.notification`）、`infra/event_dispatcher.py`、`workers/outbox_dispatcher.py`（`handled_types`） |

**文档一致性**：本文 **§2.2 问题 B/C** 与上表一致；旧稿 **§九「立即修复」** 若仍显示为未开始，视为过时。

### Phase B 新增（不在 Phase A 范围）

| 项                                                | 价值 | 复杂度 |
| ------------------------------------------------- | ---- | ------ |
| ClawTwin 注册为 OpenClaw Plugin（官方 extension） | 极高 | 中     |
| 跨站 CBR 知识共享                                 | 高   | 高     |
| FunctionType shadow_mode                          | 高   | 低     |
| Studio 对象调查图谱（Gotham Investigation Graph） | 高   | 高     |
| 置信度动态模型切换（fast→smart 自动升级）         | 中   | 低     |
| 语音指令集成（OpenClaw azure-speech extension）   | 中   | 低     |

---

## 十、核心设计原则总结（Tesla → ClawTwin 映射）

| Tesla 原则                     | ClawTwin 对应                                | 实现状态           |
| ------------------------------ | -------------------------------------------- | ------------------ |
| 每辆车都是数字孪生             | 每台设备/对象都有 ObjectStore 实体           | ✅                 |
| 影子模式验证新能力             | FunctionType `shadow_mode`                   | ⚠ Phase B          |
| 舰队集体学习                   | 跨站 CBR 知识共享                            | ⚠ Phase B          |
| 手机即控制台（从任意入口操作） | Feishu 内联审批卡片 + Playbook 通知经 Outbox | ✅                 |
| OTA 热更新                     | IndustryPack + ReloadPlan 热加载             | ✅                 |
| 低延迟本地决策                 | Scheduler rules（无 LLM）                    | ✅                 |
| 高延迟复杂推理上云             | OpenClaw AgentRuntime                        | ✅                 |
| 置信度门控制自动化级别         | Playbook L0-L5 + 置信度字段                  | ⚠ 置信度计算待完善 |

**整体评分**：映射表上 **6 项已 ✅ 落地**（含飞书控制台与 OTA）；**影子模式**与**跨站舰队学习**明确归 Phase B；**置信度门**已有 Playbook 级别与字段，动态评分模型可持续迭代（见 **§2.1** 表里「置信度门」行）。系统已满足 Phase A 工业可靠性目标，核心飞轮可转动。

---

_文档归档路径：`contrib/industrial-oilgas-skills/CLAWTWIN-INTEGRATION-ARCHITECTURE.md`_
_关联文档：CLAWTWIN-SYSTEM-FRAMEWORK.md | CLAWTWIN-MILESTONE-PLAN.md | DESIGN-FINAL-MASTER-INDEX.md_
