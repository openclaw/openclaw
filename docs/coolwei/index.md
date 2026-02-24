# OpenClaw 技术架构概览

OpenClaw 是一个用 TypeScript (ESM) 编写的自托管个人 AI 助手平台，运行在 Node.js 22+ 上，支持多平台部署。整体采用 pnpm monorepo 架构。

## 技术栈

- 语言：TypeScript 5.9+（ESM）
- 运行时：Node.js 22+，Bun 可选
- 包管理：pnpm 10.23.0
- 构建：tsdown（TS 打包）、Vite（UI 构建）
- 代码质量：Oxlint / Oxfmt（lint 和格式化）
- 测试：Vitest + V8 coverage（70% 阈值）
- 部署：Docker（Node 22-bookworm）、原生应用、云平台

## 核心模块（src/）

| 模块        | 路径                              | 职责                                                  |
| ----------- | --------------------------------- | ----------------------------------------------------- |
| CLI         | `src/cli/`, `src/commands/`       | 命令行入口，profile 支持，respawn 策略                |
| Gateway     | `src/gateway/`                    | 中央控制面，管理频道连接、认证、限流、助手身份        |
| 频道        | `src/channels/`, `src/routing/`   | 消息路由与分发，allowlist，ack reactions              |
| AI Provider | `src/providers/`                  | 对接多种模型（OpenAI、Anthropic、Bedrock、Ollama 等） |
| Agent       | `src/agents/`                     | 多 Agent 编排与执行                                   |
| 插件系统    | `src/plugins/`, `src/plugin-sdk/` | 插件发现、加载、hooks 生命周期，对外暴露 SDK          |
| 配置        | `src/config/`                     | YAML + Zod schema 校验，环境变量替换，legacy 迁移     |
| 媒体        | `src/media/`                      | 音频/图片/视频处理管线                                |
| Web         | `src/web/`                        | HTTP API 和 Web Provider                              |
| Session     | `src/sessions/`, `src/memory/`    | 会话管理、压缩、上下文记忆                            |
| 安全        | `src/security/`                   | 认证、限流、allowlist                                 |
| 终端 UI     | `src/terminal/`                   | TUI 工具、表格渲染、调色板                            |

## 内置频道

支持 20+ 消息频道，核心内置：

- WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Line

## 插件/扩展系统（extensions/）

30+ 扩展插件，按类型分为：

- 消息频道扩展：MS Teams、Matrix、Mattermost、Google Chat、飞书、Twitch、IRC、Zalo、Nostr 等
- AI/LLM 扩展：Copilot Proxy、Google Gemini CLI Auth、Minimax、Qwen 等
- 功能扩展：memory-core、memory-lancedb、voice-call、lobster、device-pair、diagnostics-otel 等

插件架构要点：

- 每个插件是独立的 workspace package
- 运行时依赖放 `dependencies`，核心依赖放 `devDependencies` / `peerDependencies`
- 通过 jiti alias（`openclaw/plugin-sdk`）加载
- 支持 hooks 生命周期（before-agent-start、model-override 等）

## Web UI（ui/）

- 框架：Lit（Web Components）+ Signals 状态管理
- 构建：Vite 7.3
- 包含：控制面板、webchat、TUI 界面
- 支持 i18n 多语言

## 原生应用（apps/）

| 平台    | 技术               | 说明                                    |
| ------- | ------------------ | --------------------------------------- |
| macOS   | SwiftUI            | menubar 集成、Sparkle 自动更新、launchd |
| iOS     | SwiftUI + WatchKit | 含 Share Extension、Fastlane CI/CD      |
| Android | Kotlin + Gradle    | 原生构建                                |
| 共享层  | OpenClawKit        | 跨平台共享框架                          |

## AI Provider 支持

OpenAI、Anthropic、Bedrock、GitHub Copilot、Ollama、LiteLLM、OpenRouter、Together、Mistral、Qwen、GLM、Moonshot、Minimax、Hugging Face、NVIDIA、Vercel AI Gateway、Cloudflare AI Gateway 等。

## 部署架构

- Docker：Node 22-bookworm 基础镜像，可选 Chromium/Xvfb（浏览器自动化），非 root 运行
- macOS：原生 menubar app
- iOS / Android：原生应用
- Linux：systemd user service
- Windows：WSL2
- 云平台：Fly.io、Railway、Render、Northflank、GCP、Hetzner、DigitalOcean、Oracle

## 架构图

```
┌─────────────────────────────────────────────────┐
│                   Chat Apps                      │
│  WhatsApp / Telegram / Discord / Slack / ...     │
└──────────────────────┬──────────────────────────┘
                       │
              ┌────────▼────────┐
              │    Gateway      │  ← 中央控制面
              │  认证/限流/路由  │
              └───┬────┬────┬───┘
                  │    │    │
```

        ┌─────┘    │    └─────┐
        │          │          │

┌─────▼───┐ ┌───▼───┐ ┌───▼─────┐
│ Agent │ │ CLI │ │ Web UI │
│ 编排执行 │ │ 命令行 │ │ 控制面板 │
└─────┬───┘ └───────┘ └─────────┘
│
┌─────▼──────────┐
│ AI Providers │
│ OpenAI/Anthropic│
│ Bedrock/Ollama │
└────────────────┘

````

## 关键设计模式

- 依赖注入：`createDefaultDeps()` 模式，便于测试
- 插件 Hooks：生命周期钩子实现扩展性
- 配置组合：merge-patch + 环境变量替换
- Session Key 归一化：account ID 标准化路由
- 文件锁：原子化 JSON store 写入
- 限流：基于 IP 的认证限流，可配置作用域
- 多 Agent：Agent bindings + 频道级路由

## 构建与开发命令

```bash
pnpm install          # 安装依赖
pnpm build            # 完整构建（含插件 SDK、UI、Canvas）
pnpm dev              # 开发模式
pnpm test             # 运行测试
pnpm test:coverage    # 测试覆盖率
pnpm check            # 格式化 + 类型检查 + lint
pnpm ui:dev           # Web UI 开发模式
pnpm gateway:dev      # Gateway 开发模式
````
