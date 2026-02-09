---
title: "Pi Entegrasyon Mimarisi"
---

# Pi Entegrasyon Mimarisi

Bu belge, OpenClaw’un [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) ve kardeş paketleri (`pi-ai`, `pi-agent-core`, `pi-tui`) ile nasıl entegre olduğunu ve yapay zekâ ajan yeteneklerini nasıl sağladığını açıklar.

## Genel bakış

OpenClaw, bir yapay zekâ kodlama ajanını mesajlaşma gateway (ağ geçidi) mimarisine gömmek için pi SDK’yı kullanır. Pi’yi bir alt süreç olarak başlatmak veya RPC modu kullanmak yerine, OpenClaw pi’nin `AgentSession` bileşenini `createAgentSession()` aracılığıyla doğrudan içe aktarır ve örnekler. Bu gömülü yaklaşım şunları sağlar:

- Oturum yaşam döngüsü ve olay işleme üzerinde tam denetim
- Özel araç enjeksiyonu (mesajlaşma, sandbox, kanala özgü eylemler)
- Kanal/bağlama göre sistem prompt’u özelleştirme
- Dallanma/sıkıştırma desteğiyle oturum kalıcılığı
- Yedekleme (failover) ile çoklu hesap kimlik doğrulama profili rotasyonu
- Sağlayıcıdan bağımsız model değiştirme

## Paket Bağımlılıkları

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Paket             | Amaç                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Temel LLM soyutlamaları: `Model`, `streamSimple`, mesaj türleri, sağlayıcı API’leri                           |
| `pi-agent-core`   | Ajan döngüsü, araç çalıştırma, `AgentMessage` türleri                                                                         |
| `pi-coding-agent` | Yüksek seviyeli SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, yerleşik araçlar |
| `pi-tui`          | Terminal UI bileşenleri (OpenClaw’un yerel TUI modunda kullanılır)                                         |

## Dosya Yapısı

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

## Çekirdek Entegrasyon Akışı

### 1. Gömülü Bir Ajan Çalıştırma

Ana giriş noktası, `pi-embedded-runner/run.ts` içindeki `runEmbeddedPiAgent()`’dir:

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

### 2. Oturum Oluşturma

`runEmbeddedAttempt()` içinde (`runEmbeddedPiAgent()` tarafından çağrılır) pi SDK kullanılır:

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

### 3. Olaylara Abonelik

`subscribeEmbeddedPiSession()`, pi’nin `AgentSession` olaylarına abone olur:

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

Ele alınan olaylar şunları içerir:

- `message_start` / `message_end` / `message_update` (akış hâlinde metin/düşünme)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Prompt Verme

Kurulumdan sonra oturuma prompt verilir:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK, tam ajan döngüsünü yönetir: LLM’e gönderme, araç çağrılarını yürütme, yanıtları akış hâlinde iletme.

## Araç Mimarisi

### Tool Pipeline

1. **Temel Araçlar**: pi’nin `codingTools` (read, bash, edit, write)
2. **Özel Değiştirmeler**: OpenClaw, bash’i `exec`/`process` ile değiştirir, read/edit/write’ı sandbox için özelleştirir
3. **OpenClaw Araçları**: mesajlaşma, tarayıcı, canvas, oturumlar, cron, gateway vb.
4. **Kanal Araçları**: Discord/Telegram/Slack/WhatsApp’e özgü eylem araçları
5. **Politika Filtreleme**: Araçlar profil, sağlayıcı, ajan, grup ve sandbox politikalarına göre filtrelenir
6. **Şema Normalizasyonu**: Gemini/OpenAI farklılıkları için şemalar temizlenir
7. **AbortSignal Sarmalama**: Araçlar, abort sinyallerine uyması için sarılır

### Araç Tanım Adaptörü

pi-agent-core’un `AgentTool` bileşeni, pi-coding-agent’in `ToolDefinition` bileşeninden farklı bir `execute` imzasına sahiptir. `pi-tool-definition-adapter.ts` içindeki adaptör bunu köprüler:

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

`splitSdkTools()`, tüm araçları `customTools` üzerinden geçirir:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Bu, OpenClaw’un politika filtrelemesi, sandbox entegrasyonu ve genişletilmiş araç setinin sağlayıcılar arasında tutarlı kalmasını sağlar.

## Sistem Prompt’u Oluşturma

Sistem prompt’u `buildAgentSystemPrompt()` (`system-prompt.ts`) içinde oluşturulur. Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI referansı, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata gibi bölümler ile, etkinleştirildiğinde Memory ve Reactions, ayrıca isteğe bağlı bağlam dosyaları ve ek sistem prompt içeriği bir araya getirilir. Alt ajanlar tarafından kullanılan minimal prompt modu için bölümler kırpılır.

Prompt, oturum oluşturulduktan sonra `applySystemPromptOverrideToSession()` aracılığıyla uygulanır:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Oturum Yönetimi

### Session Files

Oturumlar, ağaç yapısına sahip (id/parentId bağlantılı) JSONL dosyalarıdır. Kalıcılığı pi’nin `SessionManager` bileşeni yönetir:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw bunu, araç sonucu güvenliği için `guardSessionManager()` ile sarar.

### Session Caching

`session-manager-cache.ts`, tekrarlanan dosya ayrıştırmalarını önlemek için SessionManager örneklerini önbelleğe alır:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Geçmiş Sınırlandırma

`limitHistoryTurns()`, kanal türüne (DM vs grup) göre konuşma geçmişini kırpar.

### Sıkıştırma

Bağlam taşması durumunda otomatik sıkıştırma tetiklenir. Manuel sıkıştırmayı `compactEmbeddedPiSessionDirect()` yönetir:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Kimlik Doğrulama ve Model Çözümleme

### Kimlik Doğrulama Profilleri

OpenClaw, sağlayıcı başına birden fazla API anahtarı içeren bir kimlik doğrulama profili deposu tutar:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profiller, bekleme süresi takibiyle hatalarda döndürülür:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Model Çözümleme

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

Yapılandırıldığında, `FailoverError` model geri dönüşünü tetikler:

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

## Pi Uzantıları

OpenClaw, özel davranışlar için özel pi uzantıları yükler:

### Sıkıştırma Güvencesi

`pi-extensions/compaction-safeguard.ts`, uyarlanabilir token bütçeleme ile birlikte araç hatası ve dosya işlemi özetlerini içeren sıkıştırma korumaları ekler:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Context Pruning

`pi-extensions/context-pruning.ts`, önbellek TTL tabanlı bağlam budamayı uygular:

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

## Akış ve Blok Yanıtlar

### Blok Parçalama

`EmbeddedBlockChunker`, akış hâlindeki metni ayrık yanıt bloklarına böler:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Düşünme/Nihai Etiket Ayıklama

Akış çıktısı, `<think>`/`<thinking>` bloklarını ayıklamak ve `<final>` içeriğini çıkarmak için işlenir:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Yanıt Yönergeleri

`[[media:url]]`, `[[voice]]`, `[[reply:id]]` gibi yanıt yönergeleri ayrıştırılır ve çıkarılır:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Error Handling

### Hata Sınıflandırma

`pi-embedded-helpers.ts`, uygun işleme için hataları sınıflandırır:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Düşünme Seviyesi Geri Dönüşü

Bir düşünme seviyesi desteklenmiyorsa, geri dönüş yapılır:

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

## Sandbox Entegrasyonu

Sandbox modu etkinleştirildiğinde, araçlar ve yollar sınırlandırılır:

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

## Sağlayıcıya Özgü İşleme

### Anthropic

- Reddetme sihirli dizesinin temizlenmesi
- Ardışık roller için tur doğrulaması
- Claude Code parametre uyumluluğu

### Google/Gemini

- Tur sıralaması düzeltmeleri (`applyGoogleTurnOrderingFix`)
- Araç şeması temizleme (`sanitizeToolsForGoogle`)
- Oturum geçmişi temizleme (`sanitizeSessionHistory`)

### OpenAI

- Codex modelleri için `apply_patch` aracı
- Düşünme seviyesi düşürme işleme

## TUI Entegrasyonu

OpenClaw ayrıca pi-tui bileşenlerini doğrudan kullanan yerel bir TUI moduna sahiptir:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Bu, pi’nin yerel moduna benzer etkileşimli terminal deneyimini sağlar.

## Pi CLI’den Temel Farklar

| Aspect           | Pi CLI                                 | OpenClaw Gömülü                                                                                                     |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Uzantılar        | `pi` komutu / RPC                      | `createAgentSession()` üzerinden SDK                                                                                |
| Araçlar          | Varsayılan kodlama araçları            | Özel OpenClaw araç seti                                                                                             |
| Sistem prompt’u  | AGENTS.md + prompt’lar | Kanal/bağlama göre dinamik                                                                                          |
| Oturum depolama  | `~/.pi/agent/sessions/`                | `~/.openclaw/agents/<agentId>/sessions/` (veya `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Kimlik doğrulama | Tek kimlik bilgisi                     | Rotasyonlu çoklu profil                                                                                             |
| Extensions       | Diskten yüklenir                       | Programatik + disk yolları                                                                                          |
| Olay işleme      | TUI çizimi                             | Geri çağrı tabanlı (onBlockReply vb.)                                            |

## Gelecek Değerlendirmeleri

Olası yeniden çalışma alanları:

1. **Araç imzası hizalaması**: Şu anda pi-agent-core ve pi-coding-agent imzaları arasında uyarlama yapılıyor
2. **Oturum yöneticisi sarmalama**: `guardSessionManager` güvenlik ekler ancak karmaşıklığı artırır
3. **Uzantı yükleme**: pi’nin `ResourceLoader` bileşeni daha doğrudan kullanılabilir
4. **Akış işleyici karmaşıklığı**: `subscribeEmbeddedPiSession` büyümüş durumda
5. **Sağlayıcı farklılıkları**: pi’nin potansiyel olarak ele alabileceği birçok sağlayıcıya özgü kod yolu

## Testler

Pi entegrasyonunu ve uzantılarını kapsayan mevcut tüm testler:

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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (canlı)
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
