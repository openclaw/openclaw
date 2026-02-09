---
title: "Arkitektura ng Integrasyon ng Pi"
---

# Arkitektura ng Integrasyon ng Pi

Inilalarawan ng dokumentong ito kung paano nag-iintegrate ang OpenClaw sa [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) at sa mga kaakibat nitong package (`pi-ai`, `pi-agent-core`, `pi-tui`) upang paganahin ang mga kakayahan ng AI agent nito.

## Pangkalahatang-ideya

Gumagamit ang OpenClaw ng pi SDK upang i‑embed ang isang AI coding agent sa arkitektura ng messaging gateway nito. Sa halip na mag‑spawn ng pi bilang subprocess o gumamit ng RPC mode, direktang ini‑import at ini‑instantiate ng OpenClaw ang `AgentSession` ng pi sa pamamagitan ng `createAgentSession()`. Ang naka‑embed na pamamaraang ito ay nagbibigay ng:

- Buong kontrol sa lifecycle ng session at event handling
- Custom na tool injection (messaging, sandbox, mga aksyong partikular sa channel)
- Pag-customize ng system prompt kada channel/konteksto
- Session persistence na may suporta para sa branching/compaction
- Multi-account auth profile rotation na may failover
- Provider-agnostic na pagpapalit ng model

## Mga Dependency ng Package

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Package           | Layunin                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Mga core na abstraction ng LLM: `Model`, `streamSimple`, mga uri ng mensahe, provider APIs                   |
| `pi-agent-core`   | Agent loop, pagpapatupad ng tool, mga uri ng `AgentMessage`                                                                  |
| `pi-coding-agent` | High-level SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, mga built-in na tool |
| `pi-tui`          | Mga component ng terminal UI (ginagamit sa lokal na TUI mode ng OpenClaw)                                 |

## Istruktura ng File

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

## Pangunahing Daloy ng Integrasyon

### 1. Pagpapatakbo ng Isang Naka‑embed na Agent

Ang pangunahing entry point ay `runEmbeddedPiAgent()` sa `pi-embedded-runner/run.ts`:

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

### 2. Session Creation

Sa loob ng `runEmbeddedAttempt()` (tinatawag ng `runEmbeddedPiAgent()`), ginagamit ang pi SDK:

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

### 3. Event Subscription

Nag-susubscribe ang `subscribeEmbeddedPiSession()` sa mga event ng `AgentSession` ng pi:

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

Kasama sa mga hinahawakang event ang:

- `message_start` / `message_end` / `message_update` (streaming na text/pag-iisip)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Prompting

Pagkatapos ng setup, bina-prompt ang session:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

Hinahawakan ng SDK ang buong agent loop: pagpapadala sa LLM, pagpapatupad ng mga tool call, at pag-stream ng mga tugon.

## Arkitektura ng Tool

### Pipeline ng Tool

1. **Mga Base Tool**: `codingTools` ng pi (read, bash, edit, write)
2. **Mga Custom na Kapalit**: Pinapalitan ng OpenClaw ang bash ng `exec`/`process`, at kino-customize ang read/edit/write para sa sandbox
3. **Mga Tool ng OpenClaw**: messaging, browser, canvas, sessions, cron, gateway, atbp.
4. **Mga Tool ng Channel**: mga action tool na partikular sa Discord/Telegram/Slack/WhatsApp
5. **Policy Filtering**: Sinasala ang mga tool ayon sa profile, provider, agent, group, at mga policy ng sandbox
6. **Schema Normalization**: Nililinis ang mga schema para sa mga quirk ng Gemini/OpenAI
7. **AbortSignal Wrapping**: Binalot ang mga tool upang igalang ang abort signals

### Adapter ng Depinisyon ng Tool

Ang `AgentTool` ng pi-agent-core ay may ibang `execute` signature kaysa sa `ToolDefinition` ng pi-coding-agent. The adapter in `pi-tool-definition-adapter.ts` bridges this:

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

### Estratehiya ng Tool Split

Ipinapasa ng `splitSdkTools()` ang lahat ng tool sa pamamagitan ng `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Tinitiyak nito na nananatiling pare-pareho sa lahat ng provider ang policy filtering ng OpenClaw, integrasyon ng sandbox, at pinalawak na toolset.

## Pagbuo ng System Prompt

Binubuo ang system prompt sa `buildAgentSystemPrompt()` (`system-prompt.ts`). It assembles a full prompt with sections including Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI reference, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata, plus Memory and Reactions when enabled, and optional context files and extra system prompt content. Sections are trimmed for minimal prompt mode used by subagents.

Ina-apply ang prompt pagkatapos malikha ang session sa pamamagitan ng `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Pamamahala ng Session

### Mga File ng Session

Sessions are JSONL files with tree structure (id/parentId linking). Pi's `SessionManager` handles persistence:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

Binabalutan ito ng OpenClaw gamit ang `guardSessionManager()` para sa kaligtasan ng tool result.

### Session Caching

Naka-cache ang `session-manager-cache.ts` ng mga instance ng SessionManager upang maiwasan ang paulit-ulit na pag-parse ng file:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Paglilimita ng History

Tini-trim ng `limitHistoryTurns()` ang history ng pag-uusap batay sa uri ng channel (DM kumpara sa group).

### Compaction

Auto-compaction triggers on context overflow. Pinangangasiwaan ng `compactEmbeddedPiSessionDirect()` ang manual compaction:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Authentication at Model Resolution

### Mga Auth Profile

Pinapanatili ng OpenClaw ang isang auth profile store na may maraming API key kada provider:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Nagro-rotate ang mga profile kapag may failure na may cooldown tracking:

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

Nagtitrigger ang `FailoverError` ng model fallback kapag naka-configure:

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

## Mga Extension ng Pi

Naglo-load ang OpenClaw ng mga custom na pi extension para sa espesyal na behavior:

### Compaction Safeguard

Nagdaragdag ang `pi-extensions/compaction-safeguard.ts` ng mga guardrail sa compaction, kabilang ang adaptive token budgeting pati na ang mga buod ng tool failure at file operation:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Context Pruning

Ipinapatupad ng `pi-extensions/context-pruning.ts` ang cache-TTL based na context pruning:

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

## Streaming at Block Replies

### Block Chunking

Pinamamahalaan ng `EmbeddedBlockChunker` ang pag-stream ng text papunta sa mga hiwa-hiwalay na reply block:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Pag-alis ng Thinking/Final Tag

Pinoproseso ang streaming output upang alisin ang mga block na `<think>`/`<thinking>` at i-extract ang nilalamang `<final>`:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Mga Directive ng Reply

Ang mga reply directive tulad ng `[[media:url]]`, `[[voice]]`, `[[reply:id]]` ay bina-parse at ine-extract:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Pag-handle ng Error

### Pag-uuri ng Error

Inuuri ng `pi-embedded-helpers.ts` ang mga error para sa naaangkop na pag-handle:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Thinking Level Fallback

Kung hindi suportado ang isang thinking level, nagfa-fallback ito:

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

## Integrasyon ng Sandbox

Kapag naka-enable ang sandbox mode, nililimitahan ang mga tool at path:

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

## Provider-Specific na Pag-handle

### Anthropic

- Pag-scrub ng refusal magic string
- Turn validation para sa magkakasunod na role
- Compatibility ng parameter ng Claude Code

### Google/Gemini

- Mga pag-aayos sa turn ordering (`applyGoogleTurnOrderingFix`)
- Sanitization ng tool schema (`sanitizeToolsForGoogle`)
- Sanitization ng session history (`sanitizeSessionHistory`)

### OpenAI

- Tool na `apply_patch` para sa mga model ng Codex
- Pag-handle ng thinking level downgrade

## Integrasyon ng TUI

Mayroon ding lokal na TUI mode ang OpenClaw na direktang gumagamit ng mga component ng pi-tui:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Nagbibigay ito ng interactive na karanasan sa terminal na katulad ng native mode ng pi.

## Mga Pangunahing Pagkakaiba mula sa Pi CLI

| Aspeto          | Pi CLI                                 | OpenClaw Embedded                                                                                                |
| --------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Invocation      | `pi` command / RPC                     | SDK sa pamamagitan ng `createAgentSession()`                                                                     |
| Mga Tool        | Default na coding tools                | Custom na tool suite ng OpenClaw                                                                                 |
| System prompt   | AGENTS.md + mga prompt | Dynamic kada channel/konteksto                                                                                   |
| Session storage | `~/.pi/agent/sessions/`                | `~/.openclaw/agents/<agentId>/sessions/` (o `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Auth            | Isang credential                       | Multi-profile na may rotation                                                                                    |
| Mga Extension   | Niloload mula sa disk                  | Programmatic + mga disk path                                                                                     |
| Event handling  | TUI rendering                          | Callback-based (onBlockReply, atbp.)                                          |

## Mga Konsiderasyon sa Hinaharap

Mga posibleng area para sa rework:

1. **Pagkakahanay ng tool signature**: Kasalukuyang nag-a-adapt sa pagitan ng signature ng pi-agent-core at pi-coding-agent
2. **Pagbabalot ng session manager**: Nagdaragdag ang `guardSessionManager` ng kaligtasan ngunit nagpapataas ng complexity
3. **Pag-load ng extension**: Maaaring gamitin nang mas direkta ang `ResourceLoader` ng pi
4. **Complexity ng streaming handler**: Lumaki na ang `subscribeEmbeddedPiSession`
5. **Mga quirk ng provider**: Maraming provider-specific na codepath na posibleng kayang hawakan ng pi

## Mga Test

Lahat ng umiiral na test na sumasaklaw sa pi integration at mga extension nito:

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
