---
title: "Pi-integrationsarkitektur"
---

# Pi-integrationsarkitektur

Dette dokument beskriver, hvordan OpenClaw integrerer med [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) og dets søsterpakker (`pi-ai`, `pi-agent-core`, `pi-tui`) for at drive sine AI-agentfunktioner.

## Overblik

OpenClaw bruger pi SDK til at integrere en AI-kodning agent i sin messaging gateway arkitektur. I stedet for at gyde pi som en underproces eller ved hjælp af RPC tilstand, OpenClaw direkte importerer og instantierer pi's `AgentSession` via `createAgentSession()`. Denne integrerede tilgang giver:

- Fuld kontrol over sessionens livscyklus og hændelseshåndtering
- Brugerdefineret værktøjsinjektion (messaging, sandbox, kanal-specifikke handlinger)
- Tilpasning af systemprompt pr. kanal/kontekst
- Sessionspersistens med understøttelse af forgrening/komprimering
- Rotation af auth-profiler på tværs af flere konti med failover
- Udbyderagnostisk modelswitching

## Pakkeafhængigheder

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Pakke             | Formål                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Kerne-LLM-abstraktioner: `Model`, `streamSimple`, meddelelsestyper, udbyder-API’er                          |
| `pi-agent-core`   | Agent-loop, værktøjsudførelse, `AgentMessage`-typer                                                                         |
| `pi-coding-agent` | Højniveau-SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, indbyggede værktøjer |
| `pi-tui`          | Terminal-UI-komponenter (bruges i OpenClaws lokale TUI-tilstand)                                         |

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

## Kerneintegrationsflow

### 1. Kører en indlejret agent

Det primære indgangspunkt er `runEmbeddedPiAgent()` i `pi-embedded-runner/run.ts`:

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

### 2. Oprettelse Af Session

Inde i `runEmbeddedAttempt()` (kaldt af `runEmbeddedPiAgent()`) bruges pi SDK’et:

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

### 3. Begivenheds Abonnement

`subscribeEmbeddedPiSession()` abonnerer på pi’s `AgentSession`-hændelser:

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

Håndterede hændelser omfatter:

- `message_start` / `message_end` / `message_update` (streaming af tekst/tænkning)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Forslag

Efter opsætning promptes sessionen:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK’et håndterer hele agent-loopet: afsendelse til LLM, udførelse af værktøjskald, streaming af svar.

## Værktøjsarkitektur

### Værktøjspipeline

1. **Basisværktøjer**: pi’s `codingTools` (read, bash, edit, write)
2. **Brugerdefinerede erstatninger**: OpenClaw erstatter bash med `exec`/`process`, tilpasser read/edit/write til sandbox
3. **OpenClaw-værktøjer**: messaging, browser, canvas, sessions, cron, gateway m.m.
4. **Kanalværktøjer**: handlingsværktøjer specifikke for Discord/Telegram/Slack/WhatsApp
5. **Politikfiltrering**: Værktøjer filtreres efter profil, udbyder, agent, gruppe og sandbox-politikker
6. **Skemanormalisering**: Skemaer renses for Gemini/OpenAI-særheder
7. **AbortSignal-indpakning**: Værktøjer pakkes ind for at respektere abort-signaler

### Adapter til værktøjsdefinition

pi-agent-core's `AgentTool` har en anden `execute` signatur end pi-coding-agent's `ToolDefinition`. Adapteren i 'pi-tool-definition-adapter.ts' broer dette:

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

### Strategi for værktøjsopdeling

`splitSdkTools()` videresender alle værktøjer via `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Dette sikrer, at OpenClaws politikfiltrering, sandbox-integration og udvidede værktøjssæt forbliver konsistente på tværs af udbydere.

## Opbygning af systemprompt

Systemet prompt er bygget i `buildAgentSystemPrompt()` (`system-prompt.ts`). Det samler en fuld prompt med sektioner, herunder Tooling, Tool Call Style, Sikkerhed guardrails, OpenClaw CLI reference, Færdigheder, Dokumenter, Arbejdsplads, Sandbox, Besked, Svar Tags, Stemme, tavs gengivelser, Heartbeats, Runtime metadata, plus hukommelse og reaktioner, når aktiveret, og valgfri kontekstfiler og ekstra system prompt indhold. Sektioner trimmes for minimal prompt tilstand bruges af underagenter.

Prompten anvendes efter oprettelse af session via `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Sessionsstyring

### Sessionsfiler

Sessioner er JSONL filer med træstruktur (ID / parent Id linking). Pi's `SessionManager` håndterer vedholdenhed:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw indpakker dette med `guardSessionManager()` for sikkerhed omkring værktøjsresultater.

### Session-caching

`session-manager-cache.ts` cacher SessionManager-instanser for at undgå gentagen filparsing:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Historiebegrænsning

`limitHistoryTurns()` beskærer samtalehistorik baseret på kanaltype (DM vs. gruppe).

### Komprimering

Auto-komprimering udløser ved kontekstoverløb. `compactEmbeddedPiSessionDirect()` håndterer manuel komprimering:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Autentificering & modelopløsning

### Auth-profiler

OpenClaw vedligeholder et auth-profillager med flere API-nøgler pr. udbyder:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profiler roteres ved fejl med tracking af cooldown:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Modelopløsning

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

`FailoverError` udløser model-fallback, når det er konfigureret:

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

## Pi-udvidelser

OpenClaw indlæser brugerdefinerede pi-udvidelser til specialiseret adfærd:

### Komprimeringsværn

`pi-extensions/compaction-safeguard.ts` tilføjer værn til komprimering, herunder adaptiv token-budgettering samt opsummeringer af værktøjsfejl og filoperationer:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Kontekstbeskæring

`pi-extensions/context-pruning.ts` implementerer cache-TTL-baseret kontekstbeskæring:

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

## Streaming & blok-svar

### Blokopdeling

`EmbeddedBlockChunker` håndterer streaming af tekst i diskrete svarblokke:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Fjernelse af Thinking/Final-tags

Streamet output behandles for at fjerne `<think>`/`<thinking>`-blokke og udtrække `<final>`-indhold:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Svardirektiver

Svardirektiver som `[[media:url]]`, `[[voice]]`, `[[reply:id]]` parses og udtrækkes:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Fejlhåndtering

### Fejlklassificering

`pi-embedded-helpers.ts` klassificerer fejl til passende håndtering:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Fallback for thinking-niveau

Hvis et thinking-niveau ikke understøttes, faldes der tilbage:

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

## Sandbox-integration

Når sandbox-tilstand er aktiveret, begrænses værktøjer og stier:

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

## Udbyderspecifik håndtering

### Anthropic

- Rensning af refusal magic string
- Turn-validering for efterfølgende roller
- Kompatibilitet med Claude Code-parametre

### Google/Gemini

- Rettelser til tur-rækkefølge (`applyGoogleTurnOrderingFix`)
- Rensning af værktøjsskema (`sanitizeToolsForGoogle`)
- Rensning af sessionshistorik (`sanitizeSessionHistory`)

### OpenAI

- `apply_patch`-værktøj til Codex-modeller
- Håndtering af nedgradering af thinking-niveau

## TUI-integration

OpenClaw har også en lokal TUI-tilstand, der bruger pi-tui-komponenter direkte:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Dette giver den interaktive terminaloplevelse, der minder om pi’s oprindelige tilstand.

## Vigtige forskelle fra Pi CLI

| Aspekt              | Pi CLI                              | OpenClaw indlejret                                                                                                   |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Kald                | `pi`-kommando / RPC                 | SDK via `createAgentSession()`                                                                                       |
| Værktøjer           | Standard kodeværktøjer              | Brugerdefineret OpenClaw-værktøjssuite                                                                               |
| Systemprompt        | AGENTS.md + prompts | Dynamisk pr. kanal/kontekst                                                                          |
| Sessionslagring     | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (eller `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Auth                | Enkelt legitimationsoplysning       | Multi-profil med rotation                                                                                            |
| Udvidelser          | Indlæses fra disk                   | Programmatisk + diskstier                                                                                            |
| Hændelseshåndtering | TUI-rendering                       | Callback-baseret (onBlockReply m.m.)                              |

## Fremtidige overvejelser

Områder med potentiale for omarbejdning:

1. **Tilpasning af værktøjssignaturer**: Tilpasning mellem pi-agent-core og pi-coding-agent-signaturer
2. **Indpakning af session manager**: `guardSessionManager` øger sikkerheden, men også kompleksiteten
3. **Indlæsning af udvidelser**: Kunne bruge pi’s `ResourceLoader` mere direkte
4. **Kompleksitet i streaming-handler**: `subscribeEmbeddedPiSession` er vokset sig stor
5. **Udbydersærheder**: Mange udbyderspecifikke kodeveje, som pi potentielt kunne håndtere

## Tests

Alle eksisterende tests, der dækker pi-integrationen og dens udvidelser:

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
