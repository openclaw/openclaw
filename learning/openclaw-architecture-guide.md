# OpenClaw 项目技术架构深度解析与学习指南

> 面向初学者的全面技术分析文档 | 最后更新: 2026-02-26

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈全景图](#2-技术栈全景图)
3. [核心架构设计](#3-核心架构设计)
4. [模块深度解析](#4-模块深度解析)
5. [设计模式与编程范式](#5-设计模式与编程范式)
6. [构建系统与工具链](#6-构建系统与工具链)
7. [测试体系](#7-测试体系)
8. [CI/CD 与 DevOps](#8-cicd-与-devops)
9. [多平台原生应用](#9-多平台原生应用)
10. [安全模型](#10-安全模型)
11. [技术关联图谱](#11-技术关联图谱)
12. [学习计划与路线图](#12-学习计划与路线图)
13. [核心概念教学](#13-核心概念教学)
14. [实战练习](#14-实战练习)
15. [推荐资源](#15-推荐资源)

---

## 1. 项目概览

### 1.1 OpenClaw 是什么

OpenClaw 是一个**个人 AI 助手平台**，运行在用户自己的设备上。它通过一个本地网关（Gateway）连接多个消息通道（WhatsApp、Telegram、Slack、Discord、Signal、iMessage 等），让用户可以通过任意消息平台与 AI 模型进行交互。

### 1.2 核心设计哲学

| 原则 | 说明 |
|------|------|
| **本地优先** | 网关运行在用户设备上，数据不经过第三方服务器 |
| **隐私至上** | 所有数据存储在本地 SQLite + 文件系统 |
| **单用户模型** | 个人助手，非多租户 SaaS |
| **可扩展** | 基于插件/Hook 的扩展机制 |
| **多通道** | 统一接口抽象所有消息平台 |
| **TypeScript 优先** | 主代码库为 TypeScript (ESM)，强类型无 `any` |

### 1.3 项目规模

```
代码语言: TypeScript (ESM) + Swift + Kotlin
源码目录: src/ (69 个子目录, 2000+ 文件)
扩展插件: extensions/ (40+ 个 workspace 包)
原生应用: apps/ (macOS/iOS/Android)
测试覆盖: 70%+ (Vitest + V8 Coverage)
运行时要求: Node.js 22+
包管理器: pnpm 10.23.0 (也支持 Bun)
```

---

## 2. 技术栈全景图

### 2.1 核心语言与运行时

```
┌─────────────────────────────────────────────────┐
│                   语言层                         │
├──────────────┬──────────────┬───────────────────┤
│  TypeScript  │    Swift     │     Kotlin        │
│  (核心 + CLI) │ (macOS/iOS) │   (Android)       │
├──────────────┴──────────────┴───────────────────┤
│                  运行时层                        │
├──────────────┬──────────────┬───────────────────┤
│  Node.js 22+ │   SwiftPM    │    Gradle 8.x     │
│  + Bun (dev) │  + Xcode     │  + Kotlin 2.2     │
└──────────────┴──────────────┴───────────────────┘
```

### 2.2 后端技术

| 技术 | 用途 | 学习优先级 |
|------|------|-----------|
| **TypeScript 5.9+** | 主开发语言 (ESM 模块) | ★★★★★ |
| **Node.js 22+** | 服务器运行时 | ★★★★★ |
| **Express/Hono** | HTTP 服务器 | ★★★★☆ |
| **WebSocket** | 实时通信 (网关 ↔ 客户端) | ★★★★☆ |
| **SQLite** | 本地数据库 (vec + FTS5) | ★★★★☆ |
| **Commander.js** | CLI 框架 | ★★★★☆ |
| **Zod** | 配置验证 (Schema) | ★★★☆☆ |
| **JSON5** | 配置文件格式 | ★★★☆☆ |

### 2.3 AI/LLM 集成

| 技术 | 用途 | 学习优先级 |
|------|------|-----------|
| **Anthropic SDK** | Claude 模型调用 | ★★★★★ |
| **OpenAI SDK** | GPT 模型调用 | ★★★★☆ |
| **Google AI SDK** | Gemini 模型调用 | ★★★☆☆ |
| **Ollama** | 本地模型推理 | ★★★☆☆ |
| **sqlite-vec** | 向量检索 (内存系统) | ★★★☆☆ |
| **SQLite FTS5** | 全文检索 | ★★★☆☆ |

### 2.4 消息通道 SDK

| SDK | 对应平台 | 学习优先级 |
|-----|---------|-----------|
| **Grammy** | Telegram Bot | ★★★★☆ |
| **Discord.js** | Discord Bot | ★★★★☆ |
| **Slack Bolt** | Slack App | ★★★☆☆ |
| **Baileys** | WhatsApp Web | ★★★☆☆ |
| **matrix-js-sdk** | Signal/Matrix | ★★☆☆☆ |

### 2.5 前端与 UI

| 技术 | 用途 | 学习优先级 |
|------|------|-----------|
| **Lit** | Web UI 组件库 | ★★★☆☆ |
| **Vite** | Web 构建工具 | ★★★☆☆ |
| **SwiftUI** | macOS/iOS 原生 UI | ★★★☆☆ |
| **Jetpack Compose** | Android 原生 UI | ★★★☆☆ |

### 2.6 构建与 DevOps

| 技术 | 用途 | 学习优先级 |
|------|------|-----------|
| **pnpm** | 包管理 (monorepo workspace) | ★★★★★ |
| **tsdown** | TypeScript 编译打包 | ★★★★☆ |
| **Vitest** | 单元/集成测试框架 | ★★★★☆ |
| **Oxlint** | 代码检查 (Rust 实现) | ★★★☆☆ |
| **Oxfmt** | 代码格式化 (Rust 实现) | ★★★☆☆ |
| **GitHub Actions** | CI/CD | ★★★☆☆ |
| **Docker** | 容器化部署 | ★★★☆☆ |
| **Fly.io** | 云部署平台 | ★★☆☆☆ |

---

## 3. 核心架构设计

### 3.1 分层架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     用户交互层                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ CLI 命令  │ │ Web UI   │ │ 移动 App  │ │ macOS 菜单栏  │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                     网关层 (Gateway)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ HTTP API │ │ WebSocket│ │ 配置重载  │ │  Cron 服务   │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                     消息路由层                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ 路由解析  │ │ 会话管理  │ │ 通道调度  │ │  绑定匹配    │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                     通道适配层                               │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
│  │Telegram│ │Discord │ │ Slack  │ │WhatsApp│ │Signal  │  │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘  │
├─────────────────────────────────────────────────────────────┤
│                     智能层 (AI Agent)                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Agent 运行│ │ 模型选择  │ │ 工具调用  │ │  流式响应    │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                     记忆与存储层                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ 向量检索  │ │ 全文搜索  │ │ 会话持久化│ │ 配置存储     │  │
│  │(sqlite-vec)│(FTS5)    │ │ (JSON)   │ │ (JSON5)      │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                     插件与扩展层                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ 插件发现  │ │ Hook 系统│ │ 插件注册  │ │  SDK 接口    │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 数据流架构

```
用户发送消息 (如 Telegram)
     │
     ▼
 ┌──────────────┐
 │ 通道适配器    │ ← Grammy SDK 接收 Telegram 消息
 │ (Inbound)    │
 └──────┬───────┘
        │ 标准化消息格式
        ▼
 ┌──────────────┐
 │ 通道 Dock     │ ← channels/dock.ts (21K LOC 核心路由)
 │ (Dispatch)   │
 └──────┬───────┘
        │ 解析路由规则
        ▼
 ┌──────────────┐
 │ 路由解析器    │ ← routing/resolve-route.ts
 │              │    确定: agentId, sessionKey, matchedBy
 └──────┬───────┘
        │ 分发到目标 Agent
        ▼
 ┌──────────────┐
 │ AI Agent     │ ← agents/pi-embedded.ts
 │              │    调用 LLM、执行工具、生成回复
 └──────┬───────┘
        │ 流式响应
        ▼
 ┌──────────────┐
 │ 通道适配器    │ ← 格式化为平台特定消息格式
 │ (Outbound)   │
 └──────┬───────┘
        │
        ▼
  用户收到 AI 回复
```

### 3.3 目录结构映射

```
openclaw/
├── src/                          # 核心 TypeScript 源码
│   ├── cli/                      # CLI 入口与命令注册 (Commander.js)
│   ├── commands/                 # 250+ 命令实现
│   ├── gateway/                  # 网关服务器 (WebSocket + HTTP)
│   ├── channels/                 # 通道注册与路由
│   ├── routing/                  # 消息路由引擎
│   ├── agents/                   # AI Agent 运行时
│   ├── config/                   # 配置加载与验证
│   ├── memory/                   # 向量 + 全文检索记忆系统
│   ├── media/                    # 媒体处理管道
│   ├── plugins/                  # 插件加载与注册
│   ├── plugin-sdk/               # 插件 SDK 公开接口
│   ├── hooks/                    # Hook 事件系统
│   ├── security/                 # 审计日志 + 安全策略
│   ├── infra/                    # 基础设施 (设备配对、端口、进程管理)
│   ├── telegram/                 # Telegram 通道实现
│   ├── discord/                  # Discord 通道实现
│   ├── slack/                    # Slack 通道实现
│   ├── signal/                   # Signal 通道实现
│   ├── imessage/                 # iMessage 通道实现
│   ├── web/                      # WhatsApp Web 通道实现
│   ├── browser/                  # 浏览器自动化工具 (Playwright)
│   ├── terminal/                 # 终端 UI 组件 (表格、调色板)
│   ├── tui/                      # TUI 仪表盘
│   └── ...                       # 更多模块
├── extensions/                   # 40+ 插件扩展
│   ├── msteams/                  # Microsoft Teams
│   ├── matrix/                   # Matrix 协议
│   ├── memory-lancedb/           # LanceDB 向量存储
│   ├── voice-call/               # 语音通话
│   └── ...
├── apps/                         # 原生应用
│   ├── macos/                    # macOS 菜单栏 App (Swift + SwiftUI)
│   ├── ios/                      # iOS App (Swift)
│   ├── android/                  # Android App (Kotlin)
│   └── shared/                   # 共享库 (OpenClawKit)
├── ui/                           # Web UI (Lit + Vite)
├── docs/                         # 文档 (Mintlify)
├── scripts/                      # 90+ 自动化脚本
├── test/                         # 全局测试工具
├── packages/                     # 工作区包
└── vendor/                       # 供应商依赖
```

---

## 4. 模块深度解析

### 4.1 CLI 模块 (`src/cli/` + `src/commands/`)

**核心概念**: 使用 Commander.js 构建命令行界面，采用惰性加载模式。

```
入口流程:
openclaw.mjs (二进制入口)
  → entry.ts (进程重生器 + Node options 注入)
    → cli/run-main.ts (Commander 设置)
      → cli/program/build-program.ts (命令注册)
        → commands/*.ts (按需加载具体命令)
```

**关键设计**:
- **惰性加载**: 命令模块在被调用时才加载，加速启动
- **依赖注入**: `createDefaultDeps()` 工厂函数提供可测试的依赖
- **参数解析**: `argv.ts` 处理 CLI 参数规范化

**教学要点**:
- Commander.js 的 `program.command()` + `action()` 模式
- 工厂函数 vs 类实例化的依赖管理方式
- 异步模块动态导入 (`import()`)

### 4.2 网关模块 (`src/gateway/`)

**核心概念**: WebSocket + HTTP 混合服务器，是整个系统的"心脏"。

```
网关启动流程:
gateway/boot.ts (启动序列)
  → config/config.ts (加载配置)
    → plugins/discovery.ts (发现插件)
      → channels/dock.ts (加载通道)
        → gateway/server.impl.ts (启动 WS + HTTP)
```

**关键组件**:

| 文件 | 职责 | 大小 |
|------|------|------|
| `server.impl.ts` | 核心服务器实现 | ~2800 行 |
| `server-channels.ts` | 通道生命周期管理 | 大型 |
| `server-chat.ts` | 聊天处理 + 流式响应 | 中型 |
| `server-http.ts` | REST API 路由 | 中型 |
| `server-ws-runtime.ts` | 移动端 WebSocket 连接 | 中型 |
| `node-registry.ts` | 远程设备节点注册 | 中型 |
| `config-reload.ts` | 配置热重载 | 小型 |

**教学要点**:
- WebSocket 双向通信原理
- HTTP + WS 混合服务器架构
- 服务器生命周期管理 (启动、重载、关闭)
- 配置热重载实现

### 4.3 通道系统 (`src/channels/` + 各平台目录)

**核心概念**: 适配器模式 (Adapter Pattern) 统一所有消息平台。

**适配器接口体系**:

```typescript
// channels/plugins/types.ts 定义的标准接口
interface ChannelSetupAdapter     { /* 认证/登录流程 */ }
interface ChannelMessagingAdapter { /* 收发消息 */ }
interface ChannelOutboundAdapter  { /* 格式化 + 投递出站消息 */ }
interface ChannelSecurityAdapter  { /* DM 策略、白名单 */ }
interface ChannelGroupAdapter     { /* 群组/频道管理 */ }
interface ChannelThreadingAdapter { /* 线程处理 */ }
interface ChannelStatusAdapter    { /* 健康/状态检查 */ }
interface ChannelGatewayAdapter   { /* 网关生命周期钩子 */ }
interface ChannelHeartbeatAdapter { /* 保活/重连 */ }
```

**通道注册表** (`channels/registry.ts`):
- 注册核心通道 (Telegram, WhatsApp, Discord, Slack, Signal, iMessage)
- 每个通道有元数据 (文档、标签、图标、配置 Schema)
- 通过 `getChannelPlugin(channelId)` 动态加载

**消息处理流程 (以 Telegram 为例)**:

```
Grammy SDK 接收事件
  → telegram/bot-handlers.ts    (事件分发)
  → telegram/bot-message-context.ts (提取发送者、聊天、媒体)
  → telegram/bot-message-dispatch.ts (路由到 Agent)
  → telegram/group-access.ts    (访问控制检查)
  → channels/dock.ts            (统一调度)
  → routing/resolve-route.ts    (确定目标 Agent)
```

**教学要点**:
- 适配器模式: 如何为不同平台定义统一接口
- 注册表模式: 运行时动态发现和注册
- 事件驱动架构: 消息从接收到处理的完整链路

### 4.4 路由系统 (`src/routing/`)

**核心概念**: 确定哪个 Agent 接收消息，以及使用什么会话键。

**路由优先级** (从高到低):

```
1. Peer 绑定       ← 特定用户/对等点的直接聊天
2. 父级 Peer 绑定  ← 线程回复继承父级绑定
3. Guild+Roles 绑定 ← Discord 角色级路由
4. Guild 绑定       ← Discord 服务器级路由
5. Team 绑定        ← Slack 团队级路由
6. Account 绑定     ← 通道账户级路由
7. Channel 绑定     ← 整个通道级路由
8. 默认路由         ← 回退到默认 Agent
```

**会话键格式**: `<agentId>:<channel>:<accountId>:<peerId>[:<threadId>]`

**教学要点**:
- 优先级链模式 (Chain of Priority)
- 会话键设计: 如何用复合键管理并发
- 分层路由: 从粗粒度到细粒度的匹配

### 4.5 AI Agent 系统 (`src/agents/`)

**核心概念**: Agent 是处理用户消息、调用 LLM、执行工具的核心运行时。

```
Agent 处理流程:
agents/agent-scope.ts    (Agent 隔离与上下文)
  → agents/model-selection.ts (选择 LLM 模型)
    → agents/pi-embedded.ts   (嵌入式 Agent 运行)
      → LLM Provider API      (Claude/GPT/Gemini)
      → Tool Execution         (浏览器/Shell/自定义)
    → Streaming Response       (流式返回结果)
```

**关键子系统**:

| 子系统 | 功能 | 关键文件 |
|--------|------|---------|
| Agent Scope | 工作空间隔离 | `agent-scope.ts` |
| Model Selection | 模型切换与回退 | `model-selection.ts` |
| Auth Profiles | 凭证管理与轮转 | `auth-profiles/` |
| Tool Execution | 工具调用与审批 | `bash-tools.*.ts` |
| Browser Tool | Playwright 浏览器自动化 | `src/browser/` |

**教学要点**:
- LLM 工具调用 (Tool Use) 模式
- 流式响应 (Streaming) 处理
- Agent 隔离与并发控制

### 4.6 记忆系统 (`src/memory/`)

**核心概念**: 混合检索 = 向量嵌入 + 全文搜索 + MMR 排序。

```
记忆检索流程:
查询输入
  → 向量嵌入 (OpenAI/Gemini/Voyage Embedding API)
  → SQLite vec 向量相似搜索
  → SQLite FTS5 全文关键词搜索
  → MMR 融合排序 (Maximal Marginal Relevance)
  → 返回相关记忆片段
```

**嵌入提供者**:
- `embeddings-openai.ts` → OpenAI Embeddings API
- `embeddings-gemini.ts` → Google Gemini Embeddings
- `embeddings-voyage.ts` → Voyage AI Embeddings
- `embeddings-mistral.ts` → Mistral Embeddings

**教学要点**:
- 向量数据库概念与应用
- 全文搜索 (FTS5) 原理
- MMR 排序算法: 平衡相关性与多样性
- 嵌入 (Embedding) 在 AI 中的作用

### 4.7 插件系统 (`src/plugins/` + `src/plugin-sdk/`)

**核心概念**: 基于 Hook 的事件驱动插件架构。

```
插件生命周期:
plugins/discovery.ts  (扫描插件)
  → plugins/manifest.ts  (读取清单)
    → plugins/install.ts  (安装依赖)
      → plugins/loader.ts  (加载模块, 支持 ESM + CJS)
        → plugins/registry.ts (注册 Hook 处理器)
          → hooks/index.ts     (事件触发)
```

**Plugin SDK 公开接口**:
```typescript
// 插件开发者可用的 API
export interface ChannelPlugin { /* 实现通道适配器 */ }
export interface OpenClawPluginApi { /* 运行时插件接口 */ }
export interface OpenClawPluginService { /* 异步服务 */ }
```

**Hook 事件示例**:
- `gateway:startup` — 网关启动时触发
- `command:new` — 新消息到达时触发
- `session:start` — 会话开始时触发
- 插件可以拦截、转换、增强行为

**教学要点**:
- 插件架构设计原则
- 事件驱动 Hook 模式
- 模块动态加载 (ESM + CJS 兼容)
- SDK 设计: 如何为第三方开发者暴露接口

### 4.8 配置系统 (`src/config/`)

**核心概念**: JSON5 分层配置 + 环境变量替换 + Zod 验证。

```
配置加载流程:
JSON5 文件 (~/.openclaw/config.json5)
  → json5 解析
    → 解析 includes (config.include: [...])
      → 环境变量替换 ("${VAR_NAME}")
        → Zod Schema 验证
          → 插件贡献的验证规则
            → 路径规范化 + 默认值填充
```

**配置结构示例**:
```json5
{
  "version": "2025.2.15",
  "gateway": { "port": 18789, "mode": "local" },
  "agents": {
    "default": "default",
    "my-agent": {
      "model": "claude-opus-4",
      "provider": "anthropic"
    }
  },
  "channels": {
    "telegram": { "token": "${TELEGRAM_BOT_TOKEN}" }
  },
  "plugins": { "@openclaw/msteams": {} }
}
```

**教学要点**:
- JSON5 vs JSON 的优势 (注释、尾逗号)
- 环境变量替换的安全实践
- Zod Schema 验证的声明式方式
- 配置热重载机制

### 4.9 媒体管道 (`src/media/`)

**核心概念**: 入站获取 → 解析 → 存储 → 服务。

```
媒体处理流程:
入站 (input-files.ts)     → 获取 + 验证大小限制
  → 解析 (parse.ts)       → MIME 类型检测
    → 转换 (image-ops.ts) → Sharp 图像操作 (缩放/格式转换)
      → 存储 (store.ts)   → SHA256 去重存储
        → 服务             → 通过 HTTP/WebSocket 提供
```

**教学要点**:
- 媒体处理管道模式
- SHA256 内容寻址存储
- MIME 类型与内容协商
- Sharp 库的图像处理

---

## 5. 设计模式与编程范式

### 5.1 核心设计模式

#### 模式 1: 适配器模式 (Adapter Pattern)

**应用场景**: 通道系统统一不同消息平台

```typescript
// 所有通道实现标准适配器接口
Channel = {
  outbound: ChannelOutboundAdapter,   // 出站消息
  messaging: ChannelMessagingAdapter, // 收发消息
  security: ChannelSecurityAdapter,   // 安全策略
  status: ChannelStatusAdapter,       // 健康检查
  // ...
}
```

**为什么用这个模式**: 每个消息平台 API 完全不同，适配器让核心代码不感知平台差异。

#### 模式 2: 工厂函数 + 依赖注入

**应用场景**: CLI 命令创建、服务实例化

```typescript
// 工厂函数代替 new Class()
function createDefaultDeps() {
  return {
    sendTelegram: async () => import('./telegram/send'),
    sendDiscord:  async () => import('./discord/send'),
    // ...
  }
}
```

**为什么用这个模式**: 避免深层类继承，方便测试时替换依赖。

#### 模式 3: 事件驱动 Hook 系统

**应用场景**: 插件扩展机制

```typescript
// 插件注册事件处理器
hooks.on('command:new', async (message) => {
  // 拦截/转换消息
})
hooks.on('gateway:startup', async () => {
  // 初始化插件资源
})
```

**为什么用这个模式**: 解耦核心与扩展，插件无需修改核心代码。

#### 模式 4: 惰性加载 (Lazy Loading)

**应用场景**: 命令注册、插件加载、通道初始化

```typescript
// 命令在被调用时才加载模块
program.command('send')
  .action(async () => {
    const { handleSend } = await import('./commands/send')
    await handleSend()
  })
```

**为什么用这个模式**: CLI 有 250+ 命令，全部预加载会严重拖慢启动速度。

#### 模式 5: 组合优于继承

**应用场景**: 整个代码库的核心原则

```typescript
// 不用: class TelegramChannel extends BaseChannel extends AbstractChannel
// 而用: 由小型独立函数组合而成
const channel = {
  setup: createTelegramSetup(config),
  messaging: createTelegramMessaging(socket),
  security: createTelegramSecurity(allowlist),
}
```

**为什么用这个模式**: 避免脆弱的继承链，每个部分独立可测试。

#### 模式 6: 会话级并发控制

**应用场景**: 消息处理

```
会话键 = agent:channel:account:peer[:thread]
每个会话键对应一个并发通道 (lane)
同一会话内的消息串行处理，不同会话并行
```

**为什么用这个模式**: 保证同一对话的消息按顺序处理，同时不阻塞其他对话。

### 5.2 编程范式

| 范式 | 体现 |
|------|------|
| **函数式优先** | 工厂函数、组合函数、避免类继承 |
| **强类型** | 严格 TypeScript，禁止 `any` |
| **ESM 模块** | 全面使用 ES Module，支持 tree-shaking |
| **异步编程** | async/await 为主，流式处理用 AsyncIterator |
| **不可变配置** | 配置加载后以快照形式传递 |

---

## 6. 构建系统与工具链

### 6.1 Monorepo 工作区

```yaml
# pnpm-workspace.yaml
packages:
  - .              # 根包 (主 CLI)
  - ui             # Web UI
  - packages/*     # 命名包 (clawdbot, moltbot)
  - extensions/*   # 40+ 插件扩展
```

**依赖管理规则**:
- 插件 `dependencies` 不能用 `workspace:*` (npm install 会失败)
- 核心引用放 `devDependencies` 或 `peerDependencies`
- 运行时通过 `jiti` 别名解析 `openclaw/plugin-sdk`
- 被 patch 的依赖必须使用精确版本号 (无 `^` 或 `~`)

### 6.2 编译管道

```
pnpm build 执行流程:
1. pnpm canvas:a2ui:bundle  → 打包 Canvas 渲染器 (hash 缓存)
2. tsdown                    → 编译 TypeScript 入口
3. build:plugin-sdk:dts      → 生成插件 SDK 类型定义
4. write-plugin-sdk-entry-dts → 写入 SDK 入口 .d.ts
5. canvas-a2ui-copy          → 复制 Canvas 资源
6. copy-hook-metadata        → 复制 Hook 元数据
7. copy-export-html-templates → 复制 HTML 模板
8. write-build-info          → 写入构建信息
9. write-cli-compat          → CLI 兼容层
```

### 6.3 代码质量工具

```bash
# 完整检查链
pnpm check = pnpm format:check   # Oxfmt 格式化检查
           + pnpm tsgo            # TypeScript 类型检查
           + pnpm lint            # Oxlint 代码检查

# 自动修复
pnpm format:fix   # 自动格式化
pnpm lint:fix     # 自动修复 lint 问题
```

---

## 7. 测试体系

### 7.1 测试层级

```
┌────────────────────────────────────────────┐
│          E2E 测试 (最慢, 最完整)            │
│  test/**/*.e2e.test.ts                     │
│  vmForks 隔离, 2 workers                   │
├────────────────────────────────────────────┤
│        集成测试 (中等速度)                  │
│  Docker 容器内运行                         │
│  test:docker:live-models / live-gateway    │
├────────────────────────────────────────────┤
│       Live 测试 (需要真实 API Key)          │
│  src/**/*.live.test.ts                     │
│  CLAWDBOT_LIVE_TEST=1, 单 worker           │
├────────────────────────────────────────────┤
│        单元测试 (最快, 最多)                │
│  src/**/*.test.ts (与源码共存)              │
│  fork 隔离, 最多 16 workers                │
└────────────────────────────────────────────┘
```

### 7.2 测试配置

```typescript
// vitest.config.ts 核心配置
{
  pool: 'forks',          // 进程级隔离
  maxWorkers: 16,         // 本地最多 16 并发
  timeout: 120_000,       // 2 分钟超时
  coverage: {
    provider: 'v8',       // V8 覆盖率引擎
    thresholds: {
      lines: 70,          // 行覆盖 70%+
      functions: 70,      // 函数覆盖 70%+
      branches: 55,       // 分支覆盖 55%+
      statements: 70,     // 语句覆盖 70%+
    }
  }
}
```

### 7.3 测试命令

```bash
pnpm test              # 完整测试套件
pnpm test:fast         # 仅单元测试
pnpm test:coverage     # 带覆盖率报告
pnpm test:watch        # 监听模式
pnpm test:e2e          # E2E 测试
pnpm test:live         # Live 集成测试 (需 API Key)
pnpm test:docker:*     # Docker 容器化测试
```

---

## 8. CI/CD 与 DevOps

### 8.1 CI 流水线

```
PR 触发 → GitHub Actions
  ├── docs-scope (检测是否仅文档变更)
  ├── changed-scope (确定影响范围: Node/macOS/Android)
  │
  ├── check (TypeScript + Lint + Format)
  ├── build-artifacts (编译 dist, 共享给下游)
  ├── checks (Node + Bun 测试矩阵)
  ├── checks-windows (跨平台验证)
  ├── macos (Swift lint + build + test)
  ├── android (Gradle test + build)
  ├── skills-python (Python skill 验证)
  ├── secrets (密钥扫描 + 审计)
  └── check-docs (文档格式/链接检查)
```

### 8.2 Docker 部署

```dockerfile
# 核心 Dockerfile
FROM node:22-bookworm
# 安装 Bun (用于构建)
# pnpm install --frozen-lockfile
# pnpm build && pnpm ui:build
# 用户: node (非 root 安全运行)
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
```

### 8.3 Fly.io 云部署

```toml
# fly.toml
[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[mounts]
  source = "openclaw_data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"
```

---

## 9. 多平台原生应用

### 9.1 平台矩阵

| 平台 | 语言 | UI 框架 | 构建工具 | 特点 |
|------|------|---------|---------|------|
| macOS | Swift 6.2 | SwiftUI | SwiftPM + Shell | 菜单栏 Agent + Sparkle 自动更新 |
| iOS | Swift | SwiftUI | XcodeGen | Node Host + 语音集成 |
| Android | Kotlin | Jetpack Compose | Gradle 8.11 | Node Runtime + 通知 |

### 9.2 共享架构

```
apps/shared/OpenClawKit/
  ├── OpenClawProtocol  # 跨平台协议定义
  └── 共享工具           # 跨 iOS/macOS 的通用组件
```

**协议同步**: `pnpm protocol:check` 确保 TypeScript Schema 与 Swift 模型一致。

---

## 10. 安全模型

### 10.1 多层安全体系

```
第 1 层: 设备配对 (Setup Code / QR)
  │ 只有配对过的设备才能连接网关
  ▼
第 2 层: 网关认证 (Token / Password)
  │ HTTP/WebSocket 连接需要有效凭证
  ▼
第 3 层: 通道认证 (Bot Token / OAuth)
  │ 每个消息平台有独立凭证
  ▼
第 4 层: 消息级安全 (DM Policy + Allowlist)
  │ 控制谁可以发消息给 AI
  ▼
第 5 层: 命令审批 (Exec Approvals)
  │ 危险命令需要用户确认
  ▼
第 6 层: 审计日志 (Audit)
    所有操作记录到 ~/.openclaw/audit
```

### 10.2 DM 策略

| 策略 | 行为 |
|------|------|
| `pairing` (默认) | 未知发送者获得配对码，需确认后才能对话 |
| `open` | 任何人都可以发送消息 |
| `closed` | 仅白名单内的发送者 |

---

## 11. 技术关联图谱

### 11.1 技术依赖关系

```
TypeScript (核心语言)
  ├── Node.js 22+ (运行时)
  │     ├── Express/Hono (HTTP)
  │     ├── WebSocket (实时通信)
  │     └── SQLite (存储)
  │           ├── sqlite-vec (向量)
  │           └── FTS5 (全文搜索)
  │
  ├── Commander.js (CLI)
  │     └── Zod (验证)
  │           └── JSON5 (配置格式)
  │
  ├── 消息 SDK (通道)
  │     ├── Grammy → Telegram API
  │     ├── Discord.js → Discord API
  │     ├── Slack Bolt → Slack API
  │     ├── Baileys → WhatsApp Web
  │     └── matrix-js-sdk → Signal/Matrix
  │
  ├── AI SDK (智能层)
  │     ├── @anthropic-ai/sdk → Claude
  │     ├── openai → GPT
  │     └── @google-ai/sdk → Gemini
  │
  └── 构建工具
        ├── pnpm (包管理)
        ├── tsdown (编译)
        ├── Vitest (测试)
        ├── Oxlint (lint)
        └── Oxfmt (格式化)
```

### 11.2 模块间通信

```
CLI ──(Commander)──→ Commands ──(Factory)──→ Gateway
                                              │
Gateway ──(WebSocket)──→ 移动 App (iOS/Android/macOS)
    │
    ├──(Adapter)──→ Telegram Channel
    ├──(Adapter)──→ Discord Channel
    ├──(Adapter)──→ Slack Channel
    └──(Adapter)──→ ... 其他通道
         │
         └──(Route)──→ Agent ──(API)──→ LLM Provider
                         │
                         ├──(Vec)──→ Memory (sqlite-vec)
                         ├──(FTS)──→ Memory (FTS5)
                         └──(Tool)──→ Browser/Shell/Custom
```

---

## 12. 学习计划与路线图

### 12.1 总览 (建议 12-16 周)

```
第 1-2 周:  基础准备 (TypeScript + Node.js + 工具链)
第 3-4 周:  项目入门 (运行项目 + 理解结构)
第 5-6 周:  核心模块 (CLI + 网关 + 配置)
第 7-8 周:  通道系统 (适配器 + 路由)
第 9-10 周: 智能层 (Agent + LLM + Memory)
第 11-12 周: 插件系统 (Plugin SDK + Hook)
第 13-14 周: 高级主题 (安全 + 测试 + CI/CD)
第 15-16 周: 实战项目 (开发插件 / 贡献 PR)
```

### 12.2 详细学习步骤

#### 阶段一: 基础准备 (第 1-2 周)

**目标**: 掌握项目所需的基础技术

**步骤 1: TypeScript 进阶**
- [ ] 理解 ESM vs CJS 模块系统差异
- [ ] 掌握泛型 (Generics) 与条件类型
- [ ] 理解 `async/await`、`Promise`、`AsyncIterator`
- [ ] 了解 `type` vs `interface` 的使用场景
- [ ] 练习: 编写一个类型安全的事件发射器

**步骤 2: Node.js 核心概念**
- [ ] 理解事件循环 (Event Loop) 机制
- [ ] 掌握 Stream API (可读流/可写流/Transform)
- [ ] 理解 Worker Threads 与 Child Processes
- [ ] 了解 Node.js 22 新特性 (--experimental-require-module 等)
- [ ] 练习: 编写一个 WebSocket 聊天服务器

**步骤 3: 工具链熟悉**
- [ ] 安装并使用 pnpm (理解 workspace 概念)
- [ ] 学习 Vitest 测试框架基础
- [ ] 了解 Oxlint/Oxfmt 的作用
- [ ] 练习: 创建一个 pnpm monorepo 项目

#### 阶段二: 项目入门 (第 3-4 周)

**目标**: 能够运行项目并理解整体结构

**步骤 4: 本地运行**
```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm openclaw --version    # 验证 CLI 可用
pnpm openclaw onboard      # 体验交互式向导
```

**步骤 5: 代码阅读 (自顶向下)**
- [ ] 阅读 `openclaw.mjs` → `src/entry.ts` → `src/cli/run-main.ts` (入口链路)
- [ ] 阅读 `src/cli/program/build-program.ts` (命令注册)
- [ ] 阅读 `src/gateway/boot.ts` → `src/gateway/server.impl.ts` (网关启动)
- [ ] 阅读 `src/channels/dock.ts` (通道调度核心，虽大但重要)
- [ ] 阅读 `src/routing/resolve-route.ts` (路由核心)

**步骤 6: 运行测试**
```bash
pnpm test:fast             # 运行快速测试
pnpm test -- --reporter=verbose src/routing  # 运行特定模块测试
```

#### 阶段三: 核心模块 (第 5-6 周)

**目标**: 深入理解 CLI、网关、配置系统

**步骤 7: CLI 模块深入**
- [ ] 阅读 Commander.js 文档
- [ ] 追踪 `openclaw gateway run` 命令的完整执行路径
- [ ] 理解 `createDefaultDeps()` 依赖注入模式
- [ ] 练习: 添加一个简单的 CLI 子命令

**步骤 8: 网关模块深入**
- [ ] 理解 HTTP + WebSocket 混合服务器架构
- [ ] 阅读 `server-http.ts` 中的 API 路由
- [ ] 阅读 `server-ws-runtime.ts` 中的 WebSocket 事件
- [ ] 理解配置热重载 (`config-reload.ts`)

**步骤 9: 配置系统深入**
- [ ] 阅读 `config/io.ts` 了解配置加载
- [ ] 阅读 `config/zod-schema.ts` 了解 Zod 验证
- [ ] 理解环境变量替换 (`env-substitution.ts`)
- [ ] 练习: 编写一个 JSON5 + Zod 配置系统

#### 阶段四: 通道系统 (第 7-8 周)

**目标**: 理解适配器模式与多通道架构

**步骤 10: 适配器接口**
- [ ] 阅读 `channels/plugins/types.ts` 所有适配器接口
- [ ] 对比 Telegram (`src/telegram/`) 和 Discord (`src/discord/`) 的实现差异
- [ ] 理解 `channels/registry.ts` 注册表模式

**步骤 11: 消息流完整追踪**
- [ ] 从 Telegram 消息接收 → 路由 → Agent → 回复的完整链路
- [ ] 使用断点或日志追踪消息在代码中的流转
- [ ] 理解会话键如何生成和使用

**步骤 12: 路由系统深入**
- [ ] 阅读 `routing/resolve-route.ts` 理解优先级链
- [ ] 阅读 `routing/session-key.ts` 理解会话键构造
- [ ] 练习: 画出路由决策树

#### 阶段五: 智能层 (第 9-10 周)

**目标**: 理解 AI Agent 运行时与记忆系统

**步骤 13: Agent 运行时**
- [ ] 阅读 `agents/pi-embedded.ts` (核心 Agent 循环)
- [ ] 理解模型选择 (`model-selection.ts`)
- [ ] 理解工具调用 (Tool Use) 流程
- [ ] 练习: 调用 Anthropic API 实现一个简单 Agent

**步骤 14: LLM 集成**
- [ ] 理解流式响应 (Streaming) 的实现方式
- [ ] 了解不同模型提供者的 API 差异
- [ ] 理解 Auth Profile 凭证轮转

**步骤 15: 记忆系统**
- [ ] 理解向量嵌入 (Embedding) 概念
- [ ] 阅读 `memory/embeddings.ts` 管理器
- [ ] 理解 sqlite-vec 向量检索
- [ ] 理解 FTS5 全文搜索
- [ ] 理解 MMR 排序算法
- [ ] 练习: 用 sqlite-vec 实现简单的相似搜索

#### 阶段六: 插件系统 (第 11-12 周)

**目标**: 掌握插件架构并能开发简单插件

**步骤 16: 插件架构**
- [ ] 阅读 `plugins/discovery.ts` → `loader.ts` → `registry.ts`
- [ ] 理解 Hook 事件系统 (`hooks/index.ts`)
- [ ] 阅读一个现有扩展 (如 `extensions/msteams/`)

**步骤 17: Plugin SDK**
- [ ] 阅读 `plugin-sdk/index.ts` 公开接口
- [ ] 理解 `ChannelPlugin` 接口要求
- [ ] 理解 jiti 别名解析机制

**步骤 18: 开发练习插件**
- [ ] 按照 Plugin SDK 创建一个简单通道插件骨架
- [ ] 实现 `ChannelSetupAdapter` 和 `ChannelMessagingAdapter`
- [ ] 注册 Hook 处理器

#### 阶段七: 高级主题 (第 13-14 周)

**步骤 19: 安全模型**
- [ ] 阅读 `SECURITY.md` 安全策略
- [ ] 理解设备配对流程 (`infra/device-pairing.ts`)
- [ ] 理解审计日志 (`security/audit.ts`)
- [ ] 理解 DM 策略与白名单

**步骤 20: 测试深入**
- [ ] 理解 Vitest fork 隔离机制
- [ ] 阅读 `test/setup.ts` 全局设置
- [ ] 学习 stub/mock 技巧
- [ ] 为一个模块编写完整测试

**步骤 21: CI/CD 理解**
- [ ] 阅读 `.github/workflows/ci.yml` 完整流水线
- [ ] 理解 scope 检测 (docs-scope, changed-scope)
- [ ] 理解构建缓存策略

#### 阶段八: 实战项目 (第 15-16 周)

**步骤 22: 贡献准备**
- [ ] 阅读项目的贡献指南
- [ ] 熟悉 PR 工作流 (`.agents/skills/PR_WORKFLOW.md`)
- [ ] 使用 `scripts/committer` 提交代码

**步骤 23: 选择任务**
- [ ] 浏览 GitHub Issues 找 `good first issue`
- [ ] 修复一个 Bug 或实现小功能
- [ ] 提交 PR 并通过 CI

---

## 13. 核心概念教学

### 13.1 ESM 模块系统

**什么是 ESM?**

ESM (ECMAScript Modules) 是 JavaScript 的官方模块系统，OpenClaw 全面使用 ESM。

```typescript
// ESM 导入 (OpenClaw 使用的方式)
import { Gateway } from './gateway/server.js'
import type { Config } from './config/types.js'

// ESM 导出
export function createGateway(config: Config) { ... }
export default class Server { ... }
```

**vs CJS (旧方式)**:
```javascript
// CJS (Node.js 传统方式, OpenClaw 不用)
const { Gateway } = require('./gateway/server')
module.exports = { createGateway }
```

**关键差异**:
- ESM 是静态分析的 (编译时确定依赖关系)，支持 tree-shaking
- CJS 是动态的 (运行时加载)
- ESM 使用 `import`/`export`，CJS 使用 `require`/`module.exports`
- 在 `package.json` 中 `"type": "module"` 启用 ESM

### 13.2 依赖注入 (Dependency Injection)

**什么是 DI?**

依赖注入是一种将对象的依赖从外部传入而非内部创建的模式。

```typescript
// ❌ 紧耦合 (直接创建依赖)
class ChatHandler {
  private telegram = new TelegramClient()  // 硬编码依赖

  async handle(msg: Message) {
    await this.telegram.send(msg)  // 无法替换
  }
}

// ✅ OpenClaw 的方式 (工厂函数 + 注入)
function createChatHandler(deps: {
  sendTelegram: () => Promise<TelegramSender>,
  sendDiscord: () => Promise<DiscordSender>,
}) {
  return {
    async handle(msg: Message) {
      const sender = await deps.sendTelegram()
      await sender.send(msg)
    }
  }
}

// 测试时可以注入 mock
const handler = createChatHandler({
  sendTelegram: async () => ({ send: vi.fn() }),
  sendDiscord: async () => ({ send: vi.fn() }),
})
```

### 13.3 适配器模式 (Adapter Pattern)

**什么是适配器模式?**

将不兼容的接口转换为统一接口，让不同实现可以互换。

```typescript
// 统一接口
interface MessageSender {
  send(text: string, recipient: string): Promise<void>
}

// Telegram 适配器
class TelegramAdapter implements MessageSender {
  async send(text: string, recipient: string) {
    // Grammy 特有逻辑
    await this.bot.api.sendMessage(recipient, text)
  }
}

// Discord 适配器
class DiscordAdapter implements MessageSender {
  async send(text: string, recipient: string) {
    // Discord.js 特有逻辑
    const channel = await this.client.channels.fetch(recipient)
    await channel.send(text)
  }
}

// 使用方不关心具体平台
async function deliverMessage(sender: MessageSender, msg: string) {
  await sender.send(msg, recipientId)  // 统一调用
}
```

### 13.4 事件驱动架构

**什么是事件驱动?**

组件之间通过发布/订阅事件通信，而不是直接调用。

```typescript
// Hook 系统 (OpenClaw 的事件驱动实现)
class HookSystem {
  private handlers = new Map<string, Function[]>()

  on(event: string, handler: Function) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }

  async emit(event: string, data: any) {
    const handlers = this.handlers.get(event) ?? []
    for (const handler of handlers) {
      await handler(data)
    }
  }
}

// 核心代码
hooks.emit('command:new', message)  // 只管发事件

// 插件代码 (解耦)
hooks.on('command:new', async (msg) => {
  // 自定义处理逻辑
  await logToExternalService(msg)
})
```

### 13.5 WebSocket 实时通信

**什么是 WebSocket?**

全双工通信协议，允许服务器主动推送数据到客户端。

```
HTTP (单向):
客户端 ──请求──→ 服务器
客户端 ←──响应── 服务器
(每次需要新请求)

WebSocket (双向):
客户端 ←──实时数据──→ 服务器
(建立一次连接后持续通信)
```

**在 OpenClaw 中的应用**:
- 网关 ↔ 移动 App: 实时消息推送
- 网关 ↔ Web UI: 状态更新
- Agent 流式响应: 逐字传输 AI 回复

### 13.6 向量检索与嵌入

**什么是向量嵌入?**

将文本转换为高维向量 (数组)，语义相似的文本在向量空间中距离更近。

```
"你好" → [0.12, -0.34, 0.56, ...]  (1536 维)
"Hi"   → [0.11, -0.33, 0.55, ...]  (非常接近!)
"猫"   → [0.89, 0.23, -0.67, ...]  (距离较远)
```

**在 OpenClaw 中的应用**:
```
用户提问: "上次聊的那个项目进展如何?"
     │
     ▼
  向量嵌入: [0.23, 0.45, ...]
     │
     ▼
  sqlite-vec: 在记忆库中找到最相似的向量
     │
     ▼
  返回相关历史对话片段
     │
     ▼
  提供给 LLM 作为上下文
```

### 13.7 Monorepo 工作区

**什么是 Monorepo?**

在一个仓库中管理多个相关包/项目。

```
openclaw/ (monorepo 根)
  ├── package.json     (根包)
  ├── pnpm-workspace.yaml
  ├── ui/              (Web UI 包)
  │   └── package.json
  ├── extensions/
  │   ├── msteams/     (Teams 插件包)
  │   │   └── package.json
  │   └── matrix/      (Matrix 插件包)
  │       └── package.json
  └── packages/
      └── clawdbot/    (工具包)
          └── package.json
```

**优势**:
- 代码共享: 插件可以引用核心类型
- 统一构建: 一条命令构建所有包
- 版本同步: `pnpm plugins:sync` 对齐版本
- 原子变更: 一个 PR 可以同时改核心和插件

---

## 14. 实战练习

### 练习 1: 追踪消息流 (理解架构)

**目标**: 追踪一条 Telegram 消息从接收到 AI 回复的完整路径。

**步骤**:
1. 打开 `src/telegram/bot-handlers.ts`，找到消息接收入口
2. 跟踪到 `src/telegram/bot-message-dispatch.ts`
3. 跟踪到 `src/channels/dock.ts` (统一调度)
4. 跟踪到 `src/routing/resolve-route.ts` (路由解析)
5. 跟踪到 `src/agents/pi-embedded.ts` (Agent 处理)
6. 回到通道适配器发送回复

**输出**: 画出完整的调用链图。

### 练习 2: 理解配置系统

**目标**: 编写一个迷你 JSON5 配置加载器。

```typescript
// 实现: 加载 JSON5 + 环境变量替换 + Zod 验证
import { z } from 'zod'

const schema = z.object({
  port: z.number().default(3000),
  token: z.string(),
})

function loadConfig(path: string) {
  // 1. 读取 JSON5 文件
  // 2. 替换 ${ENV_VAR} 占位符
  // 3. 用 Zod 验证
  // 4. 返回类型安全的配置对象
}
```

### 练习 3: 实现简单适配器

**目标**: 为一个假想的消息平台实现通道适配器。

```typescript
// 实现 ChannelOutboundAdapter 接口
interface ChannelOutboundAdapter {
  sendText(recipient: string, text: string): Promise<void>
  sendMedia(recipient: string, media: Buffer, type: string): Promise<void>
}

class MockChannelAdapter implements ChannelOutboundAdapter {
  // 实现所有方法
}
```

### 练习 4: 编写单元测试

**目标**: 为路由系统编写测试。

```typescript
import { describe, it, expect } from 'vitest'

describe('resolve-route', () => {
  it('应该匹配 peer 绑定', () => {
    // 设置绑定配置
    // 调用路由解析
    // 验证返回的 agentId 和 sessionKey
  })

  it('应该回退到默认路由', () => {
    // 无绑定时的行为
  })
})
```

### 练习 5: 开发简单插件

**目标**: 创建一个记录所有消息的日志插件。

```typescript
// extensions/message-logger/src/index.ts
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'

export default function messageLogger(api: OpenClawPluginApi) {
  api.hooks.on('command:new', async (message) => {
    console.log(`[LOG] ${message.channel}: ${message.text}`)
  })
}
```

---

## 15. 推荐资源

### 15.1 TypeScript & Node.js

| 资源 | 类型 | 说明 |
|------|------|------|
| [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/) | 官方文档 | TypeScript 核心概念 |
| [Node.js 官方文档](https://nodejs.org/docs/latest-v22.x/api/) | 官方文档 | Node.js 22 API |
| [ESM 规范](https://nodejs.org/api/esm.html) | 官方文档 | ESM 模块系统 |

### 15.2 框架与库

| 资源 | 对应技术 |
|------|---------|
| [Commander.js 文档](https://github.com/tj/commander.js) | CLI 构建 |
| [Zod 文档](https://zod.dev/) | Schema 验证 |
| [Vitest 文档](https://vitest.dev/) | 测试框架 |
| [Grammy 文档](https://grammy.dev/) | Telegram Bot |
| [Discord.js 指南](https://discordjs.guide/) | Discord Bot |
| [Lit 文档](https://lit.dev/) | Web Components |

### 15.3 AI/LLM

| 资源 | 说明 |
|------|------|
| [Anthropic API 文档](https://docs.anthropic.com/) | Claude 模型调用 |
| [OpenAI API 文档](https://platform.openai.com/docs/) | GPT 模型调用 |
| [向量数据库入门](https://www.pinecone.io/learn/) | 理解向量检索 |

### 15.4 架构与设计模式

| 资源 | 说明 |
|------|------|
| [Patterns.dev](https://www.patterns.dev/) | 现代 JavaScript 设计模式 |
| [Node.js Design Patterns](https://www.nodejsdesignpatterns.com/) | Node.js 设计模式 |

---

## 附录: 常用命令速查

```bash
# 开发环境
pnpm install              # 安装依赖
pnpm build                # 完整构建
pnpm openclaw --version   # 验证 CLI

# 代码质量
pnpm check                # 类型 + lint + 格式
pnpm format:fix           # 自动格式化
pnpm lint:fix             # 自动修复 lint

# 测试
pnpm test                 # 完整测试
pnpm test:fast            # 快速单元测试
pnpm test:coverage        # 覆盖率报告
pnpm test:watch           # 监听模式

# 开发运行
pnpm openclaw onboard     # 交互式向导
pnpm gateway:dev          # 开发模式网关
pnpm gateway:watch        # 监听模式网关

# Git
scripts/committer "msg" file1 file2  # 作用域提交
```

---

> 本文档基于 OpenClaw v2026.2.25 编写。项目持续演进中，建议配合最新源码阅读。
