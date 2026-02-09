---
title: "Pi-integratiearchitectuur"
---

# Pi-integratiearchitectuur

Dit document beschrijft hoe OpenClaw integreert met [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) en de bijbehorende zusterpakketten (`pi-ai`, `pi-agent-core`, `pi-tui`) om zijn AI-agentmogelijkheden aan te drijven.

## Overzicht

OpenClaw gebruikt de pi SDK om een AI-coderingsagent in te bedden in zijn messaging Gateway-architectuur. In plaats van pi te starten als een subprocess of RPC-modus te gebruiken, importeert en instantieert OpenClaw rechtstreeks pi’s `AgentSession` via `createAgentSession()`. Deze ingesloten aanpak biedt:

- Volledige controle over de levenscyclus van sessies en event-afhandeling
- Aangepaste tool-injectie (messaging, sandbox, kanaalspecifieke acties)
- Systeemprompt-aanpassing per kanaal/context
- Sessiepersistentie met ondersteuning voor vertakking/compactie
- Rotatie van multi-account authenticatieprofielen met failover
- Provider-agnostische modelswitching

## Pakketafhankelijkheden

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Pakket            | Doel                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Kern-LLM-abstracties: `Model`, `streamSimple`, berichttypen, provider-API’s                               |
| `pi-agent-core`   | Agent-loop, tooluitvoering, `AgentMessage`-typen                                                                          |
| `pi-coding-agent` | Hoog-niveau SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, ingebouwde tools |
| `pi-tui`          | Terminal-UI-componenten (gebruikt in OpenClaw’s lokale TUI-modus)                                      |

## Bestandsstructuur

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

## Kernintegratiestroom

### 1. Een ingesloten agent uitvoeren

Het belangrijkste entrypoint is `runEmbeddedPiAgent()` in `pi-embedded-runner/run.ts`:

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

### 2. Sessiecreatie

Binnen `runEmbeddedAttempt()` (aangeroepen door `runEmbeddedPiAgent()`) wordt de pi SDK gebruikt:

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

### 3. Event-abonnement

`subscribeEmbeddedPiSession()` abonneert zich op pi’s `AgentSession`-events:

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

Afgehandelde events zijn onder andere:

- `message_start` / `message_end` / `message_update` (streaming tekst/denken)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Prompting

Na de setup wordt de sessie geprompt:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

De SDK handelt de volledige agent-loop af: verzenden naar de LLM, uitvoeren van tool-calls en het streamen van antwoorden.

## Tool-architectuur

### Tool-pijplijn

1. **Basistools**: pi’s `codingTools` (read, bash, edit, write)
2. **Aangepaste vervangingen**: OpenClaw vervangt bash door `exec`/`process` en past read/edit/write aan voor de sandbox
3. **OpenClaw-tools**: messaging, browser, canvas, sessies, cron, gateway, enz.
4. **Kanaaltools**: Discord/Telegram/Slack/WhatsApp-specifieke actietools
5. **Beleidsfiltering**: tools gefilterd op profiel, provider, agent, groep en sandbox-beleid
6. **Schema-normalisatie**: schema’s opgeschoond voor Gemini/OpenAI-eigenaardigheden
7. **AbortSignal-wrapping**: tools gewrapt om abort-signalen te respecteren

### Tooldefinitie-adapter

pi-agent-core’s `AgentTool` heeft een andere `execute`-signatuur dan pi-coding-agent’s `ToolDefinition`. De adapter in `pi-tool-definition-adapter.ts` overbrugt dit:

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

### Tool-splitsingsstrategie

`splitSdkTools()` geeft alle tools door via `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Dit zorgt ervoor dat OpenClaw’s beleidsfiltering, sandbox-integratie en uitgebreide toolset consistent blijven over providers heen.

## Constructie van de systeemprompt

De systeemprompt wordt opgebouwd in `buildAgentSystemPrompt()` (`system-prompt.ts`). Deze stelt een volledige prompt samen met secties zoals Tooling, Tool Call Style, veiligheidsrichtlijnen, OpenClaw CLI-referentie, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, runtime-metadata, plus Memory en Reactions wanneer ingeschakeld, en optionele contextbestanden en extra systeemprompt-inhoud. Secties worden ingekort voor de minimale promptmodus die door subagents wordt gebruikt.

De prompt wordt toegepast na het aanmaken van de sessie via `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Sessiebeheer

### Sessiebestanden

Sessies zijn JSONL-bestanden met een boomstructuur (id/parentId-koppeling). Pi’s `SessionManager` verzorgt persistentie:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw wrapt dit met `guardSessionManager()` voor veiligheid van toolresultaten.

### Sessiecaching

`session-manager-cache.ts` cachet SessionManager-instanties om herhaald parsen van bestanden te voorkomen:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Geschiedenisbeperking

`limitHistoryTurns()` trimt de conversatiegeschiedenis op basis van kanaaltype (DM versus groep).

### Compaction

Auto-compactie wordt geactiveerd bij contextoverloop. `compactEmbeddedPiSessionDirect()` handelt handmatige compactie af:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Authenticatie & modelresolutie

### Auth-profielen

OpenClaw onderhoudt een auth-profielstore met meerdere API-sleutels per provider:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profielen roteren bij fouten met cooldown-tracking:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Modelresolutie

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

`FailoverError` triggert model-fallback wanneer geconfigureerd:

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

## Pi-extensies

OpenClaw laadt aangepaste pi-extensies voor gespecialiseerd gedrag:

### Beveiligde Compactie

`pi-extensions/compaction-safeguard.ts` voegt guardrails toe aan compactie, waaronder adaptieve tokenbudgettering plus samenvattingen van toolfouten en bestandsoperaties:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Contextpruning

`pi-extensions/context-pruning.ts` implementeert contextpruning op basis van cache-TTL:

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

## Streaming & blokantwoorden

### Blokchunking

`EmbeddedBlockChunker` beheert het streamen van tekst naar afzonderlijke antwoordblokken:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Thinking-/Final-tagverwijdering

Streaming-uitvoer wordt verwerkt om `<think>`/`<thinking>`-blokken te verwijderen en `<final>`-inhoud te extraheren:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Antwoordrichtlijnen

Antwoordrichtlijnen zoals `[[media:url]]`, `[[voice]]`, `[[reply:id]]` worden geparsed en geëxtraheerd:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Fout bij afhandelen

### Foutclassificatie

`pi-embedded-helpers.ts` classificeert fouten voor passende afhandeling:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Thinking-niveau fallback

Als een thinking-niveau niet wordt ondersteund, wordt teruggevallen:

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

## Sandbox-integratie

Wanneer sandbox-modus is ingeschakeld, worden tools en paden beperkt:

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

## Provider-specifieke afhandeling

### Anthropic

- Opschonen van refusal magic string
- Beurtvalidatie voor opeenvolgende rollen
- Compatibiliteit van Claude Code-parameters

### Google/Gemini

- Correcties voor beurtvolgorde (`applyGoogleTurnOrderingFix`)
- Opschoning van toolschema’s (`sanitizeToolsForGoogle`)
- Opschoning van sessiegeschiedenis (`sanitizeSessionHistory`)

### OpenAI

- `apply_patch`-tool voor Codex-modellen
- Afhandeling van thinking-niveau downgrade

## TUI-integratie

OpenClaw heeft ook een lokale TUI-modus die pi-tui-componenten rechtstreeks gebruikt:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Dit biedt een interactieve terminalervaring vergelijkbaar met pi’s native modus.

## Belangrijkste verschillen met Pi CLI

| Aspect            | Pi CLI                              | OpenClaw Embedded                                                                                                 |
| ----------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Aanroep           | `pi`-opdracht / RPC                 | SDK via `createAgentSession()`                                                                                    |
| Tools             | Standaard coderings-tools           | Aangepaste OpenClaw-toolset                                                                                       |
| Systeemprompt     | AGENTS.md + prompts | Dynamisch per kanaal/context                                                                                      |
| Sessiestorage     | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (of `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Auth              | Enkele inloggegevens                | Multi-profiel met rotatie                                                                                         |
| Extensies         | Geladen vanaf schijf                | Programmatic + schijfpaden                                                                                        |
| Event-afhandeling | TUI-rendering                       | Callback-gebaseerd (onBlockReply, enz.)                                        |

## Toekomstige overwegingen

Gebieden voor mogelijke herwerking:

1. **Uitlijning van tool-signaturen**: momenteel aanpassen tussen pi-agent-core en pi-coding-agent-signaturen
2. **Wrapping van sessiebeheer**: `guardSessionManager` voegt veiligheid toe maar verhoogt de complexiteit
3. **Extensieladen**: zou pi’s `ResourceLoader` directer kunnen gebruiken
4. **Complexiteit van streaming-handler**: `subscribeEmbeddedPiSession` is groot geworden
5. **Provider-eigenaardigheden**: veel provider-specifieke codepaden die pi mogelijk zou kunnen afhandelen

## Tests

Alle bestaande tests die de pi-integratie en de extensies daarvan dekken:

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
