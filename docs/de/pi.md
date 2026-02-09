---
title: "Pi-Integrationsarchitektur"
---

# Pi-Integrationsarchitektur

Dieses Dokument beschreibt, wie OpenClaw mit [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) und dessen Schwesterpaketen (`pi-ai`, `pi-agent-core`, `pi-tui`) integriert ist, um seine KI-Agentenfunktionen zu ermöglichen.

## Überblick

OpenClaw verwendet das pi SDK, um einen KI-Coding-Agenten in seine Messaging-Gateway-Architektur einzubetten. Anstatt pi als Subprozess zu starten oder den RPC-Modus zu verwenden, importiert und instanziiert OpenClaw pi's `AgentSession` direkt über `createAgentSession()`. Dieser eingebettete Ansatz bietet:

- Volle Kontrolle über den Sitzungslebenszyklus und die Ereignisbehandlung
- Benutzerdefinierte Werkzeug-Injektion (Messaging, sandbox, kanalspezifische Aktionen)
- Anpassung des System-Prompts pro Kanal/Kontext
- Sitzungspersistenz mit Verzweigungs-/Kompaktionsunterstützung
- Rotation mehrerer Auth-Profile pro Anbieter mit Failover
- Anbieteragnostisches Modell-Switching

## Paketabhängigkeiten

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Paket             | Zweck                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Zentrale LLM-Abstraktionen: `Model`, `streamSimple`, Nachrichtentypen, Anbieter-APIs                      |
| `pi-agent-core`   | Agenten-Loop, Werkzeugausführung, `AgentMessage`-Typen                                                                    |
| `pi-coding-agent` | High-Level-SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, integrierte Tools |
| `pi-tui`          | Terminal-UI-Komponenten (verwendet im lokalen TUI-Modus von OpenClaw)                                  |

## Dateistruktur

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

## Kernintegrationsfluss

### 1. Ausführen eines eingebetteten Agenten

Der zentrale Einstiegspunkt ist `runEmbeddedPiAgent()` in `pi-embedded-runner/run.ts`:

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

### 2. Sitzungserstellung

Innerhalb von `runEmbeddedAttempt()` (aufgerufen von `runEmbeddedPiAgent()`) wird das pi SDK verwendet:

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

### 3. Ereignisabonnement

`subscribeEmbeddedPiSession()` abonniert pi's `AgentSession`-Ereignisse:

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

Zu den behandelten Ereignissen gehören:

- `message_start` / `message_end` / `message_update` (Streaming von Text/Thinking)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Prompting

Nach dem Setup wird die Sitzung gepromptet:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

Das SDK handhabt den vollständigen Agenten-Loop: Senden an das LLM, Ausführen von Werkzeugaufrufen, Streaming der Antworten.

## Werkzeugarchitektur

### Werkzeug-Pipeline

1. **Basis-Tools**: pi's `codingTools` (read, bash, edit, write)
2. **Benutzerdefinierte Ersetzungen**: OpenClaw ersetzt bash durch `exec`/`process` und passt read/edit/write für die sandbox an
3. **OpenClaw-Tools**: Messaging, Browser, Canvas, Sitzungen, Cron, Gateway usw.
4. **Kanal-Tools**: Aktions-Tools spezifisch für Discord/Telegram/Slack/WhatsApp
5. **Richtlinienfilterung**: Tools werden nach Profil-, Anbieter-, Agenten-, Gruppen- und Sandbox-Richtlinien gefiltert
6. **Schema-Normalisierung**: Schemas werden für Gemini/OpenAI-Eigenheiten bereinigt
7. **AbortSignal-Wrapping**: Tools werden so gekapselt, dass Abort-Signale berücksichtigt werden

### Tool-Definitions-Adapter

`AgentTool` aus pi-agent-core hat eine andere `execute`-Signatur als `ToolDefinition` aus pi-coding-agent. Der Adapter in `pi-tool-definition-adapter.ts` überbrückt dies:

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

### Tool-Split-Strategie

`splitSdkTools()` übergibt alle Tools über `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Dies stellt sicher, dass OpenClaws Richtlinienfilterung, Sandbox-Integration und erweiterter Werkzeugumfang konsistent über alle Anbieter hinweg bleiben.

## Konstruktion des System-Prompts

Der System-Prompt wird in `buildAgentSystemPrompt()` (`system-prompt.ts`) erstellt. Er setzt einen vollständigen Prompt mit Abschnitten zusammen, darunter Tooling, Tool-Call-Stil, Sicherheitsleitplanken, OpenClaw-CLI-Referenz, Skills, Dokumentation, Workspace, Sandbox, Messaging, Antwort-Tags, Stimme, Stille Antworten, Heartbeats, Laufzeit-Metadaten sowie optional Speicher und Reaktionen, Kontextdateien und zusätzlicher System-Prompt-Inhalt. Abschnitte werden für den Minimal-Prompt-Modus gekürzt, der von Subagenten verwendet wird.

Der Prompt wird nach der Sitzungserstellung über `applySystemPromptOverrideToSession()` angewendet:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Sitzungsverwaltung

### Sitzungsdateien

Sitzungen sind JSONL-Dateien mit Baumstruktur (id/parentId-Verknüpfung). Pi's `SessionManager` übernimmt die Persistenz:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw kapselt dies mit `guardSessionManager()` für die Sicherheit von Werkzeugergebnissen.

### Sitzungs-Caching

`session-manager-cache.ts` cached SessionManager-Instanzen, um wiederholtes Parsen von Dateien zu vermeiden:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Verlaufsbegrenzung

`limitHistoryTurns()` kürzt den Gesprächsverlauf basierend auf dem Kanaltyp (Direktnachricht vs. Gruppe).

### Verdichtung

Auto-Kompaktierung wird bei Kontextüberlauf ausgelöst. `compactEmbeddedPiSessionDirect()` behandelt die manuelle Kompaktierung:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Authentifizierung & Modellauflösung

### Auth-Profile

OpenClaw verwaltet einen Auth-Profil-Speicher mit mehreren API-Schlüsseln pro Anbieter:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profile rotieren bei Fehlern mit Cooldown-Tracking:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Modellauflösung

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

`FailoverError` löst bei entsprechender Konfiguration ein Modell-Fallback aus:

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

## Pi-Erweiterungen

OpenClaw lädt benutzerdefinierte pi-Erweiterungen für spezialisiertes Verhalten:

### Verdichtungssicherungsschutz

`pi-extensions/compaction-safeguard.ts` fügt Leitplanken zur Kompaktierung hinzu, einschließlich adaptiver Token-Budgetierung sowie Zusammenfassungen von Werkzeugfehlern und Dateioperationen:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Kontext-Beschneidung

`pi-extensions/context-pruning.ts` implementiert eine kontextbezogene Beschneidung auf Basis von Cache-TTL:

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

## Streaming & Blockantworten

### Block-Chunking

`EmbeddedBlockChunker` verwaltet das Streaming von Text in diskrete Antwortblöcke:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Entfernen von Thinking/Final-Tags

Streaming-Ausgaben werden verarbeitet, um `<think>`/`<thinking>`-Blöcke zu entfernen und `<final>`-Inhalte zu extrahieren:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Antwortdirektiven

Antwortdirektiven wie `[[media:url]]`, `[[voice]]`, `[[reply:id]]` werden geparst und extrahiert:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Fehlerbehandlung

### Fehlerklassifizierung

`pi-embedded-helpers.ts` klassifiziert Fehler für eine angemessene Behandlung:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Fallback für Thinking-Level

Wenn ein Thinking-Level nicht unterstützt wird, erfolgt ein Fallback:

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

## Sandbox-Integration

Wenn der Sandbox-Modus aktiviert ist, werden Tools und Pfade eingeschränkt:

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

## Anbieterspezifische Behandlung

### Anthropic

- Bereinigung von Refusal-Magic-Strings
- Turn-Validierung für aufeinanderfolgende Rollen
- Kompatibilität der Claude-Code-Parameter

### Google/Gemini

- Korrekturen der Turn-Reihenfolge (`applyGoogleTurnOrderingFix`)
- Bereinigung von Tool-Schemas (`sanitizeToolsForGoogle`)
- Bereinigung des Sitzungsverlaufs (`sanitizeSessionHistory`)

### OpenAI

- `apply_patch`-Tool für Codex-Modelle
- Behandlung der Herabstufung des Thinking-Levels

## TUI-Integration

OpenClaw verfügt außerdem über einen lokalen TUI-Modus, der pi-tui-Komponenten direkt verwendet:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Dies bietet eine interaktive Terminal-Erfahrung ähnlich dem nativen Modus von pi.

## Zentrale Unterschiede zur Pi-CLI

| Aspekt             | Pi-CLI                              | OpenClaw Embedded                                                                                                   |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Aufruf             | `pi`-Befehl / RPC                   | SDK über `createAgentSession()`                                                                                     |
| Tools              | Standard-Coding-Tools               | Benutzerdefinierte OpenClaw-Tool-Suite                                                                              |
| System-Prompt      | AGENTS.md + Prompts | Dynamisch pro Kanal/Kontext                                                                                         |
| Sitzungsspeicher   | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (oder `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Auth               | Einzelne Anmeldeinformation         | Multi-Profil mit Rotation                                                                                           |
| Erweiterungen      | Von der Festplatte geladen          | Programmgesteuert + Festplattenpfade                                                                                |
| Ereignisbehandlung | TUI-Rendering                       | Callback-basiert (onBlockReply usw.)                                             |

## Zukünftige Überlegungen

Bereiche für potenzielle Überarbeitung:

1. **Ausrichtung der Tool-Signaturen**: Derzeit Anpassung zwischen pi-agent-core- und pi-coding-agent-Signaturen
2. **Wrapping des Session-Managers**: `guardSessionManager` erhöht die Sicherheit, steigert jedoch die Komplexität
3. **Laden von Erweiterungen**: Könnte pi's `ResourceLoader` direkter nutzen
4. **Komplexität des Streaming-Handlers**: `subscribeEmbeddedPiSession` ist stark gewachsen
5. **Anbieter-Eigenheiten**: Viele anbieterspezifische Codepfade, die pi potenziell handhaben könnte

## Tests

Alle bestehenden Tests, die die pi-Integration und ihre Erweiterungen abdecken:

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
