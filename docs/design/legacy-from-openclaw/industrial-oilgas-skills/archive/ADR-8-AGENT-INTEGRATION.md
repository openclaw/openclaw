# ADR-8：Agent 集成架构权威定义

**版本**：1.0，2026-05-11  
**状态**：已决策  
**覆盖**：本文档回答以下问题：

1. "OpenHermes" 是什么？为什么之前说它适合央企？准确的说法是什么？
2. MSW 是什么？为什么前端需要它？
3. Agent Connector 是什么？有无双向连接？
4. OpenClaw / HiAgent / 其他 Agent 如何与 Nexus 对接？
5. 对接时需要在 Agent 侧做什么工作？需要改代码/装插件吗？

---

## 一、关于"OpenHermes"的澄清（重要修正）

### 1.1 之前说法的问题

在 NEXUS-FRAMEWORK-ARCHITECTURE.md §十一 中写到：

> "OpenHermes：完全自控；适合对数据安全有极高要求的军工/央企客户"

这个说法**不够准确**：

- **OpenHermes** 是 Nous Research 出品的一个**开源 LLM 模型**（基于 Mistral 微调），不是 Agent 框架
- 它是一个语言模型，不能直接做工具调用、多轮对话、工作流编排
- 用它来描述"适合央企的 Agent 框架"是错误的类比

### 1.2 正确的替代方案描述

```
适合央企/军工的正确选择（取决于安全等级要求）：

等级 1：飞书深度绑定 + 国产工作流
  → HiAgent（飞书出品，国产，OA 集成最强）
  → 适合：央国企已全面使用飞书的场景

等级 2：完全私有化部署 + 国产开源
  → Dify（开源，MIT 协议，100% 可私有化部署）
  → 适合：有 IT 团队、要求代码可审计、国产优先
  → Dify 已经被大量央企采用

等级 3：完全自研/军工级
  → 客户 IT 团队基于大模型 API（Qwen/通义）自己写 Agent
  → 或：Nexus 直接通过 GPU Server 驱动 AI（绕过 Agent，纯 API 模式）
  → 适合：等保四级、绝密级别、完全自主可控

等级 4：Nexus 直接驱动（无 Agent）
  → Nexus 直接调用 GPU Server（vLLM API）做推理
  → Sage "Skills" 变成 Platform 内的 Prompt 模板 + 直接调用模型
  → 适合：极简部署，不需要 Agent 编排能力的场景
```

### 1.3 央企为什么不优先选 OpenClaw？

```
OpenClaw 的顾虑（对某些央企客户而言）：
  · 境外开源产品（即使开源，采购部门可能需要国产化证明）
  · 升级更新依赖境外社区
  · 部分功能有云端依赖（需要确认是否完全离线）

更合适的央企组合：
  · AI 推理：Qwen（阿里/通义，国产，已通过安全审查）
  · Agent 框架：HiAgent（飞书/字节，国产）或 Dify（国产开源）
  · Nexus：自研，完全自主可控
  · 完全无境外软件依赖（如果需要）

修正后的 §十一 适用范围表：

客户类型           推荐 Agent       原因
──────────────────────────────────────────────────────────────────
标准工业客户        OpenClaw         生态最完整，Sage Skill 开箱即用
已用飞书的企业      HiAgent          OA 集成最深，审批流可视化
有 IT 团队的央企    Dify（私有化）   国产开源，完全审计，MIT 协议
安全级别极高        Nexus 直驱模式  绕过 Agent，Nexus 直接调 vLLM
军工/绝密场景       客户自研 Agent   完全自主可控
```

---

## 二、MSW 是什么？（前端开发工具）

### 2.1 定义

```
MSW = Mock Service Worker

MSW 是一个前端开发/测试工具，用于在浏览器中"拦截"HTTP 请求并返回模拟数据。

"Service Worker" 这里是浏览器 API（非我们架构里的 ServiceWorker for offline）。
它在浏览器和网络之间插入一个代理，让前端代码"以为"在调用真实后端。
```

### 2.2 工作原理

```
没有 MSW（等后端就绪才能开发）：
  Studio 代码 → fetch("GET /v1/equipment") → ⌛等后端 → 真实数据

有 MSW（前后端完全并行开发）：
  Studio 代码 → fetch("GET /v1/equipment") → MSW 拦截 → mock 数据（立即返回）
                                                          ↑
                                                  不发真实网络请求

MSW 的价值：
  · 前端开发不需要等后端就绪
  · 后端 API 改动时，修改 mock 即可，前端继续工作
  · 前端测试 100% 可控（不受后端状态影响）
  · 网络错误/超时/各种边界情况都可以模拟
```

### 2.3 在 Studio 中的使用方式

```typescript
// 开发模式：启用 MSW
// vite.config.ts: VITE_USE_MSW=true

// main.tsx 启动逻辑
if (import.meta.env.DEV && import.meta.env.VITE_USE_MSW === "true") {
  const { worker } = await import("./lib/mock/browser");
  await worker.start({ onUnhandledRequest: "warn" });
  // 之后所有 fetch 请求都会被 MSW 拦截
}

// 生产模式：不启用 MSW，请求打到真实后端
```

### 2.4 切换 Mock/真实后端

```bash
# 使用 MSW（前端独立开发）
VITE_USE_MSW=true pnpm dev

# 不使用 MSW（对接真实 Platform）
VITE_USE_MSW=false VITE_API_BASE=http://localhost:8000 pnpm dev

# 混合模式（部分 API 用 Mock，部分用真实）
# 在 handlers/index.ts 中注释掉不需要 mock 的 handler
```

---

## 三、Agent Connector 架构：双向连接详解

### 3.1 为什么需要"双向"连接？

```
Nexus 与 Agent 之间存在两个不同方向的交互：

方向 1（Agent → Nexus）：工具调用
  · 触发方：Agent（主动调用 Nexus 获取数据）
  · 时机：Agent 在处理 AI 任务时，需要查询设备数据/知识库
  · 协议：标准 HTTP REST（或 MCP）
  · 鉴权：Service Token（Agent 用的是机器身份）
  · 这个方向：ALL agents 用完全相同的方式！！

方向 2（Nexus → Agent）：任务分发
  · 触发方：Nexus（主动把 AI 任务送给 Agent 处理）
  · 时机：
      - Studio 用户点击"AI 诊断"
      - Pulse Engine 检测到异常，触发主动分析
      - Scheduler 定时任务触发 AI 报告
  · 协议：取决于具体 Agent（各自不同）
  · 这个方向：不同 Agent 有不同 API → 需要不同 Connector

方向 1 完全统一 → 不需要 Connector
方向 2 因 Agent 不同 → AgentConnector 抽象层解决
```

### 3.2 完整连接图

```
【方向 1：Agent → Nexus（统一，无需 Connector）】

OpenClaw Sage Skill 代码:         HiAgent 工作流节点:       Dify 工作流节点:
  await call_tool(                  HTTP工具调用:              HTTP工具调用:
    "GET /v1/tools/equipment/        GET /v1/tools/...          GET /v1/tools/...
     context?equipment_id=2",        X-Nexus-Service-Token: X-Nexus-Service-Token:
    headers={"X-Nexus-Service-        svc_...                   svc_...
             Token": "svc_..."})
              │                              │                        │
              ▼                              ▼                        ▼
         ┌────────────────────────────────────────────────────────────────┐
         │              Nexus Tool API（统一接入点）                        │
         │   GET /v1/tools/equipment/context                              │
         │   GET /v1/tools/kb/search                                      │
         │   POST /v1/tools/workorder/create                              │
         │   ...                                                          │
         └────────────────────────────────────────────────────────────────┘

【方向 2：Nexus → Agent（通过 AgentConnector）】

Nexus (ai_job_worker):
  connector = AgentConnectorFactory.create(settings)
       │
       ├── settings.agent_runtime == "openclaw"
       │   connector.dispatch(request) →  POST /openclaw/v1/agent/run
       │                                      └→ OpenClaw 执行 Sage Skill
       │
       ├── settings.agent_runtime == "hiagent"
       │   connector.dispatch(request) →  POST /hiagent/v1/workflows/{id}/run
       │                                      └→ HiAgent 执行配置的工作流
       │
       └── settings.agent_runtime == "dify"
           connector.dispatch(request) →  POST /dify/v1/workflows/run
                                              └→ Dify 执行配置的工作流

所有 Agent 完成任务后，调用 Nexus 回调：
  POST /v1/ai/jobs/{task_id}/result  ← 所有 Agent 都调用这个（统一！）
  Body: { "status": "done", "result": {...} }
```

---

## 四、各 Agent 的具体对接方式

### 4.1 OpenClaw 对接（最完整）

**我们需要做什么：**

```
第一步：创建 Sage Skills（OpenClaw 插件）
  · 在 OpenClaw 配置目录中安装 4 个 Skill：
    - industrial-twin（读设备状态）
    - industrial-kb（知识检索）
    - industrial-workorder（建工单）
    - industrial-analytics（趋势分析）
  · 每个 Skill 是一个 JSON 配置文件（不需要编程）：
    - system_prompt: Sage 提示词
    - tools: Nexus Tool API 的 function schema
    - tool_base_url: http://nexus-server:8000

第二步：配置 Nexus
  · AGENT_RUNTIME=openclaw
  · OPENCLAW_URL=http://openclaw-server:9001
  · OPENCLAW_API_KEY=sk-...

第三步：生成 Service Token
  · POST /v1/admin/service-tokens
    { "name": "OpenClaw Sage", "scopes": ["tool:call"] }
  · 把 token 填入 OpenClaw 的 Skill 配置中
```

**OpenClaw 侧需要做什么：**

```
安装 Sage Skills（核心工作，我们提供配置文件）：
  openclaw install ./sage/industrial-twin/
  openclaw install ./sage/industrial-kb/
  openclaw install ./sage/industrial-workorder/
  openclaw install ./sage/industrial-analytics/

配置 OpenClaw（openclaw.json）：
  {
    "agent": {
      "model": "qwen3-35b",            // 用 GPU Server 上的模型
      "model_provider": "openai",       // OpenAI 兼容 API
      "base_url": "http://gpu-server:8001/v1"
    }
  }

不需要：
  · 不需要修改 OpenClaw 源代码
  · 不需要安装额外 npm 包
  · 不需要配置 MCP（OpenClaw 本身就支持工具调用）

Skill 配置文件格式（我们提供，用户安装）：
  sage/industrial-twin/openclaw.plugin.json：
  {
    "id": "industrial-twin",
    "version": "1.0.0",
    "description": "ClawTwin 设备状态查询技能",
    "tools": [
      {
        "name": "get_equipment_context",
        "description": "获取设备当前状态、读数和AI分析",
        "url": "${NEXUS_TOOL_BASE_URL}/v1/tools/equipment/context",
        "method": "GET",
        "parameters": {
          "equipment_id": {"type": "integer", "description": "设备ID"}
        }
      }
    ],
    "system_prompt_template": "你是 ClawTwin 工业 AI 助手...(Sage 提示词)"
  }
```

**连接流程（完整）**：

```
用户在飞书说："帮我诊断 C-101 压缩机" →
  OpenClaw 收到消息 →
  匹配到 industrial-twin Skill →
  调用 get_equipment_context(equipment_id=1) →
    → GET http://nexus:8000/v1/tools/equipment/context?equipment_id=1
    → 带 Service Token：X-Nexus-Service-Token: svc_abc
    → Nexus 返回设备状态+历史+KB上下文
  OpenClaw 拿到数据，构建 Prompt，调用 Qwen →
  生成诊断报告 →
  回调 POST http://nexus:8000/v1/ai/jobs/{task_id}/result →
  Studio/飞书 显示结果
```

---

### 4.2 HiAgent 对接（飞书生态最佳）

**我们需要做什么：**

```
第一步：在 HiAgent 平台上创建工作流（可视化操作，无需编程）

工作流结构：
  [开始] → [获取设备上下文] → [调用 LLM 诊断] → [HITL 确认节点] → [创建工单] → [结束]

每个节点配置：

"获取设备上下文"节点（HTTP 工具节点）：
  URL: http://nexus:8000/v1/tools/equipment/context?equipment_id={{input.equipment_id}}
  Headers: { "X-Nexus-Service-Token": "svc_..." }
  输出变量：$equipment_context

"调用 LLM 诊断"节点（LLM 节点）：
  模型：Qwen3-35B（或 HiAgent 平台配置的模型）
  System Prompt: {Sage 的 industrial-twin 提示词}
  用户消息：请诊断以下设备数据：{{$equipment_context}}
  输出变量：$diagnosis

"HITL 确认节点"（审批节点，HiAgent 内置）：
  审批人：{{input.supervisor_feishu_id}}
  等待时间：24小时
  飞书卡片：显示 $diagnosis

"创建工单"节点（HTTP 工具节点）：
  URL: http://nexus:8000/v1/tools/workorder/create
  Method: POST
  Body: { "equipment_id": "{{input.equipment_id}}", "diagnosis": "{{$diagnosis}}" }

第二步：获取工作流 ID
  HiAgent 平台 → 发布工作流 → 复制 Workflow ID

第三步：配置 Nexus
  AGENT_RUNTIME=hiagent
  HIAGENT_URL=https://hiagent.company.com
  HIAGENT_WORKFLOW_ID=wf_abc123
  HIAGENT_API_KEY=ha_xxx
```

**HiAgent 侧需要做什么：**

```
· 在 HiAgent Web 界面创建并配置工作流（无需编程）
· 配置 HTTP 工具节点指向 Nexus Tool API
· 配置 LLM 节点使用公司部署的大模型
· 发布工作流，获取 Workflow ID

不需要：
  · 不需要安装任何 HiAgent 插件
  · 不需要修改 HiAgent 代码
  · 只需要在 Web 界面配置工作流
```

**适合 HiAgent 的场景：**

```
HiAgent 最大优势：飞书 OA 深度集成
  · 工作流节点可以直接发飞书审批卡
  · 审批通过/驳回直接在工作流中处理
  · 多级审批（主管→经理→总监）用 HiAgent 工作流最自然
  · 适合：已经在飞书 OA 中有复杂审批流的企业
```

---

### 4.3 Dify 对接（国产开源，推荐央企）

**关于 Dify：**

```
Dify（https://dify.ai）：
  · 国内开源 LLM 应用开发平台（MIT + 部分企业版）
  · 完全可以私有化部署（Enterprise 版本）
  · 国内大量央企/国企已在使用
  · 支持工作流编排、工具调用、RAG、多模型
  · 原生支持 HTTP 工具节点（直接调用 Nexus Tool API）
  · 飞书 Bot 集成（通过 Dify 官方 Feishu 渠道）

对比 HiAgent：
  · Dify：开源，更灵活，自主可控，有强大社区
  · HiAgent：商业产品，更深度绑定飞书生态
  · 央企通常倾向 Dify（可审计源代码，符合国产化要求）
```

**对接方式（与 HiAgent 类似，界面操作）：**

```
在 Dify 中创建工作流应用：
  1. 在工作流画布中添加 HTTP 请求节点
     URL: http://nexus:8000/v1/tools/equipment/context
     Headers: X-Nexus-Service-Token: svc_...
  2. 添加 LLM 节点（选择公司部署的 Qwen）
     System Prompt: {Sage 提示词}
  3. 发布应用，获取 API 端点

配置 Nexus：
  AGENT_RUNTIME=dify
  DIFY_URL=http://dify.company.com
  DIFY_APP_ID=app_xxx
  DIFY_API_KEY=dify_xxx
```

---

### 4.4 Nexus 直驱模式（无 Agent，极简/安全场景）

```
适用场景：
  · 军工/绝密场景（任何第三方软件都需要审批）
  · 极简部署（只有 Nexus + GPU Server，没有额外组件）
  · 快速 POC（跳过 Agent 配置，直接验证 AI 能力）

工作方式：
  Nexus 直接调用 vLLM API（OpenAI 兼容）
  Sage 提示词模板内置在 Nexus Platform 中（Prompt 模板表）
  没有 Agent 中间层

配置：
  AGENT_RUNTIME=none  # 或 "direct"
  NEXUS_GPU_SERVER_URL=http://192.168.10.50:8001

ai_job_worker 中的处理：
  if settings.agent_runtime == "none":
      # 直接调用 vLLM
      result = await direct_llm_call(
          system_prompt=load_sage_prompt(job.job_type),
          user_message=build_user_message(job),
          tools=build_tool_schema(),  # LLM 会调用这些工具
      )

铁律：
  直驱模式下，LLM 的工具调用仍然通过 Nexus Tool API（不绕过权限）
  不是"LLM 直接访问数据库"——而是"LLM 调用 Tool API，Tool API 查数据库"
```

---

## 五、"Nexus 需要做什么" vs "Agent 侧需要做什么"（清单）

### 5.1 Nexus 侧（我们开发，与 Agent 类型无关）

```
✅ 始终需要（所有 Agent 通用）：
  · /v1/tools/* 路由（Tool API）
  · Service Token 鉴权（验证 Agent 身份）
  · /v1/ai/jobs 路由（接收 Studio 触发的 AI 任务）
  · /v1/ai/jobs/{id}/result 回调路由（接收 Agent 结果）
  · AgentConnector 抽象层（platform/connectors/agent_connector.py）

✅ 我们提供给客户/Agent 的：
  · Sage Skill 配置文件（OpenClaw 安装用）或 Dify/HiAgent 工作流模板
  · Service Token（通过 /v1/admin/service-tokens 生成）
  · Tool API 的 OpenAPI JSON 文档（Agent 开发者参考）
  · 如果 Phase B：MCP Server 端点（/mcp）
```

### 5.2 Agent 侧（不同 Agent 要做的事）

```
OpenClaw 侧要做的事：
  1. 运行 openclaw install ./sage/... （安装 4 个 Skill，5 分钟）
  2. 配置模型（指向公司 GPU Server）
  3. 不需要改 OpenClaw 代码

HiAgent 侧要做的事：
  1. 在 HiAgent Web 界面创建工作流（1-2 天，无需编程）
  2. 配置 HTTP 工具节点指向 Nexus Tool API
  3. 发布工作流，记录 Workflow ID
  4. 不需要改 HiAgent 代码

Dify 侧要做的事：
  1. 在 Dify Web 界面创建工作流应用（1-2 天）
  2. 配置工具、LLM、飞书渠道
  3. 发布，记录 API Key 和 App ID
  4. 不需要改 Dify 代码

直驱模式：
  1. 只需要配置 Nexus .env（AGENT_RUNTIME=none）
  2. 确保 GPU Server 运行 vLLM
  3. 什么都不用安装
```

### 5.3 MCP 协议的使用时机（Phase B）

```
现在（Phase A）：不使用 MCP
  · 方向 1（Agent→Nexus）：直接 HTTP REST 调用
  · 方向 2（Nexus→Agent）：各 Agent 的私有 API

Phase B：Nexus 暴露 MCP Server 端点
  · 好处：任何 MCP Client（Claude Desktop, 自研 Agent）自动发现所有工具
  · 不需要手写 function schema
  · 只需告诉 Agent：MCP Server 地址 = http://nexus:8000/mcp
  · Agent 自动发现所有 Tool API

Phase A 不用 MCP 的原因：
  · MCP 还在快速演进，OpenClaw/HiAgent 的支持程度不统一
  · Phase A 手写 function schema 更可控
  · MCP 复杂度不值得 Phase A 投入
```

---

## 六、完整连接示意图（一图总结）

```
【Phase A 完整数据流】

用户（Studio 或 飞书）
  │
  ├─ Studio: POST /v1/ai/jobs
  │    { job_type: "diagnose", equipment_id: 2 }
  │    (User JWT)
  │
  ▼
Nexus Platform
  │  ai_job_worker 创建任务
  │  AgentConnector.dispatch(request) ──────────────────────────────┐
  │                                                                  │
  │                                                                  ▼
  │                                               ┌────────────────────────────┐
  │                                               │ Agent（任选其一）           │
  │                                               │                            │
  │                                               │ OpenClaw:                  │
  │                                               │   industrial-twin Skill 触发│
  │                                               │                            │
  │                                               │ HiAgent:                   │
  │                                               │   工作流节点执行            │
  │                                               │                            │
  │                                               │ Dify:                      │
  │                                               │   工作流应用执行            │
  │                                               └─────────┬──────────────────┘
  │                                                         │
  │                     Agent 需要设备数据时：               │
  │ ◄─── GET /v1/tools/equipment/context?equipment_id=2 ────┘
  │      X-Nexus-Service-Token: svc_xxx                     │
  │ ────► 返回设备上下文（读数+健康+历史+KB）                 │
  │                                                         │
  │                     Agent 推理完成后：                   │
  │ ◄─── POST /v1/ai/jobs/{task_id}/result ─────────────────┘
  │      { status: "done", result: { diagnosis: "..." } }
  │
  │  Studio 轮询：GET /v1/ai/jobs/{task_id}
  │  或 SSE：event: ai_job_done 推送给 Studio
  │
  ▼
Studio 展示 AI 诊断结果 + Citations
```

---

## 七、对接工作量估算

```
方案               Nexus 开发工作    Agent 侧配置工作   总工作量
─────────────────────────────────────────────────────────────────
OpenClaw            0.5 周           1 天（安装 Skill） ≈ 3 天
HiAgent             0.5 周           2-3 天（建工作流）  ≈ 5 天
Dify                0.5 周           2-3 天（建工作流）  ≈ 5 天
直驱模式（无 Agent） 1 天             0                  ≈ 1 天

说明：
  · "Nexus 开发工作 0.5 周" = 实现 AgentConnector + 测试
  · Sage Skill 配置文件我们提供，用户只需安装（无需编程）
  · HiAgent/Dify 工作流是"点击配置"，不是编程，工程师可以做
```

---

_本文档创建于 2026-05-11，是 Agent 集成架构的权威定义。_  
_本文档同时修正了 NEXUS-FRAMEWORK-ARCHITECTURE.md §十一 中"OpenHermes"的不准确说法。_  
_正确的国产/自控方案参考：Dify（开源私有化）/ HiAgent（国产商业）/ 直驱模式（极简）。_
