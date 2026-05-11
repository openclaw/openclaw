---
summary: "Architecture of OpenClaw's embedded agent runtime and SQLite-backed session lifecycle"
title: "Embedded agent runtime architecture"
read_when:
  - Understanding OpenClaw embedded agent runtime design
  - Modifying agent session lifecycle, tooling, provider wiring, or transcript storage
  - Auditing the internal pi-coding-agent dependency boundary
---

OpenClaw owns the embedded agent runtime. It still imports selected
[pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
packages for agent-loop, provider, and TUI primitives, but runtime identity,
prompts, tools, auth selection, session state, transcripts, diagnostics, and
persistence are OpenClaw-owned.

## Overview

OpenClaw embeds the agent loop in-process instead of spawning an external CLI or
using RPC mode. The current implementation constructs the upstream
`AgentSession` through a narrow contract module, then supplies OpenClaw-owned
runtime surfaces around it:

- SQLite-backed session and transcript persistence
- OpenClaw tool injection for messaging, sandboxing, VFS, browser, cron, gateway,
  and channel actions
- OpenClaw system prompt construction per channel, workspace, and context
- Multi-account auth profile rotation with failover
- Provider-agnostic model switching
- Event subscription, streaming, diagnostics, and compaction policy

Legacy JSON, JSONL, and transcript files are doctor migration inputs only. The
runtime never chooses a transcript file, derives a transcript locator, or writes
session JSONL.

## External package boundary

```json
{
  "@mariozechner/pi-agent-core": "0.73.1",
  "@mariozechner/pi-ai": "0.73.1",
  "@mariozechner/pi-coding-agent": "0.73.1",
  "@mariozechner/pi-tui": "0.73.1"
}
```

OpenClaw treats these as implementation dependencies, not as owners of
OpenClaw runtime state.

| Package           | OpenClaw use                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `pi-ai`           | LLM abstractions: `Model`, `streamSimple`, message types, provider APIs             |
| `pi-agent-core`   | Agent loop, tool execution, `AgentMessage` types                                    |
| `pi-coding-agent` | Narrow SDK entry: `createAgentSession`, `AuthStorage`, `ModelRegistry`, tool shapes |
| `pi-tui`          | Terminal UI primitives for OpenClaw's local TUI mode                                |

## File structure

Several file names still include `pi` because they started as the integration
layer. Treat them as OpenClaw runtime modules unless the code explicitly imports
an upstream package boundary.

```
src/agents/
├── pi-embedded-runner.ts          # Re-exports from pi-embedded-runner/
├── pi-embedded-runner/
│   ├── run.ts                     # Main entry: runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # Single attempt logic with session setup
│   │   ├── params.ts              # RunEmbeddedPiAgentParams type
│   │   ├── payloads.ts            # Build response payloads from run results
│   │   ├── images.ts              # Vision model image injection
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # Abort error detection
│   ├── cache-ttl.ts               # Cache TTL tracking for context pruning
│   ├── compact.ts                 # Manual/auto compaction logic
│   ├── extensions.ts              # Load pi extensions for embedded runs
│   ├── extra-params.ts            # Provider-specific stream params
│   ├── google.ts                  # Google/Gemini turn ordering fixes
│   ├── history.ts                 # History limiting (DM vs group)
│   ├── lanes.ts                   # Session/global command lanes
│   ├── logger.ts                  # Subsystem logger
│   ├── model.ts                   # Model resolution via ModelRegistry
│   ├── runs.ts                    # Active run tracking, abort, queue
│   ├── sandbox-info.ts            # Sandbox info for system prompt
│   ├── system-prompt.ts           # System prompt builder
│   ├── tool-split.ts              # Split tools into builtIn vs custom
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel mapping, error description
├── transcript/
│   ├── session-transcript-contract.ts # OpenClaw-owned transcript/session types
│   ├── session-manager.ts         # OpenClaw-owned SQLite transcript writer
│   └── transcript-state.ts        # SQLite-backed transcript state adapter
├── pi-embedded-subscribe.ts       # Session event subscription/dispatch
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # Event handler factory
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # Streaming block reply chunking
├── pi-embedded-messaging.ts       # Messaging tool sent tracking
├── pi-embedded-helpers.ts         # Error classification, turn validation
├── pi-embedded-helpers/           # Helper modules
├── pi-embedded-utils.ts           # Formatting utilities
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # AbortSignal wrapping for tools
├── pi-tools.policy.ts             # Tool allowlist/denylist policy
├── pi-tools.read.ts               # Read tool customizations
├── pi-tools.schema.ts             # Tool schema normalization
├── pi-tools.types.ts              # AnyAgentTool type alias
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition adapter
├── pi-settings.ts                 # Settings overrides
├── pi-hooks/                      # Custom pi hooks
│   ├── compaction-safeguard.ts    # Safeguard extension
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # Cache-TTL context pruning extension
│   └── context-pruning/
├── model-auth.ts                  # Auth profile resolution
├── auth-profiles.ts               # Profile store, cooldown, failover
├── model-selection.ts             # Default model resolution
├── models-config.ts               # SQLite model catalog materialization
├── model-catalog.ts               # Model catalog cache
├── context-window-guard.ts        # Context window validation
├── failover-error.ts              # FailoverError class
├── defaults.ts                    # DEFAULT_PROVIDER, DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # System prompt parameter resolution
├── system-prompt-report.ts        # Debug report generation
├── tool-summaries.ts              # Tool description summaries
├── tool-policy.ts                 # Tool policy resolution
├── transcript-policy.ts           # Transcript validation policy
├── skills.ts                      # Skill snapshot/prompt building
├── skills/                        # Skill subsystem
├── sandbox.ts                     # Sandbox context resolution
├── sandbox/                       # Sandbox subsystem
├── channel-tools.ts               # Channel-specific tool injection
├── openclaw-tools.ts              # OpenClaw-specific tools
├── bash-tools.ts                  # exec/process tools
├── apply-patch.ts                 # apply_patch tool (OpenAI)
├── tools/                         # Individual tool implementations
│   ├── browser-tool.ts
│   ├── canvas-tool.ts
│   ├── cron-tool.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── web-*.ts
│   └── ...
└── ...
```

Channel-specific message action runtimes now live in the plugin-owned extension
directories instead of under `src/agents/tools`, for example:

- the Discord plugin action runtime files
- the Slack plugin action runtime file
- the Telegram plugin action runtime file
- the WhatsApp plugin action runtime file

## Core integration flow

### 1. Running an Embedded Agent

The main entry point is still named `runEmbeddedPiAgent()` in
`pi-embedded-runner/run.ts`. It runs an OpenClaw-owned embedded session:

```typescript
import { runEmbeddedPiAgent } from "./agents/pi-embedded-runner.js";

const result = await runEmbeddedPiAgent({
  agentId: "main",
  sessionId: "user-123",
  sessionKey: "main:whatsapp:+1234567890",
  workspaceDir: "/path/to/workspace",
  config: openclawConfig,
  prompt: "Hello, how are you?",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  timeoutMs: 120_000,
  runId: "run-abc",
  onBlockReply: async (payload) => {
    await sendToChannel(payload.text, payload.mediaUrls);
  },
});
```

### 2. Session creation

Inside `runEmbeddedAttempt()` (called by `runEmbeddedPiAgent()`), OpenClaw
creates the upstream session with OpenClaw-owned managers, tools, prompts, auth,
and persistence:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const resourceLoader = new DefaultResourceLoader({
  cwd: resolvedWorkspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths,
});
await resourceLoader.reload();

const sessionManager = openTranscriptSessionManagerForSession({
  agentId: params.agentId,
  sessionId: params.sessionId,
});

const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  authStorage: params.authStorage,
  modelRegistry: params.modelRegistry,
  model: params.model,
  thinkingLevel: mapThinkingLevel(params.thinkLevel),
  tools: builtInTools,
  customTools: allCustomTools,
  sessionManager,
  settingsManager,
  resourceLoader,
});

applySystemPromptOverrideToSession(session, systemPromptOverride);
```

### 3. Event subscription

`subscribeEmbeddedPiSession()` subscribes to upstream `AgentSession` events and
translates them into OpenClaw callbacks, transcript writes, and streaming reply
blocks:

```typescript
const subscription = subscribeEmbeddedPiSession({
  session: activeSession,
  runId: params.runId,
  verboseLevel: params.verboseLevel,
  reasoningMode: params.reasoningLevel,
  toolResultFormat: params.toolResultFormat,
  onToolResult: params.onToolResult,
  onReasoningStream: params.onReasoningStream,
  onBlockReply: params.onBlockReply,
  onPartialReply: params.onPartialReply,
  onAgentEvent: params.onAgentEvent,
});
```

Events handled include:

- `message_start` / `message_end` / `message_update` (streaming text/thinking)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `compaction_start` / `compaction_end`

### 4. Prompting

After setup, the session is prompted:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

The SDK handles the full agent loop: sending to LLM, executing tool calls, streaming responses.

Image injection is prompt-local: OpenClaw loads image refs from the current prompt and
passes them via `images` for that turn only. It does not re-scan older history turns
to re-inject image payloads.

## Tool architecture

### Tool pipeline

1. **Upstream shapes**: OpenClaw adapts upstream tool definitions where needed
2. **Custom replacements**: OpenClaw replaces bash with `exec`/`process` and
   customizes read/edit/write for sandbox and VFS behavior
3. **OpenClaw tools**: messaging, browser, canvas, sessions, cron, gateway, and
   other runtime tools
4. **Channel tools**: Discord/Telegram/Slack/WhatsApp-specific action tools
5. **Policy filtering**: tools filtered by profile, provider, agent, group, and
   sandbox policy
6. **Schema normalization**: schemas cleaned for Gemini/OpenAI quirks
7. **AbortSignal wrapping**: tools wrapped to respect abort signals

### Tool definition adapter

`pi-agent-core`'s `AgentTool` has a different `execute` signature than
`pi-coding-agent`'s `ToolDefinition`. The adapter in
`pi-tool-definition-adapter.ts` keeps that nullable/signature detail at one
boundary:

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // Upstream pi-coding-agent signature differs from pi-agent-core.
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### Tool split strategy

`splitSdkTools()` passes all tools via `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

This ensures OpenClaw's policy filtering, sandbox integration, and extended toolset remain consistent across providers.

## System prompt construction

The system prompt is built in `buildAgentSystemPrompt()` (`system-prompt.ts`). It assembles a full prompt with sections including Tooling, Tool Call Style, Safety guardrails, OpenClaw Control, Skills, Docs, Workspace, Sandbox, Messaging, Assistant Output Directives, Voice, Silent Replies, Heartbeats, Runtime metadata, plus Memory and Reactions when enabled, and optional context files and extra system prompt content. Sections are trimmed for minimal prompt mode used by subagents.

The prompt is applied after session creation via `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Session management

### Session transcripts

Sessions are SQLite-backed event streams with tree structure (id/parentId linking). JSONL is legacy doctor-import input only; OpenClaw runtime code does not create, select, or bridge through transcript files or locators. OpenClaw owns the transcript writer behind `src/agents/transcript/session-transcript-contract.ts`:

```typescript
const sessionManager = openTranscriptSessionManagerForSession({
  agentId: params.agentId,
  sessionId: params.sessionId,
});
```

OpenClaw wraps this with `guardSessionManager()` for tool result safety.

### History limiting

`limitHistoryTurns()` trims conversation history based on channel type (DM vs group).

### Compaction

Auto-compaction triggers on context overflow. Common overflow signatures
include `request_too_large`, `context length exceeded`, `input exceeds the
maximum number of tokens`, `input token count exceeds the maximum number of
input tokens`, `input is too long for the model`, and `ollama error: context
length exceeded`. `compactEmbeddedPiSessionDirect()` handles manual
compaction:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  agentId, sessionId, provider, model, ...
});
```

## Authentication and model resolution

### Auth profiles

OpenClaw maintains an auth profile store with multiple API keys per provider:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profiles rotate on failures with cooldown tracking:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Model resolution

```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
  provider,
  modelId,
  agentDir,
  config,
);

// Uses pi's ModelRegistry and AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### Failover

`FailoverError` triggers model fallback when configured:

```typescript
if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
  throw new FailoverError(errorText, {
    reason: promptFailoverReason ?? "unknown",
    provider,
    model: modelId,
    profileId,
    status: resolveFailoverStatus(promptFailoverReason),
  });
}
```

## Runtime extensions

OpenClaw loads custom runtime extensions for specialized behavior. These
extensions use the upstream extension mechanism, but their policy and state are
OpenClaw-owned.

### Compaction safeguard

`src/agents/pi-hooks/compaction-safeguard.ts` adds guardrails to compaction, including adaptive token budgeting plus tool failure and file operation summaries:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Context pruning

`src/agents/pi-hooks/context-pruning.ts` implements cache-TTL based context pruning:

```typescript
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {
  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens,
    isToolPrunable,
    lastCacheTouchAt,
  });
  paths.push(resolvePiExtensionPath("context-pruning"));
}
```

## Streaming and block replies

### Block chunking

`EmbeddedBlockChunker` manages streaming text into discrete reply blocks:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Thinking/Final Tag Stripping

Streaming output is processed to strip `<think>`/`<thinking>` blocks and extract `<final>` content:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Reply directives

Reply directives like `[[media:url]]`, `[[voice]]`, `[[reply:id]]` are parsed and extracted:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Error handling

### Error classification

`pi-embedded-helpers.ts` classifies errors for appropriate handling:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Thinking level fallback

If a thinking level is unsupported, it falls back:

```typescript
const fallbackThinking = pickFallbackThinkingLevel({
  message: errorText,
  attempted: attemptedThinking,
});
if (fallbackThinking) {
  thinkLevel = fallbackThinking;
  continue;
}
```

## Sandbox integration

When sandbox mode is enabled, tools and paths are constrained:

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // Use sandboxed read/edit/write tools
  // Exec runs in container
  // Browser uses bridge URL
}
```

## Provider-Specific Handling

### Anthropic

- Refusal magic string scrubbing
- Turn validation for consecutive roles
- Strict upstream Pi tool parameter validation

### Google/Gemini

- Plugin-owned tool schema sanitization

### OpenAI

- `apply_patch` tool for Codex models
- Thinking level downgrade handling

## TUI Integration

OpenClaw also has a local TUI mode that uses `pi-tui` components directly:

```typescript
// src/tui/tui.ts
import { ... } from "@earendil-works/pi-tui";
```

This provides OpenClaw's interactive terminal experience without moving session
state back to upstream files.

## Key differences from the upstream CLI

| Aspect          | Upstream CLI            | OpenClaw embedded                                                                                                   |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Invocation      | External command / RPC  | In-process session via `createAgentSession()`                                                                       |
| Tools           | Default coding tools    | Custom OpenClaw tool suite                                                                                          |
| System prompt   | Upstream prompt stack   | Dynamic OpenClaw prompt per channel, workspace, and context                                                         |
| Session storage | `~/.pi/agent/sessions/` | `$OPENCLAW_STATE_DIR/state/openclaw.sqlite` plus `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/openclaw-agent.sqlite` |
| Auth            | Single credential       | Multi-profile with rotation                                                                                         |
| Extensions      | Loaded from disk        | OpenClaw policy with programmatic and disk paths                                                                    |
| Event handling  | TUI rendering           | Callback-based (onBlockReply, etc.)                                                                                 |

## Future considerations

Areas for potential rework:

1. **Naming cleanup**: Historical `pi-*` file names can move toward OpenClaw
   runtime names once imports are fully quarantined.
2. **Tool signature alignment**: Upstream tool signature adapters should stay at
   one boundary.
3. **Transcript writer wrapping**: `guardSessionManager` adds tool-result safety
   around the SQLite writer but increases complexity.
4. **Extension loading**: OpenClaw should keep policy ownership while shrinking
   the integration surface.
5. **Streaming handler complexity**: `subscribeEmbeddedPiSession` has grown large.
6. **Provider quirks**: Provider-specific codepaths should keep moving toward
   owner modules or typed runtime helpers.

## Tests

Embedded runtime coverage spans these suites:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-embedded-helpers*.test.ts`
- `src/agents/pi-embedded-runner*.test.ts`
- `src/agents/pi-embedded-runner/**/*.test.ts`
- `src/agents/pi-embedded-subscribe*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-tool-definition-adapter*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-hooks/**/*.test.ts`

Live/opt-in:

- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (enable `OPENCLAW_LIVE_TEST=1`)

For current run commands, see [Pi Development Workflow](/pi-dev).

## Related

- [Pi development workflow](/pi-dev)
- [Install overview](/install)
