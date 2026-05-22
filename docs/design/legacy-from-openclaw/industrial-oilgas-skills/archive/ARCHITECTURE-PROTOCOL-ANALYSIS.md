# ClawTwin 协议与接口全面分析（基于 OpenClaw 源码实证）

**版本**：1.0，2026-05-11  
**重要发现**：Hermes 是 OpenClaw 的直接竞品/前身，OpenClaw 有内建的 `migrate-hermes` 迁移工具  
**核心结论**：Nexus 应该从 Phase A 就暴露 MCP Server，这是消除 AI 运行时耦合的关键

---

## 一、Hermes 是什么？（源码实证）

### 1.1 关键发现

OpenClaw 代码库中存在 `extensions/migrate-hermes/`，完整描述如下：

```
package.json:
  "description": "Hermes to OpenClaw migration provider"

source.ts（Hermes 的数据目录结构）：
  ~/.hermes/
  ├── config.yaml           ← AI 运行时配置（模型/提供商）
  ├── .env                  ← 环境变量（API Keys）
  ├── SOUL.md               ← Agent 人格定义
  ├── AGENTS.md             ← Agent 指令（等同 OpenClaw 的 AGENTS.md！）
  ├── skills/               ← 技能目录（每个技能有 SKILL.md！）
  │   └── <skill-name>/
  │       └── SKILL.md      ← 技能定义（格式与 OpenClaw 兼容！）
  ├── memories/
  │   ├── MEMORY.md
  │   └── USER.md
  ├── plugins/              ← 插件（类似 OpenClaw 插件）
  ├── sessions/             ← 会话状态
  ├── mcp-tokens/           ← MCP 认证 Token（Hermes 也支持 MCP！）
  ├── cron/                 ← 定时任务
  └── logs/
```

**结论**：Hermes 与 OpenClaw 是**几乎完全相同定位的产品**：

- 都是 AI 代理运行时（Agent Runtime）
- 都支持 Skills（SKILL.md 格式）
- 都支持 MCP（mcp-tokens）
- 都有记忆、会话、插件系统
- Hermes 是 OpenClaw 的前身或竞品，用户可以从 Hermes 迁移到 OpenClaw

### 1.2 Hermes 替代 OpenClaw 是否可行？

**完全可行，架构不需要改变。** 原因：

```
ClawTwin 对 AI Agent Runtime 的最低要求（与产品无关）：

① 连接飞书 Channel               OpenClaw ✅  Hermes ✅（需验证飞书 plugin）
② 调用 MCP 工具（Nexus MCP）     OpenClaw ✅  Hermes ✅（mcp-tokens 目录存在！）
③ 加载 SKILL.md 技能定义         OpenClaw ✅  Hermes ✅（skill 目录格式相同！）
④ OpenAI 兼容的 LLM 调用         OpenClaw ✅  Hermes ✅（config.ts 中使用 openai-completions）
⑤ 提供 REST API 供 Nexus 触发    OpenClaw ✅  Hermes ？（需要确认其 REST API）
⑥ 会话管理（多用户）             OpenClaw ✅  Hermes ✅（sessions 目录）

Hermes 的技能格式（SKILL.md）与 OpenClaw 兼容
→ 我们写的 Sage Skills 可以在两者之间直接移植
→ Nexus MCP Server 对两者同样有效
→ 选择 Hermes 或 OpenClaw 仅是部署配置差异
```

---

## 二、OpenClaw 支持的全部协议和接口（源码实证）

### 2.1 Channel 协议（用户接入层）

```
extensions/ 目录下的 Channel 扩展（消息渠道）：

即时通讯类：
  feishu        飞书（最完整，171个文件，支持消息/文档/审批/卡片/OA）
  telegram      Telegram Bot API
  discord       Discord Gateway + REST API
  slack         Slack Events API + Web API
  line          LINE Messaging API
  whatsapp      WhatsApp Business API
  signal        Signal 私信协议
  msteams       Microsoft Teams Bot Framework
  googlechat    Google Chat Pub/Sub
  imessage      iMessage via BlueBubbles
  matrix        Matrix Federation Protocol
  nextcloud-talk Nextcloud Talk REST API
  irc           IRC Protocol
  tlon          Urbit Landscape Protocol
  qqbot         QQ Bot API
  zalo          Zalo OA API
  synology-chat Synology Chat Webhook

专业类：
  nostr         Nostr 去中心化协议
  mattermost    Mattermost REST API
  twitch        Twitch Chat IRC

自部署类：
  bonjour       mDNS 局域网发现
  device-pair   设备配对协议

统一接口规范（每个 Channel 实现）：
  · 接收 Webhook 事件（平台 → OpenClaw）
  · 发送消息 API（OpenClaw → 平台）
  · 会话/线程绑定（conversation binding）
  · 会话路由（消息路由到指定 Agent）
```

### 2.2 AI Provider 协议（模型接入层）

```
extensions/ 目录下的 Provider 扩展（AI 模型接入）：

OpenAI 生态：
  openai          OpenAI API（GPT 系列，o3/o4 等）
  azure           Azure OpenAI Service
  openrouter      OpenRouter（聚合多模型）
  copilot-proxy   GitHub Copilot 代理
  litellm         LiteLLM 统一接口

Anthropic 生态：
  anthropic       Anthropic Claude API
  anthropic-vertex Claude via Vertex AI

Google 生态：
  google          Google Gemini API
  google-meet     Google Meet（语音/视频）

国内模型：
  qwen            通义千问（Qwen 系列）
  deepseek        DeepSeek
  moonshot        月之暗面 Kimi
  minimax         MiniMax
  qianfan         百度文心
  volcengine      火山引擎
  stepfun         阶跃星辰
  tencent         腾讯混元
  zai             智谱 AI（GLM）
  xiaomi          小米大模型
  byteplus        字节 BytePlus

本地部署：
  ollama          Ollama 本地模型运行
  vllm            vLLM 推理服务
  lmstudio        LM Studio 桌面版

其他云端：
  nvidia          NVIDIA NIM
  together        Together AI
  groq            Groq 推理加速
  cerebras        Cerebras 推理
  deepinfra       DeepInfra
  fireworks       Fireworks AI
  huggingface     Hugging Face Inference
  mistral         Mistral AI

统一接口规范（所有 Provider 实现）：
  · OpenAI Completions API 格式（openai-completions）
  · OpenAI Responses API 格式（openai-responses）
  · 工具调用（function calling / tool_use）
  · 流式输出（SSE streaming）
  · 上下文长度管理
```

### 2.3 工具/能力协议（AI 能力扩展层）

```
工具类扩展：
  acpx            ACP（Agent Communication Protocol）- 外部 Agent 集成
  codex           Codex/Claude Code AI 编码 Agent
  browser         Puppeteer 浏览器自动化
  openshell       Shell 命令执行
  diffs           文件差异比较
  memory-core     记忆核心（短期/长期）
  memory-wiki     Wiki 形式记忆
  memory-lancedb  向量记忆存储
  active-memory   活跃记忆管理
  document-extract 文档提取（PDF/Word/Excel）
  web-readability  网页内容提取
  image-generation-core 图像生成
  video-generation-core 视频生成
  speech-core     语音识别核心
  voice-call      语音通话
  comfy           ComfyUI 图像工作流
  media-understanding-core 多媒体理解

搜索扩展：
  brave           Brave Search API
  searxng         SearXNG（自部署搜索）
  tavily          Tavily AI 搜索
  exa             Exa 语义搜索
  firecrawl       Firecrawl 网页爬取
  duckduckgo      DuckDuckGo 搜索
  perplexity      Perplexity AI 搜索

协议：
  MCP（Model Context Protocol）:
    · ACPX 通过 mcpServers 配置可连接任意 MCP Server
    · ACP Agent 通过 MCP 调用工具
    · ACPX 有 pluginToolsMcpBridge 把 OpenClaw 工具桥接为 MCP
```

### 2.4 Gateway 内部协议

```
src/gateway/protocol/ 定义的 Gateway 协议（OpenClaw 内部）：

传输层：
  · WebSocket（operator 客户端 ↔ Gateway 服务器）
  · HTTP REST（工具调用、webhook）
  · SSE（流式输出）

数据帧格式（protocol/schema/*.ts）：
  · frames.ts    - 消息帧（chat/delta/done/error）
  · sessions.ts  - 会话管理协议
  · channels.ts  - Channel 消息协议
  · agents-models-skills.ts - Agent/Model/Skill 管理
  · commands.ts  - 命令执行
  · cron.ts      - 定时任务
  · exec-approvals.ts - 执行审批（HITL）
  · push.ts      - 推送通知
  · plugins.ts   - 插件管理

标准化 Skill 格式（SKILL.md）：
  · 支持 OpenClaw 和 Hermes（两者格式兼容）
  · 包含：system_prompt、tools（MCP 或 HTTP）、memory、配置
```

---

## 三、这是 AI 发展方向吗？

### 3.1 行业共识正在形成

```
2024-2026 年 AI 协议标准化进程：

MCP（Model Context Protocol）— Anthropic，2024年底发布
  · 已被采用：OpenAI、Google、Microsoft、AWS、IBM、Nvidia...
  · 定位：AI 访问工具/资源的标准协议
  · 类比：HTTP 之于 Web，MCP 之于 AI 工具访问
  · OpenClaw 已支持（ACPX mcpServers），Hermes 也已支持（mcp-tokens）

A2A（Agent-to-Agent）— Google，2025年发布
  · 定位：Agent 之间相互调用/协作的标准协议
  · 现状：仍在早期，采用率不如 MCP

OpenAI Function Calling 格式
  · 事实标准：几乎所有 AI runtime 都支持这个工具定义格式
  · MCP 在一定程度上建立在这个基础上

结论：
  MCP 正在成为 AI 工具访问的"HTTP"
  任何值得关注的 AI 工具层都应该暴露 MCP 接口
  ClawTwin Nexus 暴露 MCP Server 是正确方向，且应在 Phase A 就做
```

### 3.2 AI 运行时的商品化趋势

```
正在发生的趋势：

过去（2023之前）：
  AI 工具层紧耦合于特定 AI 运行时
  → 换一个 AI 就要重写工具调用代码

现在（2024-2026）：
  MCP 标准化：工具暴露一次，所有 AI 运行时都能用
  → OpenClaw/Hermes/Dify/Claude/GPT-4o 都能调用同一套工具

未来趋势：
  AI 运行时（OpenClaw/Hermes/Dify）→ 商品化（任一均可）
  工具层（Nexus）→ 价值所在，MCP 是接入标准
  领域知识（Sage 提示词 + KB）→ 核心差异化

对 ClawTwin 的启示：
  Nexus（工具 + 数据 + 业务逻辑）= 我们的护城河
  OpenClaw/Hermes = 可替换的"AI 发动机"
  Sage Skills = 可移植的智能层（SKILL.md 格式）
```

---

## 四、ClawTwin 实际需要的最小协议集合

### 4.1 Nexus 应该支持的协议

```
优先级 P0（Phase A，必须）：

1. MCP Server（/mcp）
   为什么 Phase A 就做（不等 Phase B）：
   · OpenClaw、Hermes 都支持 MCP
   · 工具 schema 自动生成，消除手写 function 定义
   · 一次实现，所有 AI 运行时受益
   · 实现成本：低（FastAPI 的 MCP 库已有开源实现）

2. REST API（/v1/*）
   面向：Studio Web、OA 系统、ERP 对接
   协议：标准 HTTP JSON REST
   不变，保持现有设计

3. SSE（Server-Sent Events）
   面向：Studio 实时更新
   不变，保持现有设计

4. Service Token 认证（Bearer + X-Nexus-Service-Token）
   面向：MCP Client（AI 运行时）+ 外部系统
   不变，保持现有设计

优先级 P1（Phase B）：

5. Webhook 事件推送（对外）
   Nexus → 外部系统（OA/ERP）推送事件

6. A2A（观察，暂不实现）
   等待生态成熟再评估
```

### 4.2 AI 运行时（OpenClaw/Hermes）应该提供的接口

```
Nexus 对 AI 运行时的要求（只有两个）：

要求 1：能作为 MCP Client 调用 Nexus MCP Server
  → OpenClaw: ✅（ACPX mcpServers 配置）
  → Hermes: ✅（mcp-tokens 存在，支持 MCP）
  → Dify: ✅（原生 MCP 支持）
  → 任何现代 AI 运行时: ✅

要求 2：提供 REST API 让 Nexus 触发新的 AI Session（主动分析）
  → 格式：POST /api/session/run { system_prompt, user_message }
  → OpenClaw: ✅（待确认具体路径）
  → Hermes: ✅（待确认具体路径）
  → Dify: ✅（/v1/workflows/run 或 /v1/chat-messages）
  → HiAgent: ✅（/workflows/{id}/run）

仅此两个要求！Sage Skills 不再是 OpenClaw-specific 的插件！
```

### 4.3 Sage Skills 的正确定义（协议无关）

```
Sage Skill 是一个 SKILL.md 文件 + MCP 配置，与运行时无关：

skills/industrial-twin/SKILL.md:
  ---
  name: industrial-twin
  description: ClawTwin 设备状态查询与诊断
  ---

  # 系统提示词
  你是 ClawTwin 工业 AI 助手，专注于油气站场设备诊断...
  [完整的 Sage 系统提示词]

  # 工具配置（MCP 模式，Phase A/B 共用）
  tools:
    - name: get_equipment_context
      description: 获取设备当前状态、健康评分、历史趋势和 AI 分析
    - name: search_knowledge_base
      description: 搜索工业知识库
    - name: create_work_order
      description: 创建维修工单

  # MCP Server（Phase B 配置）
  mcp_servers:
    nexus:
      url: http://nexus:8000/mcp
      auth: service-token

  # Phase A 的 REST 工具定义（过渡期使用）
  rest_tools:
    get_equipment_context:
      url: http://nexus:8000/v1/tools/equipment/context
      method: GET
      params: { equipment_id: int }

这个 SKILL.md 可以在 OpenClaw 和 Hermes 之间直接移植
不需要修改任何代码，只是复制文件
```

---

## 五、架构优化方案（基于协议分析）

### 5.1 最重要的一个变化：MCP Server 提前到 Phase A

```
原计划：Phase B 才做 MCP Server
新方案：Phase A 就做 MCP Server

理由：
  · 实现成本低：Python FastAPI 有成熟的 MCP 库
  · 立即消除 AgentConnector 中的"工具调用"方向
  · 让 Sage Skills 直接用 MCP 模式（不需要 REST 工具定义）
  · 对 Hermes/OpenClaw 都适用，无需分别配置

实现方式：
  # 安装 MCP Python 库
  pip install mcp  # Anthropic 官方库

  # 在 Nexus 中添加一个 MCP router
  # platform/routers/mcp.py

  from mcp.server import MCPServer
  from mcp.server.fastapi import create_mcp_router

  mcp_server = MCPServer("clawtwin-nexus")

  @mcp_server.tool()
  async def get_equipment_context(equipment_id: int) -> dict:
      """获取设备当前状态、健康评分和 AI 分析上下文"""
      return await equipment_service.get_decision_package(equipment_id)

  @mcp_server.tool()
  async def search_knowledge_base(query: str, equipment_type: str = None) -> list:
      """搜索工业知识库"""
      return await kb_service.search(query, filter_type=equipment_type)

  @mcp_server.tool()
  async def create_work_order(equipment_id: int, problem: str, priority: str) -> dict:
      """创建维修工单"""
      return await workorder_service.create_ai_draft(equipment_id, problem, priority)

  @mcp_server.tool()
  async def list_active_alarms(station_id: int) -> list:
      """获取站场活跃告警列表"""
      return await alarm_service.list_active(station_id)

  # 在 main.py 中注册
  mcp_router = create_mcp_router(mcp_server, path="/mcp")
  app.include_router(mcp_router)
```

### 5.2 AgentConnector 的简化

```
原设计（过于复杂）：
  AgentConnector 抽象层 + OpenClawConnector + HiAgentConnector + DifyConnector

新设计（简化）：

问题 1（工具调用方向，Agent → Nexus）：
  ✅ 通过 MCP 解决（无需 Connector）

问题 2（主动触发方向，Nexus → Agent）：
  保留 AgentConnector，但只有一个接口：
  async def trigger_ai_session(prompt: str, context: dict) -> str

  不同运行时的实现：
  OpenClaw:  POST /api/session + message
  Hermes:    POST /api/run（待查文档）
  Dify:      POST /v1/workflows/run
  HiAgent:   POST /v1/workflows/{id}/run
  Nexus 直驱: 直接调用 vLLM API

  这个接口极度简化，只需要"开始一个任务"的能力
  工具调用（获取数据）通过 MCP 解决，不在 AgentConnector 范围内
```

### 5.3 架构图（基于协议的最终版）

```
┌─────────────────────────────────────────────────────────────────┐
│                    用户接入层                                     │
│  飞书 → AI Runtime（Feishu Channel）                             │
│  Studio → Nexus REST API                                        │
│  OA/ERP → Nexus REST API / Webhook                              │
└──────────────────┬──────────────────────────────────────────────┘
                   │
     ┌─────────────▼─────────────────┐
     │    AI Agent Runtime           │
     │  （OpenClaw OR Hermes OR Dify）│
     │                               │
     │  Loads:                       │
     │    SKILL.md（Sage 提示词）     │
     │  Connects to:                 │
     │    Nexus MCP Server（工具）    │
     │    vLLM API（推理）            │
     └──────────────┬────────────────┘
                    │
           MCP Protocol（标准，协议统一）
                    │
     ┌──────────────▼────────────────────────────────────────────┐
     │                   Nexus Platform                           │
     │                                                           │
     │  /mcp          → MCP Server（工具 + 资源，Phase A）        │
     │  /v1/tools/*   → REST Tool API（MCP 的 HTTP 包装，向下兼容）│
     │  /v1/*         → Studio API / OA API                      │
     │  /v1/sse/*     → SSE 实时推流                              │
     │  /v1/feishu/*  → 飞书推送 + OA 回调                       │
     │                                                           │
     │  AgentConnector（仅用于主动触发 AI 任务，简化版）           │
     │  Pulse Engine / Scheduler（系统主动触发方）                 │
     │                                                           │
     │  数据层：PostgreSQL(TimescaleDB) + Milvus + Redis + Kafka  │
     └───────────────────────────────────────────────────────────┘
```

### 5.4 选择 AI 运行时的决策矩阵（更新版）

```
客户需求              推荐运行时     理由
────────────────────────────────────────────────────────────────
默认/通用场景         OpenClaw       生态完整，Skill 开箱即用
已用 Hermes           Hermes         SKILL.md 兼容，零迁移成本
飞书深度绑定的企业    HiAgent        OA 审批最深度，工作流最自然
代码可审计的央企      Dify（私有化） 国产开源，完整审计，MCP 原生
要求最简依赖         Nexus 直驱     直接调 vLLM，零 Agent 依赖
未来：完全自主可控    自研 ACP Agent 基于 openclaw/acpx 包自研

关键：所有选项都通过 MCP 访问 Nexus（唯一共同点）
```

---

## 六、与之前设计的差异总结（需要修正的内容）

```
修正 1：Sage Skills 的定义方式
  原来：OpenClaw-specific 插件格式（需要 TS 代码）
  现在：SKILL.md 格式（Markdown + MCP 配置，OpenClaw/Hermes 均可用）

修正 2：Nexus Tool API 的定位
  原来：专门为 AI Agent 设计的 REST API（Phase A），MCP 是 Phase B
  现在：MCP Server 在 Phase A 实现，REST Tool API 作为 MCP 的补充（向下兼容）

修正 3：AgentConnector 的职责范围
  原来：同时处理"工具调用"和"主动触发"两个方向
  现在：只处理"主动触发"方向（工具调用通过 MCP 解决）

修正 4：AI 运行时的位置
  原来：设计文档中 OpenClaw 是"默认"并有特殊位置
  现在：OpenClaw/Hermes 是完全可替换的"AI 发动机"，对 Nexus 完全透明

修正 5：Hermes 的认知
  原来：误认为是一个 LLM 模型（OpenHermes）
  现在：Hermes 是 OpenClaw 的直接竞品/前身，SKILL.md 格式兼容，MCP 支持
```

---

## 七、Phase A 优先行动（基于协议分析）

```
Week 1 新增（之前没有）：
  ① 安装 mcp Python 包（pip install mcp）
  ② 实现 platform/routers/mcp.py（4 个核心 Tool）
  ③ 在 main.py 注册 MCP router（/mcp 端点）
  ④ 更新 Sage SKILL.md 使用 MCP 配置
  估时：1 名工程师 × 3 天

Week 1 简化（之前设计的）：
  ⑤ AgentConnector 只实现"触发 session"接口（不需要工具调用相关代码）
  ⑥ 取消 manual REST Tool API 的 function schema（改用 MCP 自动生成）
  估时：减少 2 天工作量

整体影响：
  · 前端和后端并行度提高（MCP 统一了工具协议，减少约定成本）
  · AI 运行时选择延迟到部署时决定（不影响 Nexus 开发）
  · Sage Skills 可以被任何开发者（包括客户）自己扩展
```

---

_本文档基于 OpenClaw 真实源码（extensions/migrate-hermes/、extensions/acpx/）考证。_  
_结论：Nexus 应该从 Phase A 就实现 MCP Server，这是 AI 行业的正确方向。_  
_Hermes 与 OpenClaw 的 SKILL.md 格式兼容，MCP 协议兼容，可以替换使用。_
