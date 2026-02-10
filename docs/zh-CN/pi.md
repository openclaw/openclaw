---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Pi 集成架构（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T07:53:24Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 98b12f1211f70b1a25f58e68c7a4d0fe3827412ca53ba0ea2cd41ac9c0448458（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: pi.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pi 集成架构（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
本文档描述了 OpenClaw 如何与 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 及其相关包（`pi-ai`、`pi-agent-core`、`pi-tui`）集成以实现其 AI 智能体能力。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 概述（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw 使用 pi SDK 将 AI 编码智能体嵌入到其消息 Gateway 网关架构中。OpenClaw 不是将 pi 作为子进程生成或使用 RPC 模式，而是通过 `createAgentSession()` 直接导入并实例化 pi 的 `AgentSession`。这种嵌入式方法提供了：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 对会话生命周期和事件处理的完全控制（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 自定义工具注入（消息、沙箱、渠道特定操作）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 每个渠道/上下文的系统提示自定义（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 支持分支/压缩的会话持久化（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 带故障转移的多账户认证配置文件轮换（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 与提供商无关的模型切换（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 包依赖（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "@mariozechner/pi-agent-core": "0.49.3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "@mariozechner/pi-ai": "0.49.3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "@mariozechner/pi-coding-agent": "0.49.3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "@mariozechner/pi-tui": "0.49.3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 包                | 用途                                                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ------------------------------------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-ai`           | 核心 LLM 抽象：`Model`、`streamSimple`、消息类型、提供商 API                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-agent-core`   | 智能体循环、工具执行、`AgentMessage` 类型                                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-coding-agent` | 高级 SDK：`createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、内置工具 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-tui`          | 终端 UI 组件（用于 OpenClaw 的本地 TUI 模式）                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 文件结构（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
src/agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-runner.ts          # Re-exports from pi-embedded-runner/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-runner/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── run.ts                     # Main entry: runEmbeddedPiAgent()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── run/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   │   ├── attempt.ts             # Single attempt logic with session setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   │   ├── params.ts              # RunEmbeddedPiAgentParams type（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   │   ├── payloads.ts            # Build response payloads from run results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   │   ├── images.ts              # Vision model image injection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   │   └── types.ts               # EmbeddedRunAttemptResult（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── abort.ts                   # Abort error detection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── cache-ttl.ts               # Cache TTL tracking for context pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── compact.ts                 # Manual/auto compaction logic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── extensions.ts              # Load pi extensions for embedded runs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── extra-params.ts            # Provider-specific stream params（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── google.ts                  # Google/Gemini turn ordering fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── history.ts                 # History limiting (DM vs group)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── lanes.ts                   # Session/global command lanes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── logger.ts                  # Subsystem logger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── model.ts                   # Model resolution via ModelRegistry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── runs.ts                    # Active run tracking, abort, queue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── sandbox-info.ts            # Sandbox info for system prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── session-manager-cache.ts   # SessionManager instance caching（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── session-manager-init.ts    # Session file initialization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── system-prompt.ts           # System prompt builder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── tool-split.ts              # Split tools into builtIn vs custom（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── utils.ts                   # ThinkLevel mapping, error description（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-subscribe.ts       # Session event subscription/dispatch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-subscribe.handlers.ts # Event handler factory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-subscribe.handlers.lifecycle.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-subscribe.handlers.types.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-block-chunker.ts   # Streaming block reply chunking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-messaging.ts       # Messaging tool sent tracking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-helpers.ts         # Error classification, turn validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-helpers/           # Helper modules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-embedded-utils.ts           # Formatting utilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-tools.ts                    # createOpenClawCodingTools()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-tools.abort.ts              # AbortSignal wrapping for tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-tools.policy.ts             # Tool allowlist/denylist policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-tools.read.ts               # Read tool customizations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-tools.schema.ts             # Tool schema normalization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-tools.types.ts              # AnyAgentTool type alias（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition adapter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-settings.ts                 # Settings overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── pi-extensions/                 # Custom pi extensions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── compaction-safeguard.ts    # Safeguard extension（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── compaction-safeguard-runtime.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── context-pruning.ts         # Cache-TTL context pruning extension（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── context-pruning/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── model-auth.ts                  # Auth profile resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── auth-profiles.ts               # Profile store, cooldown, failover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── model-selection.ts             # Default model resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── models-config.ts               # models.json generation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── model-catalog.ts               # Model catalog cache（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── context-window-guard.ts        # Context window validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── failover-error.ts              # FailoverError class（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── defaults.ts                    # DEFAULT_PROVIDER, DEFAULT_MODEL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── system-prompt.ts               # buildAgentSystemPrompt()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── system-prompt-params.ts        # System prompt parameter resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── system-prompt-report.ts        # Debug report generation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── tool-summaries.ts              # Tool description summaries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── tool-policy.ts                 # Tool policy resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── transcript-policy.ts           # Transcript validation policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── skills.ts                      # Skill snapshot/prompt building（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── skills/                        # Skill subsystem（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── sandbox.ts                     # Sandbox context resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── sandbox/                       # Sandbox subsystem（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── channel-tools.ts               # Channel-specific tool injection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── openclaw-tools.ts              # OpenClaw-specific tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── bash-tools.ts                  # exec/process tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── apply-patch.ts                 # apply_patch tool (OpenAI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── tools/                         # Individual tool implementations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── browser-tool.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── canvas-tool.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── cron-tool.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── discord-actions*.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── gateway-tool.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── image-tool.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── message-tool.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── nodes-tool.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── session*.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── slack-actions.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── telegram-actions.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── web-*.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── whatsapp-actions.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 核心集成流程（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. 运行嵌入式智能体（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
主入口点是 `pi-embedded-runner/run.ts` 中的 `runEmbeddedPiAgent()`：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { runEmbeddedPiAgent } from "./agents/pi-embedded-runner.js";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const result = await runEmbeddedPiAgent({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionId: "user-123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionKey: "main:whatsapp:+1234567890",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionFile: "/path/to/session.jsonl",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workspaceDir: "/path/to/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  config: openclawConfig,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Hello, how are you?",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: "anthropic",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: "claude-sonnet-4-20250514",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  timeoutMs: 120_000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  runId: "run-abc",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  onBlockReply: async (payload) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    await sendToChannel(payload.text, payload.mediaUrls);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. 会话创建（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
在 `runEmbeddedAttempt()`（由 `runEmbeddedPiAgent()` 调用）内部，使用 pi SDK：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  createAgentSession,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  DefaultResourceLoader,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SessionManager,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SettingsManager,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
} from "@mariozechner/pi-coding-agent";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const resourceLoader = new DefaultResourceLoader({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cwd: resolvedWorkspace,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agentDir,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  settingsManager,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  additionalExtensionPaths,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await resourceLoader.reload();（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const { session } = await createAgentSession({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cwd: resolvedWorkspace,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agentDir,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  authStorage: params.authStorage,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  modelRegistry: params.modelRegistry,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: params.model,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  thinkingLevel: mapThinkingLevel(params.thinkLevel),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: builtInTools,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  customTools: allCustomTools,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionManager,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  settingsManager,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  resourceLoader,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
applySystemPromptOverrideToSession(session, systemPromptOverride);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. 事件订阅（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`subscribeEmbeddedPiSession()` 订阅 pi 的 `AgentSession` 事件：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const subscription = subscribeEmbeddedPiSession({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: activeSession,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  runId: params.runId,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  verboseLevel: params.verboseLevel,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  reasoningMode: params.reasoningLevel,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  toolResultFormat: params.toolResultFormat,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  onToolResult: params.onToolResult,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  onReasoningStream: params.onReasoningStream,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  onBlockReply: params.onBlockReply,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  onPartialReply: params.onPartialReply,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  onAgentEvent: params.onAgentEvent,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
处理的事件包括：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message_start` / `message_end` / `message_update`（流式文本/思考）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `turn_start` / `turn_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent_start` / `agent_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `auto_compaction_start` / `auto_compaction_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4. 提示（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
设置完成后，会话被提示：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await session.prompt(effectivePrompt, { images: imageResult.images });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SDK 处理完整的智能体循环：发送到 LLM、执行工具调用、流式响应。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 工具架构（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 工具管道（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **基础工具**：pi 的 `codingTools`（read、bash、edit、write）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **自定义替换**：OpenClaw 将 bash 替换为 `exec`/`process`，为沙箱自定义 read/edit/write（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **OpenClaw 工具**：消息、浏览器、画布、会话、定时任务、Gateway 网关等（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **渠道工具**：Discord/Telegram/Slack/WhatsApp 特定的操作工具（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **策略过滤**：工具按配置文件、提供商、智能体、群组、沙箱策略过滤（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Schema 规范化**：为 Gemini/OpenAI 的特殊情况清理 Schema（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **AbortSignal 包装**：工具被包装以尊重中止信号（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 工具定义适配器（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pi-agent-core 的 `AgentTool` 与 pi-coding-agent 的 `ToolDefinition` 有不同的 `execute` 签名。`pi-tool-definition-adapter.ts` 中的适配器桥接了这一点：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  return tools.map((tool) => ({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    name: tool.name,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    label: tool.label ?? name,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    description: tool.description ?? "",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    parameters: tool.parameters,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // pi-coding-agent signature differs from pi-agent-core（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      return await tool.execute(toolCallId, params, signal, onUpdate);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }));（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 工具拆分策略（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`splitSdkTools()` 通过 `customTools` 传递所有工具：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  return {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    builtInTools: [], // Empty. We override everything（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    customTools: toToolDefinitions(options.tools),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
这确保 OpenClaw 的策略过滤、沙箱集成和扩展工具集在各提供商之间保持一致。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 系统提示构建（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
系统提示在 `buildAgentSystemPrompt()`（`system-prompt.ts`）中构建。它组装一个完整的提示，包含工具、工具调用风格、安全护栏、OpenClaw CLI 参考、Skills、文档、工作区、沙箱、消息、回复标签、语音、静默回复、心跳、运行时元数据等部分，以及启用时的记忆和反应，还有可选的上下文文件和额外系统提示内容。部分内容在子智能体使用的最小提示模式下会被裁剪。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
提示在会话创建后通过 `applySystemPromptOverrideToSession()` 应用：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const systemPromptOverride = createSystemPromptOverride(appendPrompt);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
applySystemPromptOverrideToSession(session, systemPromptOverride);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 会话管理（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 会话文件（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
会话是具有树结构（id/parentId 链接）的 JSONL 文件。Pi 的 `SessionManager` 处理持久化：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const sessionManager = SessionManager.open(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw 用 `guardSessionManager()` 包装它以确保工具结果安全。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 会话缓存（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`session-manager-cache.ts` 缓存 SessionManager 实例以避免重复的文件解析：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await prewarmSessionFile(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessionManager = SessionManager.open(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
trackSessionManagerAccess(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 历史限制（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`limitHistoryTurns()` 根据渠道类型（私信 vs 群组）裁剪对话历史。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 压缩（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
自动压缩在上下文溢出时触发。`compactEmbeddedPiSessionDirect()` 处理手动压缩：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const compactResult = await compactEmbeddedPiSessionDirect({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionId, sessionFile, provider, model, ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 认证与模型解析（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 认证配置文件（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw 维护一个认证配置文件存储，每个提供商有多个 API 密钥：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
配置文件在失败时轮换，并带有冷却跟踪：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const rotated = await advanceAuthProfile();（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 模型解析（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { resolveModel } from "./pi-embedded-runner/model.js";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const { model, error, authStorage, modelRegistry } = resolveModel(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  modelId,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agentDir,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  config,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Uses pi's ModelRegistry and AuthStorage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 故障转移（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`FailoverError` 在配置了回退时触发模型回退：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if (fallbackConfigured && isFailoverErrorMessage(errorText)) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  throw new FailoverError(errorText, {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reason: promptFailoverReason ?? "unknown",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    provider,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: modelId,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profileId,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status: resolveFailoverStatus(promptFailoverReason),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pi 扩展（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw 加载自定义 pi 扩展以实现特殊行为：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 压缩安全护栏（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`pi-extensions/compaction-safeguard.ts` 为压缩添加护栏，包括自适应令牌预算以及工具失败和文件操作摘要：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if (resolveCompactionMode(params.cfg) === "safeguard") {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  paths.push(resolvePiExtensionPath("compaction-safeguard"));（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 上下文裁剪（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`pi-extensions/context-pruning.ts` 实现基于缓存 TTL 的上下文裁剪：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  setContextPruningRuntime(params.sessionManager, {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    settings,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    contextWindowTokens,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    isToolPrunable,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    lastCacheTouchAt,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  paths.push(resolvePiExtensionPath("context-pruning"));（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 流式传输与块回复（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 块分块（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`EmbeddedBlockChunker` 管理将流式文本分成离散的回复块：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 思考/最终标签剥离（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
流式输出被处理以剥离 `<think>`/`<thinking>` 块并提取 `<final>` 内容：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Strip <think>...</think> content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // If enforceFinalTag, only return <final>...</final> content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 回复指令（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
回复指令如 `[[media:url]]`、`[[voice]]`、`[[reply:id]]` 被解析和提取：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 错误处理（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 错误分类（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`pi-embedded-helpers.ts` 对错误进行分类以进行适当处理：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
isContextOverflowError(errorText)     // Context too large（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
isCompactionFailureError(errorText)   // Compaction failed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
isAuthAssistantError(lastAssistant)   // Auth failure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
isRateLimitAssistantError(...)        // Rate limited（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
isFailoverAssistantError(...)         // Should failover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 思考级别回退（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
如果思考级别不受支持，它会回退：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const fallbackThinking = pickFallbackThinkingLevel({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  message: errorText,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  attempted: attemptedThinking,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if (fallbackThinking) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  thinkLevel = fallbackThinking;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  continue;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 沙箱集成（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
当启用沙箱模式时，工具和路径受到约束：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const sandbox = await resolveSandboxContext({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  config: params.config,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionKey: sandboxSessionKey,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workspaceDir: resolvedWorkspace,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if (sandboxRoot) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Use sandboxed read/edit/write tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Exec runs in container（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Browser uses bridge URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 提供商特定处理（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 拒绝魔术字符串清除（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 连续角色的回合验证（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Claude Code 参数兼容性（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Google/Gemini（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 回合排序修复（`applyGoogleTurnOrderingFix`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 工具 schema 清理（`sanitizeToolsForGoogle`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 会话历史清理（`sanitizeSessionHistory`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenAI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Codex 模型的 `apply_patch` 工具（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 思考级别降级处理（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TUI 集成（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw 还有一个本地 TUI 模式，直接使用 pi-tui 组件：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// src/tui/tui.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { ... } from "@mariozechner/pi-tui";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
这提供了与 pi 原生模式类似的交互式终端体验。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 与 Pi CLI 的主要区别（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 方面     | Pi CLI                  | OpenClaw 嵌入式                                                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------- | ----------------------- | ----------------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 调用方式 | `pi` 命令 / RPC         | 通过 `createAgentSession()` 的 SDK                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 工具     | 默认编码工具            | 自定义 OpenClaw 工具套件                                                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 系统提示 | AGENTS.md + prompts     | 按渠道/上下文动态生成                                                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 会话存储 | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/`（或 `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`） |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 认证     | 单一凭证                | 带轮换的多配置文件                                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 扩展     | 从磁盘加载              | 编程方式 + 磁盘路径                                                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 事件处理 | TUI 渲染                | 基于回调（onBlockReply 等）                                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 未来考虑（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
可能需要重构的领域：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **工具签名对齐**：目前在 pi-agent-core 和 pi-coding-agent 签名之间适配（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **会话管理器包装**：`guardSessionManager` 增加了安全性但增加了复杂性（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **扩展加载**：可以更直接地使用 pi 的 `ResourceLoader`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **流式处理器复杂性**：`subscribeEmbeddedPiSession` 已经变得很大（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **提供商特殊情况**：许多提供商特定的代码路径，pi 可能可以处理（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 测试（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
所有涵盖 pi 集成及其扩展的现有测试：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-block-chunker.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.buildbootstrapcontextfiles.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.classifyfailoverreason.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.downgradeopenai-reasoning.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.formatassistanterrortext.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.formatrawassistanterrorforui.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.image-dimension-error.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.image-size-error.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.isautherrormessage.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.isbillingerrormessage.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.iscloudcodeassistformaterror.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.iscompactionfailureerror.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.iscontextoverflowerror.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.isfailovererrormessage.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.islikelycontextoverflowerror.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.ismessagingtoolduplicate.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.messaging-duplicate.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.normalizetextforcomparison.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.resolvebootstrapmaxchars.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.keeps-tool-call-tool-result-ids-unchanged.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.removes-empty-assistant-text-blocks-but-preserves.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.sanitizegoogleturnordering.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.sanitizesessionmessagesimages-thought-signature-stripping.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.sanitizetoolcallid.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.sanitizeuserfacingtext.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.stripthoughtsignatures.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-helpers.validate-turns.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner-extraparams.live.test.ts`（实时）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner-extraparams.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.applygoogleturnorderingfix.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.buildembeddedsandboxinfo.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.createsystempromptoverride.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.falls-back-provider-default-per-dm-not.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.returns-undefined-sessionkey-is-undefined.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.google-sanitize-thinking.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.guard.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.limithistoryturns.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.resolvesessionagentids.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.sanitize-session-history.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.splitsdktools.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-runner.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.code-span-awareness.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.reply-tags.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.calls-onblockreplyflush-before-tool-execution-start-preserve.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-append-text-end-content-is.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-call-onblockreplyflush-callback-is-not.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-emit-duplicate-block-replies-text.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-block-replies-text-end-does-not.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.filters-final-suppresses-output-without-start-tag.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.includes-canvas-action-metadata-tool-summaries.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-indented-fenced-blocks-intact.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.reopens-fenced-blocks-splitting-inside-them.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.splits-long-single-line-fenced-blocks-reopen.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.streams-soft-chunks-paragraph-preference.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.suppresses-message-end-block-replies-message-tool.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.waits-multiple-compaction-retries-before-resolving.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-subscribe.tools.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-utils.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-extensions/compaction-safeguard.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-extensions/context-pruning.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-settings.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tool-definition-adapter.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools-agent-config.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-b.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-d.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-f.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools.policy.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools.safe-bins.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools.workspace-paths.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
