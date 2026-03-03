# OpenClaw 原生机制全景分析

> 基于 openFinclaw 源码深度探索
> 更新：2026-03-03

---

## 一、30 秒概览

OpenClaw = **一个 Agent 编排平台**，核心做三件事：

```
用户消息 → 构建 System Prompt（含 Skills + Tools 描述）→ LLM ReAct 循环 → 输出
                                                          ↑        ↓
                                                     工具结果 ← 工具执行
```

**不是 MCP 驱动、不是 RAG 驱动**，而是 **Plugin 注册制 + Skill 提示注入 + 原生 Tool Calling**。

---

## 二、核心架构 5 层

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 5: CLI / 入口                                          │
│   openfinclaw.mjs → entry.ts → runCli(argv)                │
├──────────────────────────────────────────────────────────────┤
│ Layer 4: Agent Engine (ReAct 循环)                           │
│   pi-agent-core SDK 驱动，OpenClaw 增强                      │
│   runEmbeddedPiAgent → runEmbeddedAttempt → agent.run()     │
├──────────────────────────────────────────────────────────────┤
│ Layer 3: System Prompt 构建                                  │
│   Skills 提示 + 工具描述 + 运行时信息 + 用户上下文           │
├──────────────────────────────────────────────────────────────┤
│ Layer 2: Plugin 系统                                         │
│   发现 → 加载 → 注册 Tools/Services/Hooks/Skills            │
├──────────────────────────────────────────────────────────────┤
│ Layer 1: Config (openclaw.json)                              │
│   agents, models, plugins, hooks, skills 配置               │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、Plugin 系统（核心驱动力）

### 3.1 Extension 目录结构

每个 Extension 是一个文件夹：

```
extensions/findoo-datahub-plugin/
├── openclaw.plugin.json    ← 清单（ID、描述、configSchema、skills 路径）
├── index.ts                ← 注册函数（registerTool / registerService / registerHook）
├── src/                    ← 实现代码
└── skills/                 ← SKILL.md 文档（给 LLM 读的）
    ├── equity/skill.md
    ├── crypto-defi/skill.md
    ├── macro/skill.md
    └── ...
```

### 3.2 Plugin 生命周期

```
Discovery（发现）
  ├─ bundled:   extensions/          （项目自带）
  ├─ global:    ~/.openfinclaw/plugins/
  ├─ workspace: {workspace}/.openfinclaw/plugins/
  └─ config:    openclaw.json → plugins.load.paths
       ↓
Manifest Loading（读清单）
  └─ 解析 openclaw.plugin.json → id, configSchema, skills, channels
       ↓
Enable Check（启用检查）
  └─ allow/deny list → per-plugin entries → bundled defaults
       ↓
Plugin Loading（代码加载）
  └─ import(index.ts) → 调用 register(api)
       ↓
Registration（注册）
  ├─ api.registerTool()      → 注册可调用工具
  ├─ api.registerService()   → 注册共享服务（其他插件可消费）
  ├─ api.registerHook()      → 注册生命周期钩子
  ├─ api.registerCli()       → 注册 CLI 子命令
  └─ api.registerHttpRoute() → 注册 HTTP 端点
```

### 3.3 Plugin 注册 API（关键接口）

```typescript
register(api: OpenClawPluginApi) {
  // 注册工具（Agent 可调用）
  api.registerTool({
    name: "fin_stock",
    description: "Fetch equity data...",
    parameters: Type.Object({ symbol: Type.String() }),
    async execute(_id, params) { return result; }
  });

  // 注册服务（其他 Plugin 可消费）
  api.registerService({
    id: "fin-data-provider",
    instance: dataProviderInstance
  });

  // 注册钩子（拦截生命周期）
  api.registerHook("before_tool_call", async (ctx) => {
    if (ctx.toolName === "fin_place_order") {
      // 风控拦截
    }
  });
}
```

### 3.4 关键认知：Tools ≠ Skills

| | Tools | Skills |
|---|---|---|
| **本质** | 可执行函数 | Markdown 文档 |
| **注册方式** | `api.registerTool()` | 清单 `skills` 字段 → SKILL.md |
| **谁用** | Agent 调用（tool_use） | 注入 System Prompt，LLM 阅读 |
| **作用** | 执行动作（查数据、下单） | 告诉 LLM 什么场景用什么工具 |
| **加载** | Plugin 系统 | Agent Skill 系统 |

**这是 OpenClaw 最精妙的设计**：Skill.md 是给 LLM 的"说明书"，告诉它"什么时候用什么工具、怎么用"。LLM 自己决定调不调。

---

## 四、Agent Engine（ReAct 循环）

### 4.1 核心引擎

基于 `@mariozechner/pi-agent-core` SDK，OpenClaw 在上面构建增强层。

```
runEmbeddedPiAgent(params)
  │
  ├─ 1. 初始化
  │    ├─ 解析模型/提供商（anthropic, openai, ollama...）
  │    ├─ 建立认证配置文件轮转
  │    └─ 初始化全局 Hook Runner
  │
  ├─ 2. 主循环（最多 160 次重试）
  │    ├─ runEmbeddedAttempt()
  │    │    ├─ createAgentSession()          ← 创建 pi-agent 会话
  │    │    ├─ buildEmbeddedSystemPrompt()   ← 构建系统提示
  │    │    ├─ createOpenClawCodingTools()   ← 组装工具集
  │    │    ├─ subscribeEmbeddedPiSession()  ← 订阅流事件
  │    │    └─ agent.run()                   ← ReAct 循环开始
  │    │         │
  │    │         ├─ LLM 调用 → 返回 text + tool_use
  │    │         ├─ 工具执行（权限检查 → 执行 → 结果清理）
  │    │         ├─ 结果作为 tool_result 喂回 LLM
  │    │         └─ 重复直到 LLM 不再调用工具
  │    │
  │    ├─ 错误处理
  │    │    ├─ 认证失败 → 轮转下一个 API Key
  │    │    ├─ 上下文溢出 → 自动压缩历史
  │    │    ├─ 速率限制 → 冷却等待
  │    │    └─ 超时 → 重试
  │    │
  │    └─ 返回结果
  │
  └─ 3. 返回 EmbeddedPiRunResult { text, usage, meta }
```

### 4.2 System Prompt 构建

```
System Prompt = 基础指令
              + 运行时信息（OS, 模型, agentId）
              + 工具描述（所有已注册 Tool 的 name + description）
              + Skills 提示（所有已加载 Skill 的 SKILL.md 内容）
              + 工作空间备注
              + 沙箱信息
              + 用户自定义上下文
```

**关键点**：Skills 是被"塞进" System Prompt 的。LLM 看到完整的 Skill 文档后，自己判断什么时候使用对应的 Tool。

### 4.3 工具权限策略

多层过滤管道：

```
工具集
  │
  ├─ 子代理深度限制（深度 >= max → 禁用 spawn 等）
  ├─ 提供商策略（per-model allow/deny）
  ├─ 沙箱策略（workspace_only 限制）
  ├─ 所有者限制（owner-only 工具）
  └─ 消息提供商约束（voice 禁用 tts 等）
  │
  ▼
最终可用工具集 → 注入 Agent Session
```

---

## 五、Hooks 系统（23 个生命周期钩子）

### 5.1 钩子分类

| 类别 | 钩子名 | 作用 |
|------|--------|------|
| **Agent** | `before_model_resolve` | 覆盖模型/提供商选择 |
| | `before_prompt_build` | 修改系统提示 |
| | `before_agent_start` | 复合钩子（模型+提示） |
| | `llm_input` / `llm_output` | 记录 LLM 输入输出 |
| | `agent_end` | 会话结束分析 |
| **Tool** | `before_tool_call` | **拦截/修改**工具调用（可 block） |
| | `after_tool_call` | 工具执行后处理 |
| | `tool_result_persist` | 修改工具结果持久化 |
| **Message** | `message_received` | 收到消息处理 |
| | `message_sending` | 发送前（可取消） |
| | `message_sent` | 发送后通知 |
| **Session** | `session_start/end` | 会话生命周期 |
| | `before_compaction` | 上下文压缩前 |
| | `before_reset` | /new 或 /reset 前 |
| **Subagent** | `subagent_spawning/spawned/ended` | 子代理生命周期 |

### 5.2 风控钩子示例

```typescript
// fin-core 通过 before_tool_call 实现交易风控
api.registerHook("before_tool_call", async (ctx) => {
  if (ctx.toolName === "fin_place_order") {
    const risk = riskController.evaluate(ctx.params);
    if (risk.blocked) {
      return { block: true, blockReason: risk.reason };
    }
  }
});
```

---

## 六、Skill 加载与分发

### 6.1 Skill 来源（6 种）

```
优先级（低 → 高）：

openclaw-extra       ← config.skills.load.extraDirs + plugin skills
openclaw-bundled     ← <packageRoot>/skills/
openclaw-managed     ← ~/.config/openclaw/skills/
agents-skills-personal ← ~/.agents/skills/
agents-skills-project  ← {workspace}/.agents/skills/
openclaw-workspace   ← {workspace}/skills/
```

### 6.2 Skill 加载流程

```
loadWorkspaceSkillEntries(workspaceDir)
  │
  ├─ 扫描各 source 目录
  │    └─ 每个子目录查找 SKILL.md
  │
  ├─ 解析 SKILL.md（YAML frontmatter + Markdown body）
  │    └─ name, description, metadata.openclaw.requires
  │
  ├─ 去重合并（高优先级覆盖低优先级）
  │
  ├─ 大小检查（maxSkillFileBytes 限制）
  │
  └─ 注入到 System Prompt
```

### 6.3 Commons 分发机制

```
commons/index.json    ← 注册表（"应用商店目录"）
commons/skills/<id>/  ← 源文件
     │
     │  openfinclaw commons list  → 浏览可用 Skills
     │  openfinclaw commons install <id>  → 安装
     ▼
skills/<id>/          ← bundled skill（本地可用）
     │
     │  workspace.ts loadSkills()
     ▼
skills list           ← 显示已安装 Skills
```

---

## 七、金融插件生态

### 7.1 分层架构

```
┌─────────────────────────────────────────┐
│ Layer 4: 应用层                          │
│   fin-evolution-engine (策略进化)        │
│   fin-fund-manager (基金管理)            │
│   fin-monitoring (监控)                  │
│   fin-paper-trading (模拟交易)           │
├─────────────────────────────────────────┤
│ Layer 3: 策略层                          │
│   fin-strategy-engine (回测/优化)        │
│   fin-strategy-memory (策略记忆)         │
├─────────────────────────────────────────┤
│ Layer 2: 交易/分析层                     │
│   fin-trading (CCXT 交易执行)            │
│   fin-portfolio (持仓分析)               │
│   fin-info-feed (新闻)                   │
├─────────────────────────────────────────┤
│ Layer 1: 数据层                          │
│   findoo-datahub-plugin (172 端点)       │
│   fin-market-data (行情)                 │
├─────────────────────────────────────────┤
│ Layer 0: 基础设施                        │
│   fin-core (交易所注册, 风控, 事件存储)  │
│   fin-shared-types (纯类型)              │
│   fin-expert-sdk (SDK)                   │
└─────────────────────────────────────────┘
```

### 7.2 插件间通信：Service 模式

插件不直接 import，而是通过 **Service 注册/消费**：

```typescript
// fin-core 注册服务
api.registerService({ id: "fin-risk-controller", instance: riskCtrl });

// fin-trading 消费服务
const rc = api.runtime.getService("fin-risk-controller");
rc.instance.evaluate(tradeParams);
```

### 7.3 findoo-datahub-plugin（数据中枢）

提供 10 个 AI 工具 + 6 个 Skill 文档：

| 工具 | 作用 |
|------|------|
| `fin_stock` | A/HK/US 股票数据 |
| `fin_index` | 指数/ETF 数据 |
| `fin_macro` | 宏观经济数据 |
| `fin_derivatives` | 期货/期权数据 |
| `fin_crypto` | 加密/DeFi 数据 |
| `fin_market` | 龙虎榜/涨停/北向资金 |
| `fin_query` | 通用 172 端点查询 |
| `fin_data_ohlcv` | K 线数据 |
| `fin_data_regime` | 市场状态识别 |
| `fin_data_markets` | 市场总览 |

每个工具对应一个 Skill.md，告诉 LLM 什么场景用什么工具。

---

## 八、配置系统

### 8.1 openclaw.json 核心结构

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-sonnet" },
      "tools": { "exec": { "security": "ask" } }
    },
    "list": [
      { "id": "agent-1", "skills": ["skill-1"], "workspace": "~/ws" }
    ]
  },
  "models": {
    "providers": {
      "anthropic": { "apiKey": "$ANTHROPIC_API_KEY" },
      "openai": { "apiKey": "$OPENAI_API_KEY" }
    }
  },
  "plugins": {
    "enabled": true,
    "allow": ["plugin-id"],
    "deny": [],
    "entries": {
      "fin-core": { "enabled": true, "config": {} }
    }
  },
  "skills": {
    "load": { "extraDirs": ["/path/to/extra/skills"] }
  },
  "hooks": {
    "internal": {
      "handlers": [{ "event": "command:new", "module": "./hooks/on-new.js" }]
    }
  }
}
```

### 8.2 Plugin 启用逻辑

```
plugins.enabled = false  →  全部禁用
pluginId in deny list    →  禁用
allow list 非空但不含 id →  禁用
entries[id].enabled      →  显式开/关
bundled + 在默认列表     →  启用
bundled + 不在默认列表   →  禁用
其他                     →  启用
```

默认启用的 bundled 插件：`findoo-datahub-plugin`, `fin-market-data`, `fin-portfolio`, `fin-monitoring`, `fin-strategy-memory`, `fin-expert-sdk`, `fin-info-feed` 等。

---

## 九、与 backtest-agent 的关系

```
┌────────────────────────────────────────────────────────────┐
│                     openFinclaw                            │
│                                                            │
│  用户对话: "帮我创建一个 DCA 策略"                          │
│       ↓                                                    │
│  LLM 匹配 Skill: fin-strategy-builder                     │
│       ↓                                                    │
│  LLM 调用 Tools: fin_data_ohlcv → fin_backtest_run         │
│       ↓                                                    │
│  生成 FEP Skill 包（fep.yaml + scripts/）                  │
│       ↓                                                    │
│  用户: "帮我回测这个策略"                                   │
│       ↓                                                    │
│  LLM 匹配 Skill: fin-backtest                             │
│       ↓                                                    │
│  ┌──────────────────────────────────────────────────┐     │
│  │              backtest-agent                       │     │
│  │                                                   │     │
│  │  Lead Agent 准入审查                              │     │
│  │       ↓                                           │     │
│  │  智能路由：L1 Script / L2 Agent                   │     │
│  │       ↓                                           │     │
│  │  L1: ScriptEngine (确定性，$0)                    │     │
│  │  L2: AgentEngine (SDK ReAct，$2-15)              │     │
│  │       ↓                                           │     │
│  │  输出: equity curve, trades, performance report  │     │
│  └──────────────────────────────────────────────────┘     │
│       ↓                                                    │
│  LLM 解读回测结果，回复用户                                │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 十、关键设计模式总结

| 模式 | OpenClaw 做法 | 意义 |
|------|--------------|------|
| **LLM 自主性** | Skill 注入提示 + Tool 可调用 → LLM 自己决策 | 不是硬编码 if-else 路由 |
| **Plugin 注册制** | registerTool / registerService / registerHook | 松耦合、可扩展 |
| **Service 通信** | 插件间通过 Service 消费，不直接 import | 解耦依赖 |
| **Skill ≠ Tool** | Skill 是文档（给 LLM 读），Tool 是函数（给 LLM 调） | 分离"知识"和"能力" |
| **多层风控** | Hook before_tool_call + 工具策略 + 沙箱 | 纵深防御 |
| **故障转移** | 多 API Key 轮转 + 自动降级 + 压缩 | 高可用 |
| **Commons 分发** | 注册表 + install + bundled | 生态系统 |
