---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Pi Integration Architecture"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pi Integration Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document describes how OpenClaw integrates with [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) and its sibling packages (`pi-ai`, `pi-agent-core`, `pi-tui`) to power its AI agent capabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses the pi SDK to embed an AI coding agent into its messaging gateway architecture. Instead of spawning pi as a subprocess or using RPC mode, OpenClaw directly imports and instantiates pi's `AgentSession` via `createAgentSession()`. This embedded approach provides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full control over session lifecycle and event handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Custom tool injection (messaging, sandbox, channel-specific actions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System prompt customization per channel/context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session persistence with branching/compaction support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-account auth profile rotation with failover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider-agnostic model switching（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Package Dependencies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
| Package           | Purpose                                                                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ------------------------------------------------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-ai`           | Core LLM abstractions: `Model`, `streamSimple`, message types, provider APIs                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-agent-core`   | Agent loop, tool execution, `AgentMessage` types                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-coding-agent` | High-level SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, built-in tools |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pi-tui`          | Terminal UI components (used in OpenClaw's local TUI mode)                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Core Integration Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Running an Embedded Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The main entry point is `runEmbeddedPiAgent()` in `pi-embedded-runner/run.ts`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
### 2. Session Creation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inside `runEmbeddedAttempt()` (called by `runEmbeddedPiAgent()`), the pi SDK is used:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
### 3. Event Subscription（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`subscribeEmbeddedPiSession()` subscribes to pi's `AgentSession` events:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
Events handled include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message_start` / `message_end` / `message_update` (streaming text/thinking)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `turn_start` / `turn_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent_start` / `agent_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `auto_compaction_start` / `auto_compaction_end`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4. Prompting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After setup, the session is prompted:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await session.prompt(effectivePrompt, { images: imageResult.images });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The SDK handles the full agent loop: sending to LLM, executing tool calls, streaming responses.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool Pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Base Tools**: pi's `codingTools` (read, bash, edit, write)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Custom Replacements**: OpenClaw replaces bash with `exec`/`process`, customizes read/edit/write for sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **OpenClaw Tools**: messaging, browser, canvas, sessions, cron, gateway, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Channel Tools**: Discord/Telegram/Slack/WhatsApp-specific action tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Policy Filtering**: Tools filtered by profile, provider, agent, group, sandbox policies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Schema Normalization**: Schemas cleaned for Gemini/OpenAI quirks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **AbortSignal Wrapping**: Tools wrapped to respect abort signals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool Definition Adapter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pi-agent-core's `AgentTool` has a different `execute` signature than pi-coding-agent's `ToolDefinition`. The adapter in `pi-tool-definition-adapter.ts` bridges this:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
### Tool Split Strategy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`splitSdkTools()` passes all tools via `customTools`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
This ensures OpenClaw's policy filtering, sandbox integration, and extended toolset remain consistent across providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System Prompt Construction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The system prompt is built in `buildAgentSystemPrompt()` (`system-prompt.ts`). It assembles a full prompt with sections including Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI reference, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata, plus Memory and Reactions when enabled, and optional context files and extra system prompt content. Sections are trimmed for minimal prompt mode used by subagents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The prompt is applied after session creation via `applySystemPromptOverrideToSession()`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const systemPromptOverride = createSystemPromptOverride(appendPrompt);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
applySystemPromptOverrideToSession(session, systemPromptOverride);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sessions are JSONL files with tree structure (id/parentId linking). Pi's `SessionManager` handles persistence:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const sessionManager = SessionManager.open(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw wraps this with `guardSessionManager()` for tool result safety.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Caching（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`session-manager-cache.ts` caches SessionManager instances to avoid repeated file parsing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await prewarmSessionFile(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessionManager = SessionManager.open(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
trackSessionManagerAccess(params.sessionFile);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### History Limiting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`limitHistoryTurns()` trims conversation history based on channel type (DM vs group).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Compaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auto-compaction triggers on context overflow. `compactEmbeddedPiSessionDirect()` handles manual compaction:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const compactResult = await compactEmbeddedPiSessionDirect({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionId, sessionFile, provider, model, ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authentication & Model Resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Auth Profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw maintains an auth profile store with multiple API keys per provider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profiles rotate on failures with cooldown tracking:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const rotated = await advanceAuthProfile();（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Model Resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
### Failover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`FailoverError` triggers model fallback when configured:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Pi Extensions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw loads custom pi extensions for specialized behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Compaction Safeguard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`pi-extensions/compaction-safeguard.ts` adds guardrails to compaction, including adaptive token budgeting plus tool failure and file operation summaries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if (resolveCompactionMode(params.cfg) === "safeguard") {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  paths.push(resolvePiExtensionPath("compaction-safeguard"));（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Context Pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`pi-extensions/context-pruning.ts` implements cache-TTL based context pruning:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Streaming & Block Replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Block Chunking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`EmbeddedBlockChunker` manages streaming text into discrete reply blocks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Thinking/Final Tag Stripping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Streaming output is processed to strip `<think>`/`<thinking>` blocks and extract `<final>` content:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Strip <think>...</think> content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // If enforceFinalTag, only return <final>...</final> content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reply Directives（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reply directives like `[[media:url]]`, `[[voice]]`, `[[reply:id]]` are parsed and extracted:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Classification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`pi-embedded-helpers.ts` classifies errors for appropriate handling:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
### Thinking Level Fallback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a thinking level is unsupported, it falls back:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Sandbox Integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When sandbox mode is enabled, tools and paths are constrained:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Provider-Specific Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Refusal magic string scrubbing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn validation for consecutive roles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Claude Code parameter compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Google/Gemini（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn ordering fixes (`applyGoogleTurnOrderingFix`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool schema sanitization (`sanitizeToolsForGoogle`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session history sanitization (`sanitizeSessionHistory`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenAI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apply_patch` tool for Codex models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thinking level downgrade handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TUI Integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw also has a local TUI mode that uses pi-tui components directly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// src/tui/tui.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { ... } from "@mariozechner/pi-tui";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This provides the interactive terminal experience similar to pi's native mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key Differences from Pi CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Aspect          | Pi CLI                  | OpenClaw Embedded                                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Invocation      | `pi` command / RPC      | SDK via `createAgentSession()`                                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Tools           | Default coding tools    | Custom OpenClaw tool suite                                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| System prompt   | AGENTS.md + prompts     | Dynamic per-channel/context                                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Session storage | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/` (or `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Auth            | Single credential       | Multi-profile with rotation                                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Extensions      | Loaded from disk        | Programmatic + disk paths                                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Event handling  | TUI rendering           | Callback-based (onBlockReply, etc.)                                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Future Considerations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Areas for potential rework:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Tool signature alignment**: Currently adapting between pi-agent-core and pi-coding-agent signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Session manager wrapping**: `guardSessionManager` adds safety but increases complexity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Extension loading**: Could use pi's `ResourceLoader` more directly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Streaming handler complexity**: `subscribeEmbeddedPiSession` has grown large（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Provider quirks**: Many provider-specific codepaths that pi could potentially handle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All existing tests that cover the pi integration and its extensions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (live)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
