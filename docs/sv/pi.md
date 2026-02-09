---
title: "Pi-integrationsarkitektur"
---

# Pi-integrationsarkitektur

Detta dokument beskriver hur OpenClaw integreras med [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) och dess syskonpaket (`pi-ai`, `pi-agent-core`, `pi-tui`) för att driva dess AI-agentfunktioner.

## Översikt

OpenClaw använder pi SDK för att bädda in en AI-kodningsagent i dess meddelande-gateway-arkitektur. Istället för att spawna pi som en underprocess eller använda RPC-läge, importerar OpenClaw direkt och instansierar pi's `AgentSession` via `createAgentSession()`. Denna inbäddade metod ger:

- Full kontroll över sessionens livscykel och händelsehantering
- Anpassad verktygsinjektion (messaging, sandbox, kanalspecifika åtgärder)
- Anpassning av systemprompt per kanal/kontext
- Sessionspersistens med stöd för förgrening/kompaktering
- Rotation av autentiseringsprofiler för flera konton med failover
- Leverantörsoberoende modellväxling

## Paketberoenden

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Paket             | Syfte                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Centrala LLM-abstraktioner: `Model`, `streamSimple`, meddelandetyper, leverantörs-API:er  |
| `pi-agent-core`   | Agentloop, verktygsexekvering, `AgentMessage`-typer                                                                       |
| `pi-coding-agent` | SDK på hög nivå: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, inbyggda verktyg |
| `pi-tui`          | Terminal-UI-komponenter (används i OpenClaws lokala TUI-läge)                                          |

## Filstruktur

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

## Centralt integrationsflöde

### 1. Kör en inbäddad agent

Den huvudsakliga startpunkten är `runEmbeddedPiAgent()` i `pi-embedded-runner/run.ts`:

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

### 2. Skapande av session

Inuti `runEmbeddedAttempt()` (anropad av `runEmbeddedPiAgent()`) används pi SDK:

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

### 3. Händelse prenumeration

`subscribeEmbeddedPiSession()` prenumererar på pi:s `AgentSession`-händelser:

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

Händelser som hanteras inkluderar:

- `message_start` / `message_end` / `message_update` (strömmande text/tänkande)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Fråga

Efter konfiguration promptas sessionen:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK:n hanterar hela agentloopen: skickar till LLM, exekverar verktygsanrop, strömmar svar.

## Verktygsarkitektur

### Verktygspipeline

1. **Basverktyg**: pi:s `codingTools` (read, bash, edit, write)
2. **Anpassade ersättningar**: OpenClaw ersätter bash med `exec`/`process`, anpassar read/edit/write för sandbox
3. **OpenClaw-verktyg**: messaging, browser, canvas, sessions, cron, gateway, m.m.
4. **Kanalverktyg**: Discord-/Telegram-/Slack-/WhatsApp-specifika åtgärdsverktyg
5. **Policyfiltrering**: Verktyg filtreras per profil, leverantör, agent, grupp, sandbox-policyer
6. **Schemanormalisering**: Scheman rensas för Gemini/OpenAI-avvikelser
7. **AbortSignal-inkapsling**: Verktyg kapslas för att respektera abortsignaler

### Adapter för verktygsdefinitioner

pi-agent-core's `AgentTool` har en annan `execute`-signatur än pi-coding-agent's `ToolDefinition`. Adaptern i `pi-tool-definition-adapter.ts` broar detta:

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

### Strategi för verktygssplit

`splitSdkTools()` skickar alla verktyg via `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Detta säkerställer att OpenClaws policyfiltrering, sandbox-integrering och utökade verktygsuppsättning förblir konsekventa över leverantörer.

## Konstruktion av systemprompt

Systemprompten är inbyggd i `buildAgentSystemPrompt()` (`system-prompt.ts`). Det sammanställer en fullständig prompt med sektioner, inklusive Verktyg, Tool Call Style, Skyddsräcken, OpenClaw CLI-referens, Färdigheter, Dokument, Arbetsyta, Sandbox, Meddelanden, Svara taggar, röst, tysta svar, Heartbeats, Runtime metadata, plus Minne och reaktioner när det är aktiverat, och valfria sammanhangsfiler och extra innehåll i systemprompten. Avsnitten är trimmade för minimal prompt-läge som används av subagenter.

Prompten tillämpas efter att sessionen skapats via `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Sessionshantering

### Sessionsfiler

Sessioner är JSONL-filer med trädstruktur (id/föräldra-länkning). Pi's `SessionManager` hanterar persistence:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw omsluter detta med `guardSessionManager()` för säker hantering av verktygsresultat.

### Sessionscache

`session-manager-cache.ts` cachar SessionManager-instanser för att undvika upprepad filparsning:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Historikbegränsning

`limitHistoryTurns()` trimmar konversationshistorik baserat på kanaltyp (DM vs grupp).

### Kompaktering

Auto-komprimering utlöser på sammanhangsspill . `compactEmbeddedPiSessionDirect()` handtag manuell komprimering:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Autentisering och modellupplösning

### Autentiseringsprofiler

OpenClaw upprätthåller ett lager av autentiseringsprofiler med flera API-nycklar per leverantör:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profiler roteras vid fel med nedkylningsspårning:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Modellupplösning

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

`FailoverError` triggar modell-fallback när konfigurerad:

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

## Pi-tillägg

OpenClaw laddar anpassade pi-tillägg för specialiserat beteende:

### Skydd för kompaktering

`pi-extensions/compaction-safeguard.ts` lägger till skyddsräcken för kompaktering, inklusive adaptiv tokenbudgetering samt sammanfattningar av verktygsfel och filoperationer:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Kontextbeskärning

`pi-extensions/context-pruning.ts` implementerar cache-TTL-baserad kontextbeskärning:

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

## Strömning och block-svar

### Blockindelning

`EmbeddedBlockChunker` hanterar strömmande text till diskreta svarsblock:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Borttagning av Thinking/Final-taggar

Strömmande utdata bearbetas för att ta bort `<think>`/`<thinking>`-block och extrahera `<final>`-innehåll:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Svarsdirektiv

Svarsdirektiv som `[[media:url]]`, `[[voice]]`, `[[reply:id]]` tolkas och extraheras:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Felhantering

### Felklassificering

`pi-embedded-helpers.ts` klassificerar fel för lämplig hantering:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Fallback för tänkenivå

Om en tänkenivå inte stöds, faller den tillbaka:

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

## Sandbox-integrering

När sandbox-läge är aktiverat begränsas verktyg och sökvägar:

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

## Leverantörsspecifik hantering

### Anthropic

- Rensning av vägran-magi-sträng
- Turvalidering för på varandra följande roller
- Parameterekompatibilitet för Claude Code

### Google/Gemini

- Åtgärder för turordning (`applyGoogleTurnOrderingFix`)
- Sanering av verktygsscheman (`sanitizeToolsForGoogle`)
- Sanering av sessionshistorik (`sanitizeSessionHistory`)

### OpenAI

- `apply_patch`-verktyg för Codex-modeller
- Hantering av nedgradering av tänkenivå

## TUI-integrering

OpenClaw har också ett lokalt TUI-läge som använder pi-tui-komponenter direkt:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Detta ger en interaktiv terminalupplevelse liknande pi:s inbyggda läge.

## Viktiga skillnader jämfört med Pi CLI

| Aspekt            | Pi CLI                               | OpenClaw inbäddad                                                                                                    |
| ----------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Anrop             | `pi`-kommando / RPC                  | SDK via `createAgentSession()`                                                                                       |
| Verktyg           | Standardverktyg för kodning          | Anpassad OpenClaw-verktygssvit                                                                                       |
| Systemprompt      | AGENTS.md + prompter | Dynamisk per kanal/kontext                                                                                           |
| Sessionslagring   | `~/.pi/agent/sessions/`              | `~/.openclaw/agents/<agentId>/sessions/` (eller `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Autentisering     | Enskild inloggning                   | Flera profiler med rotation                                                                                          |
| Tillägg           | Laddas från disk                     | Programmatisk + disksökvägar                                                                                         |
| Händelsehantering | TUI-rendering                        | Callback-baserad (onBlockReply, m.fl.)                            |

## Framtida överväganden

Områden för potentiell omarbetning:

1. **Anpassning av verktygssignaturer**: Anpassar för närvarande mellan pi-agent-core och pi-coding-agent-signaturer
2. **Omslutning av sessionshanterare**: `guardSessionManager` tillför säkerhet men ökar komplexiteten
3. **Laddning av tillägg**: Skulle kunna använda pi:s `ResourceLoader` mer direkt
4. **Komplexitet i strömningshanterare**: `subscribeEmbeddedPiSession` har vuxit sig stor
5. **Leverantörsavvikelser**: Många leverantörsspecifika kodvägar som pi potentiellt skulle kunna hantera

## Tester

Alla befintliga tester som täcker pi-integrationen och dess tillägg:

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
