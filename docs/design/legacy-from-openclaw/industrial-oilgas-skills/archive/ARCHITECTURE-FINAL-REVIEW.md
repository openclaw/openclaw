# ClawTwin 架构最终审视（权威修订版）

**版本**：2.0，2026-05-11  
**依据**：基于 OpenClaw 实际源码（`extensions/acpx/`、`extensions/feishu/`）的考证  
**目的**：回答用户的四个核心问题，修正历史设计中的认知错误，给出权威架构定义

---

## 一、Hermes 是什么？（重要修正）

### 1.1 用户的纠正是正确的

用户说"Hermes 和 OpenClaw 类似，是智能体定位，不是大模型"——这个纠正是对的。

在 OpenClaw 生态中，存在一个叫做 **ACP（Agent Communication Protocol）** 的协议，以及对应的 **ACPX**（ACP eXtension）扩展。这是 OpenClaw 连接外部 AI Agent 的原生协议：

```
OpenClaw 的 ACPX 扩展 (extensions/acpx/)：
  · 是 OpenClaw 对接"外部 AI Agent"的原生机制
  · 实现了 ACP 协议（Agent Communication Protocol）
  · 典型的 ACP Agent：Codex（代码智能体）、Claude Code 等
  · 用户说的"Hermes"很可能是一个 ACP 兼容的 Agent 框架

ACP 的本质：
  · 是 Process-to-Process 的通信协议（Agent 进程 ↔ OpenClaw 进程）
  · ACP Agent 是独立进程，OpenClaw 通过 ACP 协议与之通信
  · ACP Agent 通过 MCP 协议访问工具（包括 OpenClaw 的内置工具 + 自定义 MCP Server）
```

### 1.2 ACPX 配置中的关键字段（来自真实代码）

```typescript
// extensions/acpx/src/config-schema.ts（实际代码）

type AcpxPluginConfig = {
  mcpServers?: Record<string, McpServerConfig>; // ← 关键：ACP Agent 可以使用外部 MCP Server！
  pluginToolsMcpBridge?: boolean; // ← 把 OpenClaw 插件工具 桥接为 MCP 工具
  openClawToolsMcpBridge?: boolean; // ← 把 OpenClaw 核心工具 桥接为 MCP 工具
  agents?: Record<string, { command: string }>; // ← 注册多个 ACP Agent
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
};
```

**重要发现**：ACPX 的 `mcpServers` 字段可以配置任意外部 MCP Server！这意味着：

```yaml
# openclaw.yaml / 配置示例
plugins:
  acpx:
    mcpServers:
      nexus-tools: # ← 把 Nexus 配置为 ACP Agent 可用的 MCP Server
        command: "npx"
        args: ["@clawtwin/nexus-mcp-server", "--url", "http://nexus:8000"]
    agents:
      hermes: # ← 注册 Hermes Agent
        command: "hermes"
      codex: # ← 注册 Codex Agent
        command: "codex"
```

这样，Hermes（ACP 兼容 Agent）就可以：

- 通过 ACP 协议与 OpenClaw 通信（接收用户消息）
- 通过 MCP 协议访问 Nexus 工具（查询设备数据）
- 完全不需要修改 Nexus 或 Hermes 的代码

### 1.3 Hermes 在这个架构中的正确位置

```
如果 Hermes 是 ACP 兼容的 Agent 框架：

  Feishu → OpenClaw Feishu Channel Plugin
    → OpenClaw 路由到 Hermes Agent（via ACPX）
    → Hermes ← MCP → Nexus MCP Server（Phase B）
    → Hermes 生成诊断 → OpenClaw → Feishu

Hermes 侧需要做什么：
  · 作为 ACP Agent 运行（遵守 ACP 协议）
  · 通过 MCP 访问 Nexus 工具（无需额外开发）
  · 不需要修改 OpenClaw

Nexus 侧需要做什么（Phase B）：
  · 暴露 MCP Server 端点（/mcp）
  · Hermes 通过 ACPX 配置的 mcpServers 自动发现 Nexus 工具
```

---

## 二、飞书客户端对接谁？（架构核心）

### 2.1 结论：飞书有两条独立的数据流

这是本次审视的最重要发现——我们之前混淆了"对话流"和"通知流"：

```
流 1：用户发起对话（AI 对话流）
──────────────────────────────────────────────────
飞书用户 → 飞书 App → OpenClaw Feishu Channel Plugin
  → OpenClaw Agent 处理
  → Sage Skills（调用 Nexus Tool API 获取数据）
  → OpenClaw 生成回复 → 飞书

飞书接入点：OpenClaw（飞书 Channel Plugin）
路径长度：用户 → 飞书 → OpenClaw → Nexus（工具调用）→ 回复
Nexus 的角色：数据提供方（被动响应工具调用）

流 2：系统推送通知（告警/报告流）
──────────────────────────────────────────────────
Nexus Pulse Engine → 检测到告警
  → Nexus 直接调用 飞书 API（发消息推送）
  → 飞书 → 操作员手机

飞书接入点：Nexus（直接调用飞书发消息 API）
路径长度：Nexus → 飞书 API → 用户
OpenClaw 的角色：不参与（这是系统通知，不是 AI 对话）
```

### 2.2 一个飞书 App，两种用途

```
现实实现：一个飞书开发者应用（App ID + App Secret），两种使用方式

OpenClaw 使用方式（对话）：
  · 注册 Webhook URL 到飞书（事件订阅）
  · 飞书消息触发 Webhook → OpenClaw 处理
  · OpenClaw 调用飞书 Bot API 回复

Nexus 使用方式（推送）：
  · Nexus 使用同一个 App ID + App Secret
  · 调用飞书消息推送 API（POST /v1/im/v1/messages）
  · 主动推送给操作员（不依赖 Webhook）

这两种用途完全独立，不会冲突！
（OpenClaw 处理传入消息，Nexus 发送主动推送）
```

### 2.3 旧设计的问题（需要修正）

```
❌ 错误的理解（之前混淆了）：
  飞书 → Nexus（接收消息）→ OpenClaw（AI 处理）→ 回复飞书

✅ 正确的架构：
  飞书 → OpenClaw（接收消息，AI 处理）→ 工具调用 → Nexus Tool API
  Nexus → 飞书（主动推送告警/报告）

关键区别：
  · Nexus 不接收对话消息，只推送通知
  · OpenClaw 不主动推送通知，只响应对话
```

---

## 三、是 Nexus 调用 OpenClaw，还是 OpenClaw 调用 Nexus？

### 3.1 两个方向都存在，但性质不同

```
方向 A（主要方向）：OpenClaw 调用 Nexus
─────────────────────────────────────────
触发时机：用户在飞书/Studio 发起 AI 请求
驱动方：OpenClaw（AI 运行时）
动作：OpenClaw 的 Sage Skills 调用 Nexus Tool API 获取数据
协议：HTTP REST（Phase A）/ MCP（Phase B）
这是 AI 工作流的主路径

方向 B（辅助方向）：Nexus 调用 OpenClaw
─────────────────────────────────────────
触发时机：系统事件（告警/定时任务）需要 AI 分析
驱动方：Nexus（业务协调层）
动作：Nexus 调用 OpenClaw API 启动新的 AI Session
协议：HTTP REST（OpenClaw 暴露的 session/run API）
这是"主动触发 AI 分析"的路径（Studio 点按钮也走这条）
```

### 3.2 方向 B 的详细流程

```
Nexus 主动触发 AI 分析的两种场景：

场景 1：Studio 用户点击"AI 诊断"
  Studio → POST /v1/ai/jobs { job_type: "diagnose", equipment_id: 2 }
  Nexus 创建 ai_job 记录
  Nexus 调用 OpenClaw API 启动 Session（带设备上下文）
  OpenClaw 运行 Sage Skill → 调用 Nexus Tool API 获取详细数据
  OpenClaw 生成诊断 → POST /v1/ai/jobs/{id}/result 回写 Nexus
  Nexus SSE → Studio 实时展示结果

场景 2：Pulse Engine 检测到 P1 告警
  Pulse Engine 检测阈值越界
  Nexus 调用 OpenClaw API 启动紧急诊断 Session
  OpenClaw Sage Skill → 工具调用 → 数据 → 诊断报告
  Nexus 存储诊断报告
  Nexus 调用飞书 API 推送告警卡片（含 AI 诊断摘要）
```

### 3.3 商业逻辑归属原则

```
「谁主导业务，谁发起调用」

业务流程主体              主导方         调用关系
──────────────────────────────────────────────────
用户 AI 对话              OpenClaw      OpenClaw → Nexus Tool API
Studio 按钮触发 AI        Nexus         Nexus → OpenClaw → Nexus Tool API
告警自动触发 AI           Nexus         Nexus → OpenClaw → Nexus Tool API
工单状态变更              Nexus         Nexus → 飞书 API（推送通知）
用户飞书发消息            OpenClaw      OpenClaw 接收 → Sage Skills → Nexus Tool API
OA 审批回调              Nexus         Nexus 接收 OA Webhook → 更新工单
```

---

## 四、Agent 对接协议（ACP / MCP / REST / A2A）

### 4.1 协议全景（基于 OpenClaw 实际代码）

```
协议              是什么              OpenClaw 支持   在 ClawTwin 中的作用
──────────────────────────────────────────────────────────────────────────
MCP               Model Context       ✅ 支持         Nexus Phase B 成为 MCP Server
(Model Context    Protocol             (via ACPX)      ACP Agent 自动发现 Nexus 工具
Protocol)         工具发现+调用协议

ACP               Agent               ✅ 原生支持     连接 Hermes/Codex 等外部 Agent
(Agent Comm.      Communication       (ACPX 扩展)     到 OpenClaw 的通信协议
Protocol)         Protocol
                  进程间 Agent 通信

A2A               Agent-to-Agent      ❓ 未确认       Google 提出的 Agent 协作标准
                  Google 标准          （未来关注）    ClawTwin 暂不涉及

REST HTTP         标准 HTTP           ✅ Phase A     Nexus Tool API（当前实现）
                  REST API            基础方案        所有 Agent 都能调用
```

### 4.2 Phase A vs Phase B 的协议选择

```
Phase A（当前）：REST HTTP Tool API
  ✅ 简单可控，直接实现
  ✅ 所有 Agent（OpenClaw/HiAgent/Dify）都能调用
  ✅ 不依赖 MCP 生态成熟度
  缺点：工具定义需要手写 function schema

Phase B（规划）：Nexus 作为 MCP Server
  ✅ Agent 自动发现所有 Nexus 工具（无需手写 schema）
  ✅ 与 ACPX 原生集成（配置 mcpServers 即可）
  ✅ 支持 ACP 兼容 Agent（Hermes 等）无缝接入
  ✅ 与 OpenClaw 的 MCP 生态完全兼容
  路径：实现 /mcp 端点（标准 MCP Server JSON-RPC）
```

### 4.3 从 OpenClaw 实际代码学到的借鉴

```
借鉴 1：ACPX 的 mcpServers 配置模式
  OpenClaw 通过配置 mcpServers 让 ACP Agent 访问外部 MCP Server
  → 我们应该把 Nexus 做成 MCP Server，这样任何 ACP Agent 都能接入
  → 无需在每个 Agent 里手动配置 Nexus 的 REST API 路由

借鉴 2：pluginToolsMcpBridge 和 openClawToolsMcpBridge
  OpenClaw 把自己的工具自动桥接为 MCP 工具给 ACP Agent 用
  → Nexus 应该类似：把所有 Tool API 自动暴露为 MCP 工具
  → 实现：FastAPI MCP Router（把每个 /v1/tools/* 路由转为 MCP Tool）

借鉴 3：ACP Agent 作为独立进程
  ACP Agent 是独立的可执行程序，OpenClaw 通过协议与之通信
  → Sage 实际上可以是一个 ACP 兼容的独立进程！
  → Nexus 提供 MCP Server，Sage Agent（ACP 进程）访问数据
  → 这是比"OpenClaw 插件"更解耦的方式（Phase C 方向）

借鉴 4：Feishu Channel Plugin 是 OpenClaw 的完整实现
  extensions/feishu/ 有 171 个文件，完整实现了飞书的所有功能
  → 我们不需要重新做飞书 Bot 的对话处理
  → 只需要：① 配置 OpenClaw + Feishu Channel ② 安装 Sage Skills
  → Nexus 只做推送（调用飞书 API），不做对话接收
```

---

## 五、正确的整体架构图（最终版）

```
┌────────────────────────────────────────────────────────────────────┐
│                        终端用户侧                                    │
│                                                                    │
│  飞书 App    Studio (Web)    飞书 OA 审批                           │
└──────┬───────────┬──────────────┬─────────────────────────────────┘
       │           │              │
  对话消息     Studio API     OA 审批回调
       │           │              │
       ▼           │              ▼
┌──────────────┐   │    ┌─────────────────────────────────────────┐
│              │   │    │         Nexus Platform                   │
│   OpenClaw   │   │    │                                         │
│   Gateway    │   │    │  REST API     ┌─────────────────────┐   │
│              │   │    │  /v1/*    ←───│   Studio 用户 API    │   │
│  ┌─────────┐ │   │    │               └─────────────────────┘   │
│  │ Feishu  │ │   └───►│               ┌─────────────────────┐   │
│  │ Channel │ │        │               │ ai_job_worker        │   │
│  │ Plugin  │ │        │               │  （AgentConnector）   │   │
│  └────┬────┘ │        │               └──────────┬──────────┘   │
│       │      │        │                          │              │
│  ┌────▼────┐ │        │               ┌──────────▼──────────┐   │
│  │  Agent  │ │        │               │  Pulse Engine        │   │
│  │  Core   │◄├────────┤               │  Scheduler           │   │
│  └────┬────┘ │ 工具调用│               │  Alarm Manager       │   │
│       │      │  结果  │               └──────────┬──────────┘   │
│  ┌────▼────┐ │        │                          │              │
│  │  Sage   │ │        │               ┌──────────▼──────────┐   │
│  │ Skills  │─┼────────►  Tool API     │  Tool API Router     │   │
│  └─────────┘ │ HTTP   │  /v1/tools/*  │  /v1/tools/equipment │   │
│              │ REST   │               │  /v1/tools/kb        │   │
│   ACPX ext.  │ (PhA)  │               │  /v1/tools/workorder │   │
│  ┌─────────┐ │ MCP    │               └──────────────────────┘   │
│  │ Hermes  │─┼────────►  MCP Server   ┌──────────────────────┐   │
│  │(ACP Agnt│ │ (PhB)  │  /mcp         │  Data Layer           │   │
│  └─────────┘ │        │               │  PostgreSQL/TimescaleDB│   │
│              │        │               │  Milvus / Redis       │   │
└──────────────┘        │               └──────────────────────┘   │
       │                │                          │               │
       │ 回调写入结果    │        ┌─────────────────┘               │
       │               │        ▼                                  │
       │        POST /v1/ai/jobs/{id}/result                       │
       │               │                                           │
       │        Nexus 存储结果                                      │
       │               │                                           │
       │        SSE 推流 → Studio 实时展示                          │
       │                                                           │
       │                       ┌──────────────────────────────────┤
       │                       │   Nexus 主动推送（飞书 API 直调）  │
       └── 告警/报告卡片 ←──── │   POST /v1/im/v1/messages         │
           推送到用户飞书       └──────────────────────────────────┘
```

---

## 六、发现的架构错误清单

### 错误 1：Nexus 的飞书 Webhook 接收器角色过载（严重）

**原设计**：Nexus 同时承担"接收飞书对话消息"+ "接收飞书 OA 审批回调"+ "系统推送"

**正确设计**：

- 飞书对话消息 → OpenClaw 的 Feishu Channel Plugin 接收（不是 Nexus）
- 飞书 OA 审批回调 → Nexus 接收（这个正确，是业务回调）
- 系统推送 → Nexus 直接调用飞书 API（不是接收，是发送）

**修正**：

```
Nexus 的 /v1/feishu/ 路由只保留：
  ✅ POST /v1/feishu/webhook/oa-approval  ← 接收 OA 审批回调
  ✅ POST /v1/feishu/webhook/card-action  ← 接收卡片按钮点击
  ❌ 删除对话消息接收逻辑（这是 OpenClaw 的职责）
```

### 错误 2：Sage Skills 的部署方式描述不清

**原设计**：说"安装 Sage Skills 到 OpenClaw"，但没有明确 Skill 是什么形式

**正确定义**：

```
Sage Skill 的实际形式（OpenClaw 原生方式）：

对于 OpenClaw（最完整方式）：
  · Skill = openclaw.plugin.json + 若干 TS/JS 文件
  · 定义 Function Tools 指向 Nexus Tool API
  · System Prompt 嵌入工业诊断提示词
  · 安装：openclaw install ./sage/industrial-twin/
  · 不需要 ACP，直接作为 OpenClaw 插件运行

对于 ACP Agent（Hermes 等）：
  · Sage 的提示词作为 Agent 的 System Prompt
  · Nexus MCP Server 提供工具（Phase B）
  · 不需要安装任何"Skill"文件
  · ACPX 配置 mcpServers.nexus 即可
```

### 错误 3：ADR-8 中描述的连接方式有遗漏（需要补充）

ADR-8 只描述了 REST HTTP 连接，遗漏了：

- ACP + MCP 是 OpenClaw 原生的连接方式
- Phase B 应该优先用 MCP（不是 REST）

### 错误 4：AgentConnector 的触发 API 不够准确

**原设计**：描述为"POST /openclaw/v1/agent/run"（推测的 API）

**正确做法**：需要查阅 OpenClaw 实际开放的 session/run API 文档，目前应该用：

- OpenClaw Gateway REST API（具体端点待查阅 OpenClaw 文档）
- 或者：通过 OpenClaw 的 webhook/event 机制触发

---

## 七、修订后的 Nexus 飞书集成模块

```python
# platform/services/feishu.py 修订版

class FeishuService:
    """Nexus 的飞书集成 - 仅负责主动推送，不处理对话"""

    # ✅ 保留：主动推送系统通知
    async def push_alarm_card(self, user_id: str, alarm: Alarm) -> None:
        """推送 P1/P2 告警卡片给操作员"""

    async def push_workorder_approval(self, supervisor_id: str, wo: WorkOrder) -> None:
        """推送工单审批卡片给主管"""

    async def push_morning_report(self, station_admin_id: str, report: dict) -> None:
        """推送晨报给站场管理员"""

    async def push_ai_analysis_result(self, user_id: str, result: dict) -> None:
        """推送 AI 诊断结果（当 Studio 用户不在线时 fallback 到飞书）"""

    # ✅ 保留：处理 OA 审批回调（Nexus 的 Webhook 端点）
    # 在 routers/feishu.py 中：POST /v1/feishu/webhook/oa-approval
    # 在 routers/feishu.py 中：POST /v1/feishu/webhook/card-action

    # ❌ 删除：接收对话消息
    # → 对话消息由 OpenClaw Feishu Channel Plugin 接收，Nexus 不参与
```

---

## 八、Phase A/B/C 的连接协议演进路线

```
Phase A（现在）：Sage Skills + REST Tool API
────────────────────────────────────────────
· Sage Skills 作为 OpenClaw 插件安装
· Skills 调用 Nexus REST Tool API（/v1/tools/*）
· Nexus 调用 OpenClaw Session API 做主动触发
· 工具 schema 手写，维护成本中等

Phase B（6-12个月后）：Nexus MCP Server
────────────────────────────────────────────
· Nexus 暴露标准 MCP Server（/mcp）
· OpenClaw ACPX 配置 mcpServers.nexus 指向 Nexus MCP Server
· ACP Agent（包括 Hermes）自动发现所有 Nexus 工具
· 无需手写 function schema（MCP 自动协商工具定义）
· Sage Skills 从"工具定义" → "只剩 System Prompt"
· 主动触发：仍然通过 OpenClaw Session API

Phase C（18个月后）：Sage Agent（独立 ACP 进程）
────────────────────────────────────────────
· Sage Agent 是独立的 ACP 兼容进程
· 通过 ACP 协议注册到 OpenClaw
· 通过 MCP 访问 Nexus 工具
· 更大的自主性，可以独立升级不影响 OpenClaw
· OpenClaw 只做"消息路由 + 会话管理"
```

---

## 九、仍然存在的不确定性（需要查阅文档）

```
❓ 未确定项 1：OpenClaw 对外暴露的 Session API
  · 我们需要"Nexus 调用 OpenClaw 启动 AI 任务"
  · 这个 API 的具体路径/格式需要查阅 OpenClaw REST API 文档
  · 临时方案：直接调用 OpenClaw Gateway 的 /api/* 端点（需要验证）

❓ 未确定项 2：Hermes 的具体产品形态
  · 用户提到"Hermes"，我们猜测是 ACP 兼容 Agent
  · 如果用户能确认 Hermes 的产品链接/文档，可以做更精确的集成设计
  · 当前架构对"ACP 兼容 Agent"完全开放，无论 Hermes 具体是什么

❓ 未确定项 3：OpenClaw 主动触发的最佳方式
  · 目前 AgentConnector 里写的是"POST /openclaw/v1/agent/run"
  · 需要确认 OpenClaw 是否有这样的 API
  · 备选：通过 MCP/ACP 协议让 OpenClaw 主动 poll Nexus 的任务队列
```

---

## 十、一次性架构自检清单

```
✅ 飞书对话消息由 OpenClaw 处理（不是 Nexus）
✅ Nexus 只做飞书推送（主动通知），不做飞书接收（对话）
✅ OpenClaw 调用 Nexus Tool API（主要方向）
✅ Nexus 调用 OpenClaw API 做主动触发（辅助方向）
✅ Sage Skills 是 OpenClaw 插件（Phase A）
✅ Nexus 将在 Phase B 暴露 MCP Server
✅ ACP Agent（Hermes）可通过 ACPX + MCP 接入，无需改代码
✅ AgentConnector 抽象层设计方向正确，API 具体路径待确认
✅ Studio 不直接调用 OpenClaw，通过 Nexus 代理
✅ Feishu OA 审批回调由 Nexus 接收（不是 OpenClaw）
✅ 系统推送（告警/报告）由 Nexus 直接调飞书 API
✅ 工单状态机在 Nexus 中，OpenClaw 不掌管业务状态

❓ OpenClaw 对外 API 格式（AgentConnector 具体实现待查）
❓ Hermes 的具体形态（ACP 兼容？自定义协议？）
❓ Phase B MCP Server 实现路径（FastAPI 中添加 JSON-RPC 端点）
```

---

_本文档是 ClawTwin 架构的最终权威版本。_  
_本文档基于 OpenClaw 实际源代码（extensions/acpx/ 和 extensions/feishu/）考证。_  
_早期文档中"Nexus 接收飞书对话消息"的说法已在本文修正。_
