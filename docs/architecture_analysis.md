# OpenClaw 项目架构分析报告

> **版本**: 2026.3.9 | **分析日期**: 2026-03-11 | **仓库**: [openclaw/openclaw](https://github.com/openclaw/openclaw)

---

## 第一部分：项目总体架构

### 1. 项目定位

**OpenClaw** 是一个多通道 AI 网关（Multi-Channel AI Gateway），核心解决以下问题：

- 将 AI 模型能力统一接入多种消息通道（WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Line、Teams 等 40+ 平台）
- 提供本地运行的 AI 助手，支持真实的计算机操作（代码执行、文件管理、浏览器控制等）
- 安全、隐私优先的自托管方案

**核心功能：**

| 功能域 | 说明 |
|--------|------|
| 多通道消息路由 | 统一路由消息到 AI agent，支持 40+ 通道 |
| AI Agent 运行时 | Pi 嵌入式 agent、子 agent 编排、工具调用 |
| 网关服务器 | WebSocket + HTTP API 服务，支持认证、会话管理 |
| 插件系统 | npm 分发的扩展架构，支持第三方通道和工具 |
| CLI 工具 | 完整的命令行管理界面 |
| 原生应用 | macOS/iOS/Android 原生客户端 |
| Web 前端 | Lit + Vite 控制面板 |

### 2. 技术栈分析

| 维度 | 技术 |
|------|------|
| **编程语言** | TypeScript (ESM)、Swift (macOS/iOS)、Kotlin (Android) |
| **运行时** | Node.js 22+（Bun 亦可运行） |
| **框架** | Express 5 (HTTP)、Commander (CLI)、grammy (Telegram)、@slack/bolt (Slack)、@buape/carbon (Discord)、Baileys (WhatsApp)、Lit (Web UI) |
| **构建工具** | tsdown (bundler)、Vite (UI)、pnpm (包管理)、Xcode (iOS/macOS)、Gradle (Android) |
| **状态管理** | JSON 文件存储 (`~/.openclaw/`)、SQLite (sqlite-vec 向量存储)、LanceDB (memory 插件) |
| **网络通信** | WebSocket (ws)、HTTP/Express、mDNS (Bonjour发现)、Tailscale |
| **测试** | Vitest + V8 coverage (70% 阈值)、Playwright (浏览器E2E) |
| **代码质量** | Oxlint (lint)、Oxfmt (format)、Zod (schema验证)、TypeBox (JSON Schema) |
| **依赖管理** | pnpm workspace (monorepo)、npm 分发插件 |

### 3. 目录结构解析

```
openClaw/
├── src/                    # 核心源码 (~1600+ 文件)
│   ├── entry.ts            # CLI 入口，进程 respawn 和 fast-path 处理
│   ├── index.ts            # 程序化入口，导出公共 API
│   ├── agents/             # AI Agent 运行时 (535 文件)
│   │   ├── pi-embedded-*   # Pi 嵌入式 agent 运行器
│   │   ├── model-*         # 模型选择/认证/降级/扫描
│   │   ├── bash-tools.*    # 命令执行工具 (PTY + sandbox)
│   │   ├── subagent-*      # 子 agent 编排与生命周期
│   │   ├── skills*         # 技能安装/加载/管理
│   │   └── sandbox*        # Docker sandbox 隔离执行
│   ├── gateway/            # 网关服务器 (237 文件)
│   │   ├── server.impl.ts  # 核心服务器实现 (38KB)
│   │   ├── server-http.ts  # HTTP API 层
│   │   ├── openai-http.ts  # OpenAI 兼容 API
│   │   ├── auth.ts         # 认证系统
│   │   ├── session-utils.* # 会话管理
│   │   ├── hooks*.ts       # 钩子系统
│   │   └── server-cron.ts  # 定时任务
│   ├── cli/                # CLI 命令注册 (157 文件)
│   │   ├── program.ts      # Commander 程序构建器
│   │   ├── run-main.ts     # CLI 启动入口
│   │   ├── *-cli.ts        # 各子命令 (gateway, config, plugins, etc.)
│   │   └── deps.ts         # 依赖注入工厂
│   ├── config/             # 配置系统 (205 文件)
│   │   ├── io.ts           # 配置读写 (50KB，最大文件之一)
│   │   ├── schema.ts       # 配置 schema 定义
│   │   ├── defaults.ts     # 默认配置
│   │   ├── validation.ts   # 配置校验
│   │   ├── legacy*         # 遗留配置迁移
│   │   └── zod-schema.*    # Zod 验证 schema
│   ├── infra/              # 基础设施 (303 文件)
│   │   ├── heartbeat-*     # 心跳系统
│   │   ├── exec-*          # 命令执行与审批系统
│   │   ├── update-*        # 自动更新
│   │   ├── fs-safe.ts      # 安全文件操作
│   │   ├── ports.*         # 端口管理
│   │   └── tailscale.ts    # Tailscale 集成
│   ├── commands/           # 业务命令实现 (288 文件)
│   │   ├── agent.ts        # agent 命令 (40KB)
│   │   ├── doctor*.ts      # 诊断命令集
│   │   ├── onboard*.ts     # 引导配置
│   │   ├── configure.*     # 配置向导
│   │   └── status.*        # 状态查询
│   ├── channels/           # 通道统一抽象 (59 文件)
│   │   ├── dock.ts         # 通道消息分发中心 (21KB)
│   │   ├── registry.ts     # 通道注册表
│   │   ├── allowlists/     # 白名单管理
│   │   └── transport/      # 消息传输层
│   ├── plugins/            # 插件系统 (66 文件)
│   │   ├── loader.ts       # 插件加载器 (26KB)
│   │   ├── discovery.ts    # 插件发现 (20KB)
│   │   ├── registry.ts     # 插件注册表 (18KB)
│   │   ├── hooks.ts        # 插件钩子 (23KB)
│   │   └── install.ts      # 插件安装 (18KB)
│   ├── routing/            # 消息路由 (11 文件)
│   │   ├── resolve-route.ts # 路由解析 (24KB)
│   │   └── session-key.ts   # 会话键派生
│   ├── plugin-sdk/         # 插件 SDK 导出
│   ├── telegram/           # Telegram 通道实现
│   ├── discord/            # Discord 通道实现
│   ├── slack/              # Slack 通道实现
│   ├── signal/             # Signal 通道实现
│   ├── imessage/           # iMessage 通道实现
│   ├── web/                # WhatsApp Web 通道
│   ├── line/               # Line 通道实现
│   ├── whatsapp/           # WhatsApp 通道共享逻辑
│   ├── media/              # 媒体处理管道
│   ├── media-understanding/ # 媒体内容理解
│   ├── memory/             # 记忆系统
│   ├── hooks/              # 全局钩子定义
│   ├── secrets/            # 密钥管理
│   ├── security/           # 安全策略
│   ├── tts/                # 文本转语音
│   ├── tui/                # TUI 终端界面
│   ├── browser/            # 浏览器控制
│   ├── shared/             # 跨模块共享代码
│   └── utils.ts            # 通用工具函数
├── extensions/             # 插件扩展 (40 个)
│   ├── acpx/               # ACP 扩展
│   ├── bluebubbles/        # BlueBubbles iMessage
│   ├── copilot-proxy/      # Copilot 代理
│   ├── device-pair/        # 设备配对
│   ├── discord/            # Discord 扩展增强
│   ├── feishu/             # 飞书
│   ├── googlechat/         # Google Chat
│   ├── irc/                # IRC
│   ├── llm-task/           # LLM 任务
│   ├── lobster/            # Lobster TUI
│   ├── matrix/             # Matrix
│   ├── mattermost/         # Mattermost
│   ├── memory-core/        # 核心记忆插件
│   ├── memory-lancedb/     # LanceDB 记忆插件
│   ├── msteams/            # Microsoft Teams
│   ├── nostr/              # Nostr
│   ├── talk-voice/         # 语音通话
│   ├── voice-call/         # 语音呼叫
│   ├── zalo/               # Zalo (OA)
│   └── ...                 # 更多扩展
├── apps/                   # 原生客户端应用
│   ├── macos/              # macOS Swift 应用 (菜单栏网关)
│   ├── ios/                # iOS Swift 应用
│   ├── android/            # Android Kotlin 应用
│   └── shared/             # 跨平台共享代码 (OpenClawKit)
├── ui/                     # Web 控制面板
│   ├── src/                # Lit Web Components
│   ├── vite.config.ts      # Vite 构建配置
│   └── package.json        # 独立包
├── scripts/                # 构建/测试/发布脚本 (100+)
├── docs/                   # Mintlify 文档站
├── skills/                 # 内置技能
├── packages/               # 工作空间包
├── patches/                # pnpm 依赖补丁
├── vendor/                 # Vendor 依赖
├── test/                   # 全局测试配置
├── test-fixtures/          # 测试固件
└── vitest.*.config.ts      # 多套 Vitest 配置
```

### 4. 系统架构设计

OpenClaw 采用 **分层模块化架构** + **插件扩展模式**：

```
┌─────────────────────────────────────────────────────┐
│                     用户层                           │
│  CLI (Commander)  │  Web UI (Lit)  │  Native Apps   │
├─────────────────────────────────────────────────────┤
│                   网关层 (Gateway)                    │
│  HTTP/WS Server  │  Auth  │  Sessions  │  Hooks     │
├─────────────────────────────────────────────────────┤
│                   Agent 层                           │
│  Pi Embedded Runner  │  Model Selection  │  Tools   │
│  Subagent Registry   │  Sandbox (Docker) │  Skills  │
├─────────────────────────────────────────────────────┤
│                   通道层 (Channels)                   │
│  Dock (消息分发)  │  Registry  │  Transport         │
├─────────────────────────────────────────────────────┤
│              插件层 (Plugin System)                   │
│  Loader  │  Discovery  │  Hooks  │  SDK             │
├─────────────────────────────────────────────────────┤
│              基础设施层 (Infra)                       │
│  Config  │  Routing  │  Secrets  │  Security        │
│  FS-Safe │  Ports    │  Update   │  Heartbeat       │
└─────────────────────────────────────────────────────┘
```

**架构模式识别：**

- **分层架构 (Layered Architecture)**: 用户层 → 网关层 → Agent 层 → 通道层 → 基础设施层
- **插件架构 (Plugin Architecture)**: 核心精简，通道/工具/记忆通过插件扩展
- **依赖注入 (DI)**: CLI 通过 `createDefaultDeps()` 工厂注入运行时依赖
- **事件驱动**: 钩子系统实现 before/after 生命周期事件
- **Monorepo**: pnpm workspace 管理核心 + 扩展 + UI + 应用

---

## 第二部分：项目运行流程

### 1. 入口文件

| 入口 | 文件 | 用途 |
|------|------|------|
| CLI 入口 | `openclaw.mjs` → `src/entry.ts` | 用户通过 `openclaw` 命令调用 |
| 程序化入口 | `src/index.ts` | 作为 npm 包导入使用 |
| Web UI 入口 | `ui/index.html` | Vite 开发 / 生产构建 |

### 2. 启动流程 (CLI)

```
1. openclaw.mjs
   └→ src/entry.ts
      ├→ 设置 process.title = "openclaw"
      ├→ 安装进程标记 (ensureOpenClawExecMarkerOnProcess)
      ├→ 安装警告过滤器 (installProcessWarningFilter)
      ├→ 环境变量规范化 (normalizeEnv)
      ├→ 启用编译缓存 (enableCompileCache)
      ├→ Windows argv 规范化
      ├→ CLI 配置文件解析 (parseCliProfileArgs)
      ├→ 快速路径: --version / --help
      └→ src/cli/run-main.ts → runCli()
         ├→ 加载 .env (loadDotEnv)
         ├→ 运行时版本检查 (assertSupportedRuntime)
         ├→ 路由快捷命令 (tryRouteCli)
         ├→ 启用日志捕获 (enableConsoleCapture)
         ├→ 构建 Commander 程序 (buildProgram)
         ├→ 注册核心子命令 (registerCoreCliByName)
         ├→ 注册子 CLI (registerSubCliByName)
         ├→ 注册插件 CLI (registerPluginCliCommands)
         └→ program.parseAsync(argv)
```

### 3. 网关启动流程

```
openclaw gateway run
  └→ src/gateway/server.impl.ts
     ├→ 加载配置 → 验证 Schema
     ├→ 检查端口可用性
     ├→ 获取网关锁 (文件锁防重复启动)
     ├→ 初始化 HTTP/WS 服务器
     ├→ 注册认证中间件
     ├→ 加载并注册通道 (Telegram, Discord, Slack, ...)
     ├→ 加载并注册插件
     ├→ 初始化 Agent 运行时
     ├→ 启动定时任务 (Cron)
     ├→ 启动 Bonjour 服务发现
     └→ 监听端口，等待连接
```

### 4. 消息处理数据流

```
用户消息 (WhatsApp/Telegram/Discord/...)
  → 通道适配器 (src/telegram/, src/discord/, ...)
    → 通道抽象 (src/channels/dock.ts) 统一消息格式
      → 路由解析 (src/routing/resolve-route.ts)
        → 确定 Agent ID 和 Session Key
          → Agent 运行时 (src/agents/pi-embedded-runner/)
            → 模型选择 (model-selection.ts → model-fallback.ts)
              → LLM API 调用 (OpenAI/Anthropic/Google/Ollama/...)
                → 流式响应处理 (pi-embedded-subscribe.ts)
                  → 工具调用 → 执行审批 → 结果返回
            ← 生成回复
          ← 通道传输 (channels/transport/)
        ← 发送到原始通道
```

---

## 第三部分：核心模块分析

### 1. 网关服务器 (`src/gateway/`)

| 维度 | 说明 |
|------|------|
| **职责** | WebSocket + HTTP API 服务、认证、会话管理、通道健康监控 |
| **关键文件** | `server.impl.ts` (38KB)、`server-http.ts` (28KB)、`auth.ts` (16KB)、`session-utils.ts` (28KB) |
| **输入** | WebSocket 连接、HTTP 请求、通道消息 |
| **输出** | Agent 响应、状态事件、API 响应 |
| **依赖** | Express 5、ws、agents、plugins、config、channels |

### 2. Agent 运行时 (`src/agents/`)

| 维度 | 说明 |
|------|------|
| **职责** | AI agent 生命周期管理、模型调用、工具执行、子 agent 编排 |
| **关键文件** | `pi-embedded-runner/` (agent 运行器)、`model-fallback.ts` (26KB 模型降级)、`system-prompt.ts` (33KB)、`subagent-registry.ts` (43KB)、`subagent-announce.ts` (52KB) |
| **子模块** | 模型发现/认证/降级、Bash 工具执行(PTY)、沙箱(Docker)、技能管理、会话持久化 |
| **依赖** | @mariozechner/pi-* (Pi SDK)、config、infra、plugins |

### 3. 配置系统 (`src/config/`)

| 维度 | 说明 |
|------|------|
| **职责** | 配置加载/验证/写入/迁移，支持 YAML/JSON 配置 + 环境变量 + 包含文件 |
| **关键文件** | `io.ts` (50KB 配置 I/O)、`schema.help.ts` (158KB schema 帮助文本)、`schema.labels.ts` (50KB)、`zod-schema.ts` (30KB)、`defaults.ts` (15KB) |
| **特点** | 双 schema 系统 (Zod + TypeBox)，支持配置快照、环境变量替换、遗留配置迁移 |

### 4. 插件系统 (`src/plugins/`)

| 维度 | 说明 |
|------|------|
| **职责** | 插件发现、加载、安装/卸载、钩子注册、HTTP 路由注册 |
| **关键文件** | `loader.ts` (26KB)、`hooks.ts` (23KB)、`discovery.ts` (20KB)、`registry.ts` (18KB) |
| **SDK** | `src/plugin-sdk/` 导出 40+ 通道/工具类型定义 |
| **扩展点** | beforeAgentStart、afterToolCall、modelOverride 等钩子 |

### 5. 通道系统 (`src/channels/` + `src/telegram/` + ...)

| 维度 | 说明 |
|------|------|
| **职责** | 消息接收/发送/格式转换、白名单管理、消息去抖、打字状态模拟 |
| **关键文件** | `dock.ts` (21KB 消息分发中心)、`status-reactions.ts` (11KB)、各通道目录 |
| **核心通道** | Telegram (grammy)、Discord (@buape/carbon)、Slack (@slack/bolt)、Signal、iMessage、WhatsApp (Baileys)、Line、Web |

### 6. 基础设施 (`src/infra/`)

| 维度 | 说明 |
|------|------|
| **职责** | 文件安全操作、端口管理、自动更新、心跳系统、执行审批、网络发现 |
| **关键文件** | `heartbeat-runner.ts` (41KB)、`state-migrations.ts` (32KB)、`session-cost-usage.ts` (32KB)、`boundary-path.ts` (25KB)、`update-runner.ts` (27KB)、`fs-safe.ts` (21KB) |
| **安全** | 命令执行审批系统、路径安全校验、TLS 证书管理 |

### 7. 命令系统 (`src/commands/`)

| 维度 | 说明 |
|------|------|
| **职责** | 业务逻辑命令实现：agent、doctor、onboard、configure、status 等 |
| **关键文件** | `doctor-config-flow.ts` (64KB 诊断)、`subagent-announce.format.e2e.test.ts` (112KB)、`agent.ts` (40KB) |
| **亮点** | doctor 命令提供全面的系统健康检查与自修复 |

---

## 第四部分：代码质量审计

### 1. 潜在代码风险

#### 大文件风险

| 文件 | 大小 | 风险 |
|------|------|------|
| `src/config/schema.help.ts` | 158KB | 自动生成的帮助文本，维护难度高 |
| `src/agents/subagent-announce.format.e2e.test.ts` | 112KB | 测试文件过大，应考虑拆分 |
| `src/agents/subagent-announce.ts` | 52KB | 子 agent 公告逻辑复杂度高 |
| `src/config/io.ts` | 50KB | 配置 I/O 职责过重 |
| `src/config/schema.labels.ts` | 50KB | 标签定义文件过大 |
| `src/agents/pi-embedded-runner-extraparams.test.ts` | 56KB | 测试参数化覆盖过广 |
| `src/infra/heartbeat-runner.ts` | 41KB | 心跳逻辑复杂 |
| `src/gateway/server.impl.ts` | 38KB | 网关核心实现，应进一步拆分 |

#### 潜在内存风险

- `src/agents/subagent-registry.ts` (43KB): 管理大量子 agent 的生命周期，在高并发场景下需要注意 registry 清理
- `src/agents/session-write-lock.ts` (16KB): 文件写锁若未正确释放可能导致死锁
- `src/infra/heartbeat-runner.ts` (41KB): 长期运行的心跳任务需关注定时器泄漏

#### 依赖版本风险

- `@whiskeysockets/baileys: 7.0.0-rc.9` — RC 预发布版本，可能存在 API 变更
- `@buape/carbon: 0.0.0-beta-*` — Beta 版本，不稳定
- `sqlite-vec: 0.1.7-alpha.2` — Alpha 版本
- `playwright-core: 1.58.2` — 固定版本，需定期更新安全补丁

### 2. 架构风险

#### 模块耦合

- **agents ↔ config**: agents 直接引用大量 config 类型，耦合较深
- **commands ↔ agents**: 命令层有 288 个文件，与 agent 层存在较多直接依赖
- **config/io.ts (50KB)**: 集配置读/写/验证/快照/迁移于一身，违反单一职责原则

#### 遗留迁移负担

- `src/config/legacy.migrations.part-{1,2,3}.ts` — 三阶段遗留迁移逻辑（合计 47KB），增加维护成本
- `src/config/legacy.rules.ts` — 遗留规则定义

#### 双 Schema 系统

- 同时使用 Zod (`zod-schema.*.ts`) 和 TypeBox (`@sinclair/typebox`)，增加认知负担
- `zod-schema.providers-core.ts` (56KB) 是最大的 Zod schema 文件

### 3. 可维护性问题

#### 超过 500 行的文件 (按 AGENTS.md 建议)

项目中存在大量超过 500 LOC 的文件，尤其集中在 `agents/`（子 agent、系统提示）、`config/`（io、schema）、`gateway/`（server.impl、session-utils）、`infra/`（heartbeat-runner、state-migrations）等目录。

#### 文件命名冗长

- `pi-embedded-subscribe.subscribe-embedded-pi-session.splits-long-single-line-fenced-blocks-reopen.test.ts` — 文件名过于冗长
- `pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts` — 88 字符文件名

---

## 第五部分：代码冗余分析

### 1. 可抽象为公共模块的代码

| 冗余模式 | 分布位置 | 建议 |
|----------|----------|------|
| 认证/密钥加载逻辑 | `agents/model-auth.ts`、`agents/cli-credentials.ts`、`commands/onboard-auth.credentials.ts`、`infra/provider-usage.auth.ts` | 抽取统一的 AuthCredentialManager |
| 通道发送适配器 | `cli/deps-send-*.runtime.ts` (6个独立文件) | 合并为统一的 send-adapter 注册表 |
| Docker sandbox 参数构建 | `agents/sandbox-create-args.*`、`agents/sandbox-paths.*`、`agents/sandbox.ts` | 整合为 SandboxManager 类 |
| 测试辅助函数 | `gateway/test-helpers.*` (7个文件)、`agents/test-helpers/`、各模块的 `test-helpers.ts` | 合并到统一的 test-utils 包 |
| doctor 子命令 | `commands/doctor-*.ts` (24+ 文件) | 考虑使用策略模式或注册表模式组织 |

### 2. 可能的无用代码

- `src/extensionAPI.ts` (600B): 仅导出占位，可能未实际使用
- `docs.acp.md` (根目录): 可能是临时文档
- 部分通道代码在核心和扩展中重复（例如 `src/discord/` 和 `extensions/discord/`）

### 3. 优化建议

1. **拆分大文件**: `config/io.ts`、`gateway/server.impl.ts`、`agents/subagent-announce.ts` 应按职责拆分
2. **统一 schema 系统**: 选择 Zod 或 TypeBox 之一，减少双系统维护成本
3. **减少遗留迁移代码**: 设定弃用日期，逐步清理 legacy migration
4. **合并测试辅助**: 建立统一的 `test-utils` 包

---

## 第六部分：开发规范总结

### 命名规范

- **产品名**: `OpenClaw` (文档/UI)，`openclaw` (CLI/包名/路径/配置)
- **文件名**: kebab-case (`model-fallback.ts`)
- **测试文件**: `*.test.ts` 并列放置
- **E2E 测试**: `*.e2e.test.ts`
- **函数**: camelCase
- **类型**: PascalCase

### 文件组织规范

- 测试与源码并列放置 (colocated)
- 通道代码按通道名组织目录 (`src/telegram/`、`src/discord/` 等)
- 扩展在 `extensions/` 下，每个扩展一个独立目录
- 文件建议 ≤500 LOC

### 模块划分规范

- **核心精简**: 可选功能通过插件提供
- **通道适配器**: 每个通道有独立目录，实现统一的通道接口
- **插件边界**: 插件依赖放在插件自身的 `package.json`，不添加到根 `package.json`
- **动态导入**: 使用 `*.runtime.ts` 边界文件进行懒加载

### 错误处理方式

- 全局未捕获异常处理 (`installUnhandledRejectionHandler`)
- 格式化错误输出 (`formatUncaughtError`)
- Best-effort 模式的非关键操作（try-catch 后静默跳过）
- Agent 工具调用带执行审批系统

### 日志系统

- `tslog` (结构化日志)
- `enableConsoleCapture()` 将 console.* 重定向到结构化日志
- 分级日志 (通过 CLI `--log-level` 控制)
- 通道级别独立日志 (`channels/logging.ts`)

---

## 第七部分：扩展与二次开发指南

### 1. 新增功能开发位置

| 功能类型 | 目录 | 说明 |
|----------|------|------|
| 新消息通道 | `extensions/<channel-name>/` | 创建新的扩展包 |
| 新 CLI 命令 | `src/cli/<name>-cli.ts` | 注册到 Commander |
| 新工具/能力 | `extensions/<tool-name>/` | 通过插件 SDK |
| 新模型提供商 | `src/agents/models-config.providers.*.ts` | 在 provider 发现中注册 |
| 新记忆后端 | `extensions/memory-<backend>/` | 实现 memory 插件接口 |

### 2. 新增模块步骤

1. 在 `extensions/` 下创建目录，添加 `package.json` 和源码
2. 实现 `src/index.ts` 导出符合 Plugin SDK 接口的插件
3. 在 `pnpm-workspace.yaml` 中注册
4. 在 `package.json` 的 `exports` 中添加 `./plugin-sdk/<name>` 条目
5. 更新 `.github/labeler.yml` 添加对应标签

### 3. 不建议修改的模块

| 模块 | 原因 |
|------|------|
| `src/config/schema.help.ts` | 部分自动生成，手动修改易被覆盖 |
| `src/config/legacy*` | 遗留迁移代码，修改可能破坏用户升级路径 |
| `node_modules/` | 禁止编辑 (AGENTS.md 明确规定) |
| `src/config/schema.labels.ts` | 高度耦合的标签定义 |
| Carbon 依赖 | 明确禁止更新 |

### 4. 主要扩展点

| 扩展点 | 机制 | 位置 |
|--------|------|------|
| 插件钩子 | beforeAgentStart / afterToolCall / ... | `src/plugins/hooks.ts` |
| 自定义命令 | Commander `.addCommand()` | `src/cli/program/` |
| 通道注册 | 通道注册表 | `src/channels/registry.ts` |
| 模型提供商 | Provider 发现 | `src/agents/models-config.providers.discovery.ts` |
| 技能系统 | 技能加载器 | `src/agents/skills.ts` |
| HTTP 路由 | 插件 HTTP Handler 注册 | `src/plugins/http-registry.ts` |

---

## 第八部分：关键文件列表

| # | 文件 | 说明 |
|---|------|------|
| 1 | `src/entry.ts` | CLI 全局入口，进程管理与 fast-path |
| 2 | `src/cli/run-main.ts` | CLI 启动核心，命令注册与解析 |
| 3 | `src/gateway/server.impl.ts` | 网关服务器核心实现 (38KB) |
| 4 | `src/gateway/server-http.ts` | 网关 HTTP API 层 (28KB) |
| 5 | `src/gateway/auth.ts` | 网关认证系统 (16KB) |
| 6 | `src/gateway/session-utils.ts` | 会话管理核心 (28KB) |
| 7 | `src/agents/system-prompt.ts` | Agent 系统提示构建 (33KB) |
| 8 | `src/agents/model-fallback.ts` | 多模型降级策略 (26KB) |
| 9 | `src/agents/model-selection.ts` | 模型选择逻辑 (20KB) |
| 10 | `src/agents/subagent-registry.ts` | 子 agent 生命周期管理 (43KB) |
| 11 | `src/config/io.ts` | 配置读/写/验证 (50KB) |
| 12 | `src/config/defaults.ts` | 所有默认配置值 (15KB) |
| 13 | `src/channels/dock.ts` | 通道消息分发中心 (21KB) |
| 14 | `src/plugins/loader.ts` | 插件加载器 (26KB) |
| 15 | `src/plugins/hooks.ts` | 插件钩子系统 (23KB) |
| 16 | `src/routing/resolve-route.ts` | 消息路由解析 (24KB) |
| 17 | `src/infra/heartbeat-runner.ts` | 心跳系统 (41KB) |
| 18 | `src/commands/doctor-config-flow.ts` | 系统诊断与修复 (64KB) |
| 19 | `package.json` | 项目依赖和脚本定义 (23KB) |
| 20 | `AGENTS.md` | 开发规范与约定 (28KB) |

---

## 第九部分：Agent Skills 生成

### Skill 1: 通道集成

```yaml
Skill Name: Channel Integration
Description: 添加新的消息通道到 OpenClaw
Applicable Modules: extensions/, src/channels/, src/plugin-sdk/
Example Usage: |
  1. 在 extensions/<channel>/ 创建插件
  2. 实现 plugin-sdk 的通道接口
  3. 注册到 channels/registry
  4. 更新 labeler.yml 和文档
```

### Skill 2: 模型提供商

```yaml
Skill Name: Model Provider Addition
Description: 添加新的 AI 模型提供商支持
Applicable Modules: src/agents/models-config.providers.*, src/agents/model-auth.*
Example Usage: |
  1. 在 models-config.providers.static.ts 添加 provider 定义
  2. 在 models-config.providers.ts 注册发现逻辑
  3. 添加认证配置到 commands/onboard-auth.*
  4. 更新 docs/providers/
```

### Skill 3: CLI 命令开发

```yaml
Skill Name: CLI Command Development
Description: 开发新的 CLI 子命令
Applicable Modules: src/cli/, src/commands/
Example Usage: |
  1. 在 src/cli/<name>-cli.ts 定义命令
  2. 在 src/commands/<name>.ts 实现业务逻辑
  3. 在 src/cli/program/command-registry.ts 注册
  4. 添加 *.test.ts 测试文件
```

### Skill 4: 插件开发

```yaml
Skill Name: Plugin Development
Description: 开发 OpenClaw 插件扩展
Applicable Modules: extensions/, src/plugins/, src/plugin-sdk/
Example Usage: |
  1. 在 extensions/<name>/ 下创建 package.json
  2. 实现 plugin manifest 和入口
  3. 通过 src/plugins/hooks.ts 注册钩子
  4. 通过 src/plugins/http-registry.ts 注册 HTTP 路由
  5. npm publish 分发
```

### Skill 5: 配置扩展

```yaml
Skill Name: Configuration Extension
Description: 扩展 OpenClaw 配置系统
Applicable Modules: src/config/
Example Usage: |
  1. 在 src/config/zod-schema.*.ts 添加 schema
  2. 在 src/config/defaults.ts 设置默认值
  3. 在 src/config/types.*.ts 添加类型
  4. 在 src/config/schema.help.ts 添加帮助文本
  5. 添加配置迁移逻辑 (必要时)
```

### Skill 6: 安全审计

```yaml
Skill Name: Security Audit
Description: 安全审计与漏洞修复
Applicable Modules: src/security/, src/infra/exec-*, SECURITY.md
Example Usage: |
  1. 阅读 SECURITY.md 了解威胁模型
  2. 检查 src/infra/exec-approvals*.ts 执行审批逻辑
  3. 检查 src/gateway/auth.ts 认证逻辑
  4. 检查 src/infra/host-env-security.ts 宿主环境策略
  5. 使用 openclaw doctor 运行安全检查
```

### Skill 7: 测试编写

```yaml
Skill Name: Test Writing
Description: 为 OpenClaw 编写测试
Applicable Modules: vitest.*.config.ts, src/**/*.test.ts
Example Usage: |
  1. 单元测试: *.test.ts 并列放置
  2. E2E 测试: *.e2e.test.ts
  3. 通道测试: vitest.channels.config.ts
  4. 网关测试: vitest.gateway.config.ts
  5. 运行: pnpm test (vitest)
  6. 覆盖率: pnpm test:coverage (V8, 70% 阈值)
```

### Skill 8: 调试与诊断

```yaml
Skill Name: Debugging & Diagnostics
Description: 调试和诊断 OpenClaw 问题
Applicable Modules: src/commands/doctor*.ts, src/infra/, scripts/clawlog.sh
Example Usage: |
  1. openclaw doctor — 全面系统诊断
  2. openclaw status --all — 服务状态
  3. openclaw channels status --probe — 通道探测
  4. 查看日志: scripts/clawlog.sh (macOS 统一日志)
  5. 查看 ~/.openclaw/agents/<id>/sessions/*.jsonl (会话日志)
```

---

## 第十部分：总结

### 项目优势

1. **架构清晰**: 分层设计合理，插件系统强大
2. **测试覆盖**: 广泛的单元/E2E/集成测试
3. **安全重视**: 完善的执行审批、认证、沙箱系统
4. **多平台支持**: CLI + Web + macOS + iOS + Android
5. **通道丰富**: 40+ 消息通道，覆盖主流即时通讯

### 改进建议

1. **拆分大文件**: 多个 30KB+ 文件应按职责拆分
2. **统一 Schema**: 收敛 Zod/TypeBox 双系统
3. **减少遗留代码**: 制定迁移弃用时间线
4. **改进模块边界**: 减少 agents ↔ config 的直接耦合
5. **规范化测试**: 合并分散的 test-helpers
