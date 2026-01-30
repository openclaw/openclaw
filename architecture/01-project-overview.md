# Moltbot 项目架构总览

## 一句话介绍

Moltbot 是一个**多渠道 AI 聊天机器人网关**：它把 Telegram、Discord、Slack、Signal、WhatsApp、iMessage 等 15+ 个聊天平台统一接入，通过一个中心网关把用户消息路由到 AI 大模型（Claude、GPT、Gemini 等），并将 AI 的回复送回对应的聊天平台。

---

## 项目顶层目录结构

```
moltbot/
├── src/                  # 核心源码（TypeScript ESM）
│   ├── agents/           # AI Agent 引擎：模型调用、工具执行、流式响应
│   ├── auto-reply/       # 消息处理管线：入站处理 → AI 调用 → 回复生成
│   ├── gateway/          # 网关服务器：WebSocket + HTTP，协调所有子系统
│   ├── channels/         # 渠道抽象层：统一接口、权限、线程、提及
│   ├── routing/          # 消息路由：决定消息由哪个 Agent/Session 处理
│   ├── config/           # 配置系统：JSON5 配置文件 + Zod 校验
│   ├── plugins/          # 插件系统：加载、注册、生命周期
│   ├── plugin-sdk/       # 插件 SDK：供扩展开发者使用的统一导出
│   ├── cli/              # 命令行界面：Commander.js 命令注册
│   ├── commands/         # CLI 命令实现
│   ├── infra/            # 基础设施：用量统计、执行审批、设备配对
│   ├── media/            # 媒体管线：下载、缓存、图片处理
│   ├── memory/           # 向量记忆：嵌入、索引、语义搜索
│   ├── browser/          # 浏览器自动化：Playwright/CDP
│   ├── telegram/         # Telegram 渠道实现
│   ├── discord/          # Discord 渠道实现
│   ├── slack/            # Slack 渠道实现
│   ├── signal/           # Signal 渠道实现
│   ├── imessage/         # iMessage 渠道实现
│   ├── web/              # Web/WhatsApp Web 渠道
│   ├── terminal/         # 终端 UI：表格、调色板、进度条
│   ├── sessions/         # 会话级配置覆盖
│   ├── security/         # 安全策略
│   ├── hooks/            # 用户自定义钩子
│   ├── cron/             # 定时任务
│   └── ...
├── extensions/           # 插件扩展（独立 workspace 包）
│   ├── matrix/           # Matrix 协议
│   ├── msteams/          # Microsoft Teams
│   ├── googlechat/       # Google Chat
│   ├── voice-call/       # 语音通话
│   ├── memory-core/      # 向量数据库记忆
│   ├── lobster/          # 私有 LLM
│   └── ...（30+ 个扩展）
├── apps/                 # 平台原生应用
│   ├── ios/              # iOS 应用（Swift）
│   ├── android/          # Android 应用（Kotlin）
│   ├── macos/            # macOS 菜单栏应用（SwiftUI）
│   └── shared/           # 跨平台共享代码
├── ui/                   # Web 控制面板（Vite + React）
├── docs/                 # 文档（Mintlify 托管）
├── scripts/              # 构建和运维脚本
├── skills/               # Agent 技能/指令
├── packages/             # NPM workspace 子包
├── patches/              # pnpm 补丁
└── vendor/               # 第三方依赖
```

---

## 核心架构理念

### 1. 网关中心化
所有消息都经过**网关服务器**（Gateway Server）。网关负责：
- 启动和管理各渠道的连接
- 接收入站消息并路由到正确的 Agent
- 将 Agent 的回复发送回正确的渠道

### 2. 渠道即插件
每个聊天平台（Telegram、Discord 等）都实现了统一的 `ChannelPlugin` 接口。核心渠道和扩展渠道使用相同的插件 API，区别只是核心渠道在 `src/` 里，扩展在 `extensions/` 里。

### 3. Agent 引擎与渠道解耦
AI Agent 引擎不关心消息来自哪个平台。它只需要：
- 一段用户文本（可能附带图片）
- 一组可用工具
- 一个会话历史

Agent 生成回复后，由路由和渠道层负责投递。

### 4. 多模型支持
不绑定单一 AI 提供商。通过配置可以在 Anthropic（Claude）、OpenAI（GPT）、Google（Gemini）、AWS Bedrock 等之间切换，并支持自动降级和故障转移。

---

## 技术栈

| 层面 | 技术选型 |
|------|---------|
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js 22+ / Bun |
| 包管理 | pnpm (workspace) |
| 构建 | tsc |
| Lint/Format | Oxlint + Oxfmt |
| 测试 | Vitest + V8 覆盖率 |
| CLI 框架 | Commander.js |
| 配置格式 | JSON5 + Zod 校验 |
| 网关通信 | WebSocket |
| 移动端 | Swift (iOS/macOS) / Kotlin (Android) |
| 文档托管 | Mintlify |

---

## 关键数据流（一图看懂）

```
用户在 Telegram 发消息 "帮我搜一下天气"
         │
         ▼
┌─────────────────┐
│  Telegram Bot    │  ← 渠道层：接收 webhook/轮询
│  (bot-handlers)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  消息路由        │  ← 路由层：确定哪个 Agent、哪个 Session
│  (resolve-route) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent 引擎      │  ← 核心：构建 Prompt → 调用 LLM → 执行工具 → 流式响应
│  (pi-embedded-   │
│   runner)        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  LLM API        │  ← 外部：Claude / GPT / Gemini
│  (Anthropic等)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  回复投递        │  ← 出站层：格式化 + 分块 + 发送回 Telegram
│  (outbound)      │
└─────────────────┘
```

---

## 下一步阅读

- [02-module-details.md](./02-module-details.md) — 各模块详细说明
- [03-agent-llm-interaction.md](./03-agent-llm-interaction.md) — Agent 调度与大模型交互流程
- [04-detailed-design.md](./04-detailed-design.md) — 详细设计文档
