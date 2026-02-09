---
title: "Pi ပေါင်းစည်းမှု ဆောက်လုပ်ပုံ အင်ဂျင်နီယာဖွဲ့စည်းမှု"
---

# Pi ပေါင်းစည်းမှု ဆောက်လုပ်ပုံ အင်ဂျင်နီယာဖွဲ့စည်းမှု

ဤစာရွက်စာတမ်းသည် OpenClaw က [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) နှင့် ၎င်း၏ ဆက်စပ်ပက်ကေ့ဂျ်များ (`pi-ai`, `pi-agent-core`, `pi-tui`) ကို မည်သို့ပေါင်းစည်းအသုံးပြု၍ AI agent စွမ်းရည်များကို ထောက်ပံ့ပေးသည်ကို ရှင်းလင်းဖော်ပြထားသည်။

## အကျဉ်းချုပ်

7. OpenClaw သည် ၎င်း၏ messaging gateway architecture အတွင်းသို့ AI coding agent တစ်ခုကို embed လုပ်ရန် pi SDK ကို အသုံးပြုပါသည်။ 8. pi ကို subprocess အဖြစ် spawn လုပ်ခြင်း သို့မဟုတ် RPC mode ကို အသုံးပြုခြင်းအစား OpenClaw သည် `createAgentSession()` မှတဆင့် pi ၏ `AgentSession` ကို တိုက်ရိုက် import လုပ်ပြီး instantiate လုပ်ပါသည်။ 9. ဤ embedded approach သည် အောက်ပါအချက်များကို ပံ့ပိုးပေးပါသည်:

- session lifecycle နှင့် event handling ကို အပြည့်အဝ ထိန်းချုပ်နိုင်ခြင်း
- Custom tool injection (messaging, sandbox, channel-specific actions)
- channel/context အလိုက် system prompt ကို စိတ်ကြိုက်ပြင်ဆင်နိုင်ခြင်း
- branching/compaction အထောက်အပံ့ဖြင့် session persistence
- failover ပါဝင်သည့် multi-account auth profile လှည့်လည်အသုံးပြုမှု
- provider မရွေး မော်ဒယ်ပြောင်းလဲအသုံးပြုနိုင်မှု

## Package Dependencies

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Package           | ရည်ရွယ်ချက်                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | အခြေခံ LLM abstraction များ: `Model`, `streamSimple`, message types, provider APIs                     |
| `pi-agent-core`   | Agent loop, tool execution, `AgentMessage` အမျိုးအစားများ                                                              |
| `pi-coding-agent` | အဆင့်မြင့် SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, built-in tools |
| `pi-tui`          | Terminal UI အစိတ်အပိုင်းများ (OpenClaw ၏ local TUI mode တွင် အသုံးပြုသည်)                           |

## File Structure

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
│   ├── session-manager-cache.ts   # SessionManager instance caching
│   ├── session-manager-init.ts    # Session file initialization
│   ├── system-prompt.ts           # System prompt builder
│   ├── tool-split.ts              # Split tools into builtIn vs custom
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel mapping, error description
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
├── pi-extensions/                 # Custom pi extensions
│   ├── compaction-safeguard.ts    # Safeguard extension
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # Cache-TTL context pruning extension
│   └── context-pruning/
├── model-auth.ts                  # Auth profile resolution
├── auth-profiles.ts               # Profile store, cooldown, failover
├── model-selection.ts             # Default model resolution
├── models-config.ts               # models.json generation
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
│   ├── discord-actions*.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── slack-actions.ts
│   ├── telegram-actions.ts
│   ├── web-*.ts
│   └── whatsapp-actions.ts
└── ...
```

## Core Integration Flow

### 10. 1. 11. Embedded Agent ကို Run လုပ်ခြင်း

အဓိက entry point သည် `pi-embedded-runner/run.ts` ထဲရှိ `runEmbeddedPiAgent()` ဖြစ်သည်—

```typescript
import { runEmbeddedPiAgent } from "./agents/pi-embedded-runner.js";

const result = await runEmbeddedPiAgent({
  sessionId: "user-123",
  sessionKey: "main:whatsapp:+1234567890",
  sessionFile: "/path/to/session.jsonl",
  workspaceDir: "/path/to/workspace",
  config: openclawConfig,
  prompt: "Hello, how are you?",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  timeoutMs: 120_000,
  runId: "run-abc",
  onBlockReply: async (payload) => {
    await sendToChannel(payload.text, payload.mediaUrls);
  },
});
```

### 12. 2. 13. Session ဖန်တီးခြင်း

`runEmbeddedAttempt()` အတွင်း ( `runEmbeddedPiAgent()` မှ ခေါ်ယူသည်) pi SDK ကို အသုံးပြုထားသည်—

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const resourceLoader = new DefaultResourceLoader({
  cwd: resolvedWorkspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths,
});
await resourceLoader.reload();

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

### 14. 3. 15. Event Subscription

`subscribeEmbeddedPiSession()` သည် pi ၏ `AgentSession` ဖြစ်ရပ်များကို subscribe ပြုလုပ်သည်—

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

ကိုင်တွယ်သည့် ဖြစ်ရပ်များတွင်—

- `message_start` / `message_end` / `message_update` (text/thinking streaming)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 16. 4. 17. Prompting

setup ပြီးနောက် session ကို prompt လုပ်သည်—

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK သည် agent loop အပြည့်အစုံကို ကိုင်တွယ်ပေးသည်—LLM သို့ ပို့ခြင်း၊ tool calls များကို အကောင်အထည်ဖော်ခြင်း၊ အဖြေများကို streaming လုပ်ခြင်း။

## Tool Architecture

### Tool Pipeline

1. **Base Tools**: pi ၏ `codingTools` (read, bash, edit, write)
2. **Custom Replacements**: OpenClaw သည် bash ကို `exec`/`process` ဖြင့် အစားထိုးပြီး sandbox အတွက် read/edit/write ကို စိတ်ကြိုက်ပြင်ဆင်သည်
3. **OpenClaw Tools**: messaging, browser, canvas, sessions, cron, gateway စသည်
4. **Channel Tools**: Discord/Telegram/Slack/WhatsApp သီးသန့် action tools
5. **Policy Filtering**: profile, provider, agent, group, sandbox policies အလိုက် tools ကို စစ်ထုတ်ခြင်း
6. **Schema Normalization**: Gemini/OpenAI quirks များအတွက် schema များကို သန့်စင်ခြင်း
7. **AbortSignal Wrapping**: abort signals ကို လေးစားရန် tools များကို wrap လုပ်ခြင်း

### Tool Definition Adapter

18. pi-agent-core ၏ `AgentTool` တွင် pi-coding-agent ၏ `ToolDefinition` နှင့် မတူသော `execute` signature တစ်ခု ရှိပါသည်။ 19. `pi-tool-definition-adapter.ts` ထဲရှိ adapter သည် ဤအရာကို bridge လုပ်ပေးပါသည်:

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent signature differs from pi-agent-core
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### Tool Split Strategy

`splitSdkTools()` သည် tools အားလုံးကို `customTools` မှတစ်ဆင့် ပို့ပေးသည်—

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

ဤနည်းလမ်းကြောင့် OpenClaw ၏ policy filtering, sandbox integration နှင့် တိုးချဲ့ toolset များသည် provider များအကြား တစ်ညီတစ်ညွတ်ဖြစ်နေစေသည်။

## System Prompt တည်ဆောက်ခြင်း

20. system prompt ကို `buildAgentSystemPrompt()` (`system-prompt.ts`) တွင် တည်ဆောက်ပါသည်။ It assembles a full prompt with sections including Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI reference, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata, plus Memory and Reactions when enabled, and optional context files and extra system prompt content. 22. subagents များအတွက် အသုံးပြုသော minimal prompt mode တွင် section များကို trim လုပ်ထားပါသည်။

session ဖန်တီးပြီးနောက် `applySystemPromptOverrideToSession()` မှတစ်ဆင့် prompt ကို အသုံးချသည်—

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Session Management

### Session Files

23. Session များသည် tree structure (id/parentId ချိတ်ဆက်မှု) ပါသော JSONL ဖိုင်များဖြစ်ပါသည်။ 24. Pi ၏ `SessionManager` သည် persistence ကို ကိုင်တွယ်ပါသည်:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw သည် tool result safety အတွက် `guardSessionManager()` ဖြင့် wrap လုပ်ထားသည်။

### Session Caching

`session-manager-cache.ts` သည် SessionManager instances များကို cache လုပ်၍ ဖိုင် parsing ကို ထပ်ခါတလဲလဲ မလုပ်ရအောင် ကာကွယ်သည်—

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### History Limiting

`limitHistoryTurns()` သည် channel အမျိုးအစား (DM နှင့် group) အလိုက် စကားပြောမှတ်တမ်းကို ချုံ့သည်။

### Compaction

25. context overflow ဖြစ်လာသောအခါ auto-compaction ကို trigger လုပ်ပါသည်။ 26. `compactEmbeddedPiSessionDirect()` သည် manual compaction ကို ကိုင်တွယ်ပါသည်:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Authentication & Model Resolution

### Auth Profiles

OpenClaw သည် provider တစ်ခုချင်းစီအတွက် API key များစွာ ပါဝင်သည့် auth profile store ကို ထိန်းသိမ်းထားသည်—

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

ပျက်ကွက်မှုများ ဖြစ်ပေါ်လျှင် cooldown tracking ဖြင့် profile များကို လှည့်လည်အသုံးပြုသည်—

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Model Resolution

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

configure လုပ်ထားပါက `FailoverError` သည် model fallback ကို လုပ်ဆောင်စေသည်—

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

## Pi Extensions

OpenClaw သည် အထူးပြု အပြုအမူများအတွက် custom pi extensions များကို load လုပ်သည်—

### Compaction Safeguard

`pi-extensions/compaction-safeguard.ts` သည် adaptive token budgeting နှင့် tool failure နှင့် file operation summaries များ ပါဝင်သည့် compaction guardrails များကို ထည့်သွင်းပေးသည်—

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Context Pruning

`pi-extensions/context-pruning.ts` သည် cache-TTL အခြေပြု context pruning ကို အကောင်အထည်ဖော်သည်—

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

## Streaming & Block Replies

### Block Chunking

`EmbeddedBlockChunker` သည် streaming text ကို သီးခြား reply blocks များအဖြစ် စီမံခန့်ခွဲသည်—

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Thinking/Final Tag ဖယ်ရှားခြင်း

Streaming output ကို `<think>`/`<thinking>` blocks များကို ဖယ်ရှားပြီး `<final>` အကြောင်းအရာကို ထုတ်ယူရန် process လုပ်သည်—

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Reply Directives

`[[media:url]]`, `[[voice]]`, `[[reply:id]]` ကဲ့သို့ reply directives များကို parse လုပ်ပြီး ထုတ်ယူသည်—

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Error Handling

### Error Classification

`pi-embedded-helpers.ts` သည် သင့်လျော်သော ကိုင်တွယ်မှုအတွက် error များကို ခွဲခြားသည်—

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Thinking Level Fallback

thinking level ကို မထောက်ပံ့နိုင်ပါက fallback ပြုလုပ်သည်—

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

## Sandbox Integration

sandbox mode ကို enable လုပ်ထားပါက tools နှင့် paths များကို ကန့်သတ်ထားသည်—

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
- role များ ဆက်တိုက်ဖြစ်မှုအတွက် turn validation
- Claude Code parameter compatibility

### Google/Gemini

- Turn ordering ပြင်ဆင်မှုများ (`applyGoogleTurnOrderingFix`)
- Tool schema သန့်စင်ခြင်း (`sanitizeToolsForGoogle`)
- Session history သန့်စင်ခြင်း (`sanitizeSessionHistory`)

### OpenAI

- Codex မော်ဒယ်များအတွက် `apply_patch` tool
- Thinking level downgrade ကို ကိုင်တွယ်ခြင်း

## TUI Integration

OpenClaw တွင် pi-tui components များကို တိုက်ရိုက်အသုံးပြုသည့် local TUI mode လည်း ပါဝင်သည်—

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

ဤအရာသည် pi ၏ native mode နှင့် ဆင်တူသည့် interactive terminal အတွေ့အကြုံကို ပေးစွမ်းသည်။

## Pi CLI နှင့် ကွာခြားချက်များ

| Aspect          | Pi CLI                              | OpenClaw Embedded                                                                                                        |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Invocation      | `pi` command / RPC                  | `createAgentSession()` မှတစ်ဆင့် SDK                                                                                     |
| Tools           | Default coding tools                | OpenClaw ၏ custom tool suite                                                                                             |
| System prompt   | AGENTS.md + prompts | channel/context အလိုက် dynamic                                                                                           |
| Session storage | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (သို့မဟုတ် `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Auth            | အထောက်အထားတစ်ခုတည်း                 | လှည့်လည်အသုံးပြုနိုင်သော multi-profile                                                                                   |
| Extensions      | disk မှ load လုပ်သည်                | Programmatic + disk paths                                                                                                |
| Event handling  | TUI rendering                       | Callback အခြေပြု (onBlockReply စသည်)                                                                  |

## အနာဂတ် စဉ်းစားရန် အချက်များ

ပြန်လည်ပြင်ဆင်ရန် အလားအလာရှိသည့် အပိုင်းများ—

1. **Tool signature ကို ညှိနှိုင်းခြင်း**: လက်ရှိတွင် pi-agent-core နှင့် pi-coding-agent signatures အကြား အပြောင်းအလဲလုပ်နေသည်
2. **Session manager wrapping**: `guardSessionManager` သည် safety ကို ထည့်ပေးသော်လည်း ရှုပ်ထွေးမှု တိုးစေသည်
3. **Extension loading**: pi ၏ `ResourceLoader` ကို ပိုမို တိုက်ရိုက်အသုံးပြုနိုင်သည်
4. **Streaming handler ရှုပ်ထွေးမှု**: `subscribeEmbeddedPiSession` သည် အရွယ်အစားကြီးလာသည်
5. **Provider quirks**: pi က ကိုင်တွယ်နိုင်မည့် provider-specific codepaths များ များစွာ ရှိနေသည်

## Tests

pi ပေါင်းစည်းမှုနှင့် ၎င်း၏ extensions များကို ဖုံးလွှမ်းထားသည့် ရှိပြီးသား tests အားလုံး—

- `src/agents/pi-embedded-block-chunker.test.ts`
- `src/agents/pi-embedded-helpers.buildbootstrapcontextfiles.test.ts`
- `src/agents/pi-embedded-helpers.classifyfailoverreason.test.ts`
- `src/agents/pi-embedded-helpers.downgradeopenai-reasoning.test.ts`
- `src/agents/pi-embedded-helpers.formatassistanterrortext.test.ts`
- `src/agents/pi-embedded-helpers.formatrawassistanterrorforui.test.ts`
- `src/agents/pi-embedded-helpers.image-dimension-error.test.ts`
- `src/agents/pi-embedded-helpers.image-size-error.test.ts`
- `src/agents/pi-embedded-helpers.isautherrormessage.test.ts`
- `src/agents/pi-embedded-helpers.isbillingerrormessage.test.ts`
- `src/agents/pi-embedded-helpers.iscloudcodeassistformaterror.test.ts`
- `src/agents/pi-embedded-helpers.iscompactionfailureerror.test.ts`
- `src/agents/pi-embedded-helpers.iscontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.isfailovererrormessage.test.ts`
- `src/agents/pi-embedded-helpers.islikelycontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.ismessagingtoolduplicate.test.ts`
- `src/agents/pi-embedded-helpers.messaging-duplicate.test.ts`
- `src/agents/pi-embedded-helpers.normalizetextforcomparison.test.ts`
- `src/agents/pi-embedded-helpers.resolvebootstrapmaxchars.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.keeps-tool-call-tool-result-ids-unchanged.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.removes-empty-assistant-text-blocks-but-preserves.test.ts`
- `src/agents/pi-embedded-helpers.sanitizegoogleturnordering.test.ts`
- `src/agents/pi-embedded-helpers.sanitizesessionmessagesimages-thought-signature-stripping.test.ts`
- `src/agents/pi-embedded-helpers.sanitizetoolcallid.test.ts`
- `src/agents/pi-embedded-helpers.sanitizeuserfacingtext.test.ts`
- `src/agents/pi-embedded-helpers.stripthoughtsignatures.test.ts`
- `src/agents/pi-embedded-helpers.validate-turns.test.ts`
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (live)
- `src/agents/pi-embedded-runner-extraparams.test.ts`
- `src/agents/pi-embedded-runner.applygoogleturnorderingfix.test.ts`
- `src/agents/pi-embedded-runner.buildembeddedsandboxinfo.test.ts`
- `src/agents/pi-embedded-runner.createsystempromptoverride.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.falls-back-provider-default-per-dm-not.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.returns-undefined-sessionkey-is-undefined.test.ts`
- `src/agents/pi-embedded-runner.google-sanitize-thinking.test.ts`
- `src/agents/pi-embedded-runner.guard.test.ts`
- `src/agents/pi-embedded-runner.limithistoryturns.test.ts`
- `src/agents/pi-embedded-runner.resolvesessionagentids.test.ts`
- `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`
- `src/agents/pi-embedded-runner.sanitize-session-history.test.ts`
- `src/agents/pi-embedded-runner.splitsdktools.test.ts`
- `src/agents/pi-embedded-runner.test.ts`
- `src/agents/pi-embedded-subscribe.code-span-awareness.test.ts`
- `src/agents/pi-embedded-subscribe.reply-tags.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.calls-onblockreplyflush-before-tool-execution-start-preserve.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-append-text-end-content-is.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-call-onblockreplyflush-callback-is-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-emit-duplicate-block-replies-text.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-block-replies-text-end-does-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.filters-final-suppresses-output-without-start-tag.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.includes-canvas-action-metadata-tool-summaries.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-indented-fenced-blocks-intact.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.reopens-fenced-blocks-splitting-inside-them.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.splits-long-single-line-fenced-blocks-reopen.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.streams-soft-chunks-paragraph-preference.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.suppresses-message-end-block-replies-message-tool.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.waits-multiple-compaction-retries-before-resolving.test.ts`
- `src/agents/pi-embedded-subscribe.tools.test.ts`
- `src/agents/pi-embedded-utils.test.ts`
- `src/agents/pi-extensions/compaction-safeguard.test.ts`
- `src/agents/pi-extensions/context-pruning.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-tools-agent-config.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-b.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-d.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-f.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping.test.ts`
- `src/agents/pi-tools.policy.test.ts`
- `src/agents/pi-tools.safe-bins.test.ts`
- `src/agents/pi-tools.workspace-paths.test.ts`
