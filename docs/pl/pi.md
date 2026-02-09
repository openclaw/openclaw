---
title: "Architektura integracji Pi"
---

# Architektura integracji Pi

Ten dokument opisuje, w jaki sposób OpenClaw integruje się z [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) oraz jego pakietami siostrzanymi (`pi-ai`, `pi-agent-core`, `pi-tui`), aby zasilać możliwości agenta AI.

## Przegląd

OpenClaw używa SDK pi do osadzenia agenta kodującego AI w swojej architekturze gateway wiadomości. Zamiast uruchamiać pi jako podproces lub używać trybu RPC, OpenClaw bezpośrednio importuje i instancjonuje `AgentSession` pi za pośrednictwem `createAgentSession()`. To podejście osadzone zapewnia:

- Pełną kontrolę nad cyklem życia sesji i obsługą zdarzeń
- Wstrzykiwanie niestandardowych narzędzi (wiadomości, sandbox, akcje specyficzne dla kanału)
- Dostosowanie promptu systemowego na kanał/kontekst
- Trwałość sesji z obsługą rozgałęzień i kompaktowania
- Rotację profili uwierzytelniania wielu kont z przełączaniem awaryjnym
- Niezależne od dostawcy przełączanie modeli

## Zależności pakietów

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Pakiet            | Przeznaczenie                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Podstawowe abstrakcje LLM: `Model`, `streamSimple`, typy wiadomości, API dostawców                                 |
| `pi-agent-core`   | Pętla agenta, wykonywanie narzędzi, typy `AgentMessage`                                                                            |
| `pi-coding-agent` | SDK wysokiego poziomu: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, narzędzia wbudowane |
| `pi-tui`          | Komponenty UI terminala (używane w lokalnym trybie TUI OpenClaw)                                                |

## Struktura plików

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

## Główny przepływ integracji

### 1. Uruchamianie osadzonego agenta

Głównym punktem wejścia jest `runEmbeddedPiAgent()` w `pi-embedded-runner/run.ts`:

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

### 2. Tworzenie sesji

Wewnątrz `runEmbeddedAttempt()` (wywoływanego przez `runEmbeddedPiAgent()`) używany jest SDK pi:

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

### 3. Subskrypcja zdarzeń

`subscribeEmbeddedPiSession()` subskrybuje zdarzenia `AgentSession` pi:

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

Obsługiwane zdarzenia obejmują:

- `message_start` / `message_end` / `message_update` (strumieniowanie tekstu/myślenia)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Promptowanie

Po konfiguracji sesja jest promptowana:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK obsługuje pełną pętlę agenta: wysyłanie do LLM, wykonywanie wywołań narzędzi, strumieniowanie odpowiedzi.

## Architektura narzędzi

### Pipeline narzędzi

1. **Narzędzia bazowe**: `codingTools` pi (read, bash, edit, write)
2. **Niestandardowe zastąpienia**: OpenClaw zastępuje bash przez `exec`/`process`, dostosowuje read/edit/write do sandbox
3. **Narzędzia OpenClaw**: wiadomości, przeglądarka, canvas, sesje, cron, gateway itd.
4. **Narzędzia kanałowe**: narzędzia akcji specyficzne dla Discord/Telegram/Slack/WhatsApp
5. **Filtrowanie polityk**: narzędzia filtrowane według profilu, dostawcy, agenta, grupy, polityk sandbox
6. **Normalizacja schematów**: schematy czyszczone pod kątem osobliwości Gemini/OpenAI
7. **Opakowanie AbortSignal**: narzędzia opakowane z poszanowaniem sygnałów abort

### Adapter definicji narzędzi

`AgentTool` z pi-agent-core ma inną sygnaturę `execute` niż `ToolDefinition` z pi-coding-agent. Adapter w `pi-tool-definition-adapter.ts` to mostkuje:

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

### Strategia podziału narzędzi

`splitSdkTools()` przekazuje wszystkie narzędzia przez `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Zapewnia to, że filtrowanie polityk OpenClaw, integracja sandbox oraz rozszerzony zestaw narzędzi pozostają spójne u wszystkich dostawców.

## Konstrukcja promptu systemowego

Prompt systemowy jest budowany w `buildAgentSystemPrompt()` (`system-prompt.ts`). Składa on pełny prompt z sekcjami obejmującymi Tooling, Tool Call Style, Safety guardrails, referencję OpenClaw CLI, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, metadane runtime, a także Memory i Reactions, gdy są włączone, oraz opcjonalne pliki kontekstu i dodatkową treść promptu systemowego. Sekcje są przycinane dla trybu minimalnego promptu używanego przez subagentów.

Prompt jest stosowany po utworzeniu sesji przez `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Zarządzanie sesją

### Pliki sesji

Sesje są plikami JSONL o strukturze drzewa (powiązania id/parentId). Trwałość obsługuje `SessionManager` pi:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw opakowuje to przez `guardSessionManager()` dla bezpieczeństwa wyników narzędzi.

### Cache sesji

`session-manager-cache.ts` buforuje instancje SessionManager, aby uniknąć wielokrotnego parsowania plików:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Ograniczanie historii

`limitHistoryTurns()` przycina historię rozmów w zależności od typu kanału (DM vs grupa).

### Kompakcja a przycinanie

Automatyczne kompaktowanie uruchamia się przy przepełnieniu kontekstu. Ręczne kompaktowanie obsługuje `compactEmbeddedPiSessionDirect()`:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Uwierzytelnianie i rozwiązywanie modeli

### Profile uwierzytelniania

OpenClaw utrzymuje magazyn profili uwierzytelniania z wieloma kluczami API na dostawcę:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profile rotują się przy błędach z uwzględnieniem śledzenia cooldownu:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Rozwiązywanie modeli

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

### Nieudane

`FailoverError` uruchamia fallback modelu, gdy jest skonfigurowany:

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

## Rozszerzenia Pi

OpenClaw ładuje niestandardowe rozszerzenia pi dla wyspecjalizowanych zachowań:

### Zabezpieczenie kompaktowania

`pi-extensions/compaction-safeguard.ts` dodaje guardrails do kompaktowania, w tym adaptacyjne budżetowanie tokenów oraz podsumowania awarii narzędzi i operacji na plikach:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Przycinanie kontekstu

`pi-extensions/context-pruning.ts` implementuje przycinanie kontekstu oparte na cache-TTL:

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

## Strumieniowanie i odpowiedzi blokowe

### Fragmentacja bloków

`EmbeddedBlockChunker` zarządza strumieniowaniem tekstu do dyskretnych bloków odpowiedzi:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Usuwanie tagów myślenia/finału

Wyjście strumieniowe jest przetwarzane w celu usunięcia bloków `<think>`/`<thinking>` i wyodrębnienia treści `<final>`:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Dyrektywy odpowiedzi

Dyrektywy odpowiedzi, takie jak `[[media:url]]`, `[[voice]]`, `[[reply:id]]`, są parsowane i wyodrębniane:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Obsługa błędów

### Klasyfikacja błędów

`pi-embedded-helpers.ts` klasyfikuje błędy do odpowiedniej obsługi:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Fallback poziomu myślenia

Jeśli poziom myślenia jest nieobsługiwany, następuje fallback:

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

## Integracja sandbox

Gdy tryb sandbox jest włączony, narzędzia i ścieżki są ograniczane:

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

## Obsługa specyficzna dla dostawców

### Anthropic

- Skanowanie magicznego ciągu znaków odmowa
- Włącz weryfikację kolejnych ról
- Zgodność parametrów Claude Code

### Google/Gemini

- Poprawki kolejności tur (`applyGoogleTurnOrderingFix`)
- Sanitizacja schematów narzędzi (`sanitizeToolsForGoogle`)
- Sanitizacja historii sesji (`sanitizeSessionHistory`)

### OpenAI

- Narzędzie `apply_patch` dla modeli Codex
- Obsługa obniżania poziomu myślenia

## Integracja TUI

OpenClaw posiada także lokalny tryb TUI, który bezpośrednio używa komponentów pi-tui:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Zapewnia to interaktywne doświadczenie terminalowe podobne do natywnego trybu pi.

## Kluczowe różnice względem Pi CLI

| Aspekt               | Pi CLI                              | OpenClaw osadzony                                                                                                  |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Wywołanie            | polecenie `pi` / RPC                | SDK przez `createAgentSession()`                                                                                   |
| Narzędzia            | Domyślne narzędzia kodujące         | Niestandardowy zestaw narzędzi OpenClaw                                                                            |
| Prompt systemowy     | AGENTS.md + prompty | Dynamiczny per kanał/kontekst                                                                                      |
| Przechowywanie sesji | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (lub `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Uwierzytelnianie     | Pojedyncze poświadczenie            | Wiele profili z rotacją                                                                                            |
| Rozszerzenia         | Ładowane z dysku                    | Programowe + ścieżki dyskowe                                                                                       |
| Obsługa zdarzeń      | Renderowanie TUI                    | Oparte na callbackach (onBlockReply itd.)                                       |

## Przyszłe rozważania

Obszary potencjalnych zmian:

1. **Dopasowanie sygnatur narzędzi**: Obecnie adaptacja między sygnaturami pi-agent-core i pi-coding-agent
2. **Opakowanie menedżera sesji**: `guardSessionManager` dodaje bezpieczeństwo, ale zwiększa złożoność
3. **Ładowanie rozszerzeń**: Możliwość bardziej bezpośredniego użycia `ResourceLoader` pi
4. **Złożoność obsługi strumieniowania**: `subscribeEmbeddedPiSession` znacznie się rozrósł
5. **Osobliwości dostawców**: Wiele ścieżek kodu specyficznych dla dostawców, które pi mógłby potencjalnie obsłużyć

## Testy

Wszystkie istniejące testy obejmujące integrację pi i jej rozszerzenia:

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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (na żywo)
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
