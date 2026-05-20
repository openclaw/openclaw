# ClaWorks 架构总纲

**版本**：v2.0  
**日期**：2026-05-20  
**状态**：代码同步，设计基准

---

## 一、产品定位

ClaWorks 是面向工业/企业场景的**自治机器人运行时框架**，构建在 OpenClaw 基础上。

```
OpenClaw（官方，核心不改）          ClaWorks（工业自治层）
─────────────────────              ──────────────────────────────
个人/团队 AI 助理平台               企业自治机器人运行时
用户通过 IM 与 AI 对话             机器人自主响应业务事件
138 个 LLM Provider               PlaybookEngine + EventKernel
Skills 生态                        Extension Pack 生态
Pi embedded agent（前额叶）        Pi 作为 Playbook subagent/skill 步

关系：同一进程，两套 Runtime
  OpenClaw Gateway/Channel/Agent  ←→  ClaWorks EventKernel/DataPlane/OrchPlane
  通过 runtime-bridge 桥接，共享 LLM / IM / managedFlows
```

### 「神经系统」类比

| 生物类比             | ClaWorks 组件                                |
| -------------------- | -------------------------------------------- |
| 感觉神经             | Connector / SCADA / 视觉 / 声波              |
| 脊髓反射（习惯动作） | EventKernel + Playbook（确定性部分）         |
| 小脑协调             | EventBus 优先级 + Scheduler + Outbox         |
| 长期记忆             | ObjectStore + OntologyEngine                 |
| 短期工作记忆         | Playbook 变量 + 会话 KB                      |
| 前额叶（推理）       | Pi embedded agent（LLM/subagent/skill 步骤） |
| 嘴（输出）           | Channel notify / HITL 飞书卡片               |
| 身份与自我           | **robot.md + RobotIdentity**（本次新增）     |
| 免疫系统             | **RBAC Guard + Ingress Router**（本次新增）  |
| 基因                 | Pack YAML（本体 + Playbook 规则）            |

---

## 二、核心架构图

```
┌──────────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway 进程                             │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              OpenClaw 原有 Runtime（不改）                        │ │
│  │  Plugin Loader · HTTP Server · Config 热重载                      │ │
│  │  LLM Providers · IM Channels · Pi Agent · Skills · subagent      │ │
│  └────────────────────────────┬────────────────────────────────────┘ │
│                               │ api.registerService / registerTool   │
│  ┌────────────────────────────▼────────────────────────────────────┐ │
│  │              extensions/claworks-robot 插件                       │ │
│  │   registerRoutes(/v1 /studio /a2a /mcp)                          │ │
│  │   registerClaworksAgentTools(cw_*)                               │ │
│  │   registerService(claworks-kernel → ClaworksRuntime)            │ │
│  └────────────────────────────┬────────────────────────────────────┘ │
│                               │                                       │
│  ┌────────────────────────────▼────────────────────────────────────┐ │
│  │                   ClaworksRuntime                                 │ │
│  │                                                                   │ │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │ │
│  │  │  RobotIdentity  │  │   RbacGuard       │  │ IngressRouter  │  │ │
│  │  │  (robot.md)     │  │  (ObjectStore     │  │  (IM→intent,   │  │ │
│  │  │  rules[]        │  │   RbacPolicy)     │  │  OT→kernel)    │  │ │
│  │  └─────────────────┘  └──────────────────┘  └────────────────┘  │ │
│  │                                                                   │ │
│  │  ┌────────────────────────────────────────────────────────────┐  │ │
│  │  │                  EventKernel                                │  │ │
│  │  │  EventBus（优先级队列）· Matcher · Scheduler · Outbox       │  │ │
│  │  │  DedupGuard（60s 去重防循环）                               │  │ │
│  │  └──────────┬─────────────────────────────────────────────────┘  │ │
│  │             │                                                      │ │
│  │  ┌──────────▼──────────┐  ┌──────────────────┐  ┌─────────────┐  │ │
│  │  │     DataPlane        │  │    OrchPlane      │  │  Interfaces │  │ │
│  │  │  ObjectStore/Ontology│  │  PlaybookEngine   │  │  REST /v1   │  │ │
│  │  │  KB (RAG)            │  │  HITLGate         │  │  A2A /a2a   │  │ │
│  │  │  SQLite/PostgreSQL   │  │  StepExecutor     │  │  MCP /mcp   │  │ │
│  │  └──────────────────────┘  └──────────────────┘  └─────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 三、两套 Runtime 的关系

```
OpenClaw Runtime                 ClaWorks Runtime
──────────────────               ──────────────────────
会话驱动（用户发消息）            事件驱动（OT/Cron/REST）
Pi Agent 推理                    PlaybookEngine 编排
Skills（工具包）                  Pack（本体+Playbook）
managedFlows（HITL 辅助）        HITLGate（Playbook 挂起）
Channel auto-reply               EventKernel → notify → Channel
```

**打通方式**（runtime-bridge）：

- `llmComplete` → `api.runtime.llm.complete`（Playbook 的 `llm` 步骤）
- `subagentRun` → `api.runtime.subagent.run`（Playbook 的 `subagent` 步骤）
- `skillRun` → `api.runtime.agent.runEmbeddedAgent`（Playbook 的 `skill` 步骤）
- `notify` → `api.runtime.channel.outbound`（Playbook 的 `notification` 步骤）
- HITL `suspend/resolve` → `api.runtime.tasks.managedFlows`（HITL 状态挂到 OpenClaw 管理任务中）

---

## 四、managedFlows / cron / hooks vs Playbook —— 必要性分析

| 能力         | OpenClaw 原有                  | ClaWorks Playbook 的价值                                          |
| ------------ | ------------------------------ | ----------------------------------------------------------------- |
| **定时触发** | OpenClaw cron hooks（轻量）    | `scheduler_trigger` + Playbook 完整执行（对象持久化、HITL、审计） |
| **Webhook**  | `webhooks` 插件收消息          | Ingress 路由 → 结构化事件 → Playbook（有本体校验）                |
| **HITL**     | `managedFlows`（Agent 会话级） | `HITLGate` 挂起整个 Playbook 执行链（跨步骤状态）                 |
| **业务对象** | 聊天 context（易丢失）         | ObjectStore（版本化、可查询、本体校验）                           |
| **审计**     | 无                             | Playbook run 记录（DB 持久）                                      |
| **多域协作** | 无                             | `a2a_delegate` 步骤                                               |
| **可靠重试** | 无                             | Outbox（失败重试）                                                |

**结论**：OpenClaw 的 managedFlows/cron/hooks 适合**会话辅助**；ClaWorks Playbook 适合**企业业务流程**（可靠对象 + 审计 + 多机器人）。两者互补，不重复。

---

## 五、Robot Identity 与权限体系

### Robot Identity（robot.md）

每个机器人实例有 **`~/.claworks/robot.md`**（优先）或 Pack 内 `robot.md`（次）或内置默认。

内容包含：

- 角色宣言（名称、职能、业务域）
- 核心规则（哪些动作自动，哪些 HITL，HITL 阈值）
- 可信主体定义（system / apikey / peer / channel_user）
- HITL 升级条件

**robot.md 是「机器人的宪法」**：不依赖运行时代码，可由运营方定制，版本化存储。

### RBAC Guard

策略存储在 ObjectStore（可靠数据，可通过 REST/Pack 更新）：

```
RbacPolicy: {
  action: "event.publish" | "rest.write" | "a2a.delegate" | "hitl.resolve"
  resource: "alarm.*" | "playbook:diagnose" | "*"
  subjectType: "system" | "apikey" | "peer" | "channel_user"
  effect: "allow" | "deny"
}
```

评估顺序：精确 deny → 通配 deny → 精确 allow → 通配 allow → 默认 deny（system 始终 allow）。

**权限 Playbook 化**：`rbac.denied` 事件由 EventKernel 发布，Pack 内可写 Playbook 响应（告警、升级、审计）——权限拒绝不再沉默。

### Ingress Router

解决「IM 消息不应默认进 EventKernel」问题：

```
connector/REST/A2A/scheduler/system → kernel（直接）
IM/webhook                          → intent_route（意图 Playbook 分类后再 publish）
```

策略可存储为 ObjectType `IngressPolicy`，Pack 热重载后 `ingress.reload()`。

---

## 六、多小脑 + A2A 协作（vs 单本体）

ClaWorks 刻意选择**多小脑（多机器人）+ A2A 协作**而非 Palantir 式单本体，理由：

| 维度       | 单本体（Palantir） | 多小脑（ClaWorks）         |
| ---------- | ------------------ | -------------------------- |
| LLM 上下文 | 稀释（需全域知识） | 聚焦（单域专家）           |
| 部署复杂度 | 6-18 个月          | 天级                       |
| 故障影响   | 全局               | 域内隔离                   |
| 扩展方式   | 垂直扩大本体       | 水平增加机器人             |
| 跨域决策   | 内部               | A2A 委托（可审计、可计费） |

**实际验证**：越复杂的任务，机器人越不容易做好；单域 + LLM + Playbook 比超大本体更实用。

---

## 七、个人 OpenClaw ↔ 企业 ClaWorks 对接

**HTTP** 和 **A2A** 分别用于不同场景：

| 场景                           | 协议                        | 说明                        |
| ------------------------------ | --------------------------- | --------------------------- |
| 个人助理查询企业数据           | **HTTP REST** `/v1/objects` | 只读查询，简单 Bearer Token |
| 个人助理触发业务流程           | **HTTP REST** `/v1/events`  | 写操作，RBAC 限制           |
| 机器人 ↔ 机器人跨域委托        | **A2A** `/a2a/tasks/send`   | Task 委托，带 correlationId |
| 个人 OpenClaw 委托到企业机器人 | **A2A**                     | 企业机器人作为 A2A peer     |

HTTP 存在的理由：**REST 对标准 HTTP 客户端友好**，Cursor IDE、外部系统等可直接集成；A2A 是机器人间结构化委托协议，偏「任务下达」而非「查询」。

---

## 八、每个机器人的 IM 通道连接

每个机器人实例有：

- **管理员通道**：配置一个或多个飞书/Telegram 用户/群，负责 HITL 审批和运维指令
- **值班换班**：通过 `notify.targets` 配置（ObjectStore **`RobotOwner`** 对象 + `robot.md` Owner 可动态更新）
- **权限隔离**：channel_user 默认只读 + HITL resolve；写操作需配置 `channel_user:allow` 策略

其他员工通过**个人 OpenClaw + A2A/HTTP** 连接机器人（只读查询、提交委托），不直接操作机器人内部。

---

## 九、Playbook 步骤交叉使用

`llm` / `subagent` / `skill` 不是三选一，同一 Playbook 应根据确定性程度**混合使用**：

```yaml
steps:
  - kind: action # 确定性：查本体对象（不用 LLM）
  - kind: condition # 确定性：阈值判断（不用 LLM）
  - kind: llm # 非确定性：生成诊断建议文本
  - kind: hitl # 置信度低时暂停等人
  - kind: skill # 调用 KB 检索 Skill
  - kind: subagent # 复杂推理子任务（Pi Agent）
  - kind: a2a_delegate # 跨域委托给邻域机器人
  - kind: notification # 飞书通知
```

驱动方式不全是「发一条 IM」：

- `llm` → `api.runtime.llm.complete`（结构化 prompt）
- `skill` → `runEmbeddedAgent`（Pi，带 skill 意图）
- `subagent` → `subagent.run` + `waitForRun`（异步 Pi）

---

## 十、OpenClaw 中的速度问题

OpenClaw 处理慢的原因通常：

1. **LLM 首 token 延迟**（模型问题，非 OpenClaw）—— 当前已 < 1s
2. **工具串行调用**（Agent 逐步思考）—— 可用 `parallel` 工具组合
3. **会话记忆搜索**（memory-core）—— 可限制检索范围
4. **Playbook 并发**（`playbook_concurrency` 配置）

Cursor 快的原因：专为代码编辑优化的 prompt + streaming + 增量更新，不走完整 Agent 循环。ClaWorks 的**确定性 Playbook 步骤**（action/function/connector）也不走 LLM，速度与代码调用相当；只有 `llm`/`subagent`/`skill` 步骤受 LLM 速度影响。

---

## 十一、开源策略

| 建议开源                                     | 建议商业/私有              |
| -------------------------------------------- | -------------------------- |
| `src/kernel`, `src/planes`, `src/interfaces` | 行业 Pack（油气/流程工业） |
| `packages/claworks-sdk` + Pack 规范          | 托管 SaaS / 企业 RBAC 服务 |
| `extensions/claworks-robot` 薄封装           | 与 MES/OT 的深度连接器     |
| 示例 Pack `base` / `process-industry` 基础版 | 高级功能模块               |
| robot.md 规范 / A2A profile / MCP 工具定义   |                            |

**不**把整仓 Fork 当「替代 OpenClaw」开源；应发布 **`@claworks/runtime`** npm 包，依赖 upstream OpenClaw。

---

## 十二、演进路径：库 + 薄插件

**现状（2026-05-20）**：

- `packages/claworks-runtime`：`kernel/`、`pack-loader/`、`claworks/`、`planes/`、`interfaces/` 均已物理迁入；M3 本地 `dist/` + dist-smoke 通过。
- 根 `src/kernel|planes|interfaces|claworks` shim **已删除**；`packs-cli` 在 `packages/claworks-runtime/src/claworks/`。
- `extensions/claworks-robot`：OpenClaw 薄插件（`bridge.ts`、`runtime-bridge.ts`、`notify-channel.ts`、IM `message_received` 钩子等）。
- **发布**：当前仅本地/仓内验证，不执行 npm 公开发布。

**目标形态**（未完成部分加括号）：

```
@claworks/runtime（npm 包，本地 dist 已就绪）
  src/kernel/*           ✅
  src/pack-loader/*      ✅
  src/planes/*           ✅
  src/interfaces/*       ✅
  src/claworks/*         ✅（不含 OpenClaw api 胶水）
  dist/ + tsdown         ✅ 本地构建；（npm 公开发布）暂缓
  删除根 src/** shim     ✅

extensions/claworks-robot（薄 OpenClaw 插件）
  → 依赖 @claworks/runtime
  → 通过 api.register* 挂载服务/路由

openclaw-claworks-extension（官方 OpenClaw 用户，独立外仓）
  → HTTP/A2A 连企业 ClaWorks
  → 不捆绑 @claworks/runtime
  （本地仓 ../openclaw-claworks-extension，npm 发布暂缓）
```

---

## 十三、远景：设备皆机器人 + A2A 网格

```
[摄像头机器人]  [声波机器人]  [泵站机器人]  [充电桩机器人]
       │              │              │               │
       └──────────────┴──────────────┴───────────────┘
                              A2A（Task + 计量）
                                     │
              ┌──────────────────────┴───────────────────┐
              │         调度/协调机器人                    │
              │   A2A billing_meter: 按 Task 计量           │
              └──────────────────────────────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │    OpenClaw Channel（人）         │
                    │    飞书/Telegram/摄像头/麦克风     │
                    └─────────────────────────────────┘
```

**A2A 付费**：Task 带 `billing_meter` 字段（按次、按 token、按时间），在 Nexus/网格网关层统计，不写入 EventBus 核心。充电桩支付可通过 A2A 发起 `payment.request` 任务，由调度机器人确认并调外部支付 API。
