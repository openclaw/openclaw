---
title: "Pi انضمامی معماری"
---

# Pi انضمامی معماری

یہ دستاویز بیان کرتی ہے کہ OpenClaw کس طرح [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) اور اس کے ہم نوا پیکجز (`pi-ai`, `pi-agent-core`, `pi-tui`) کے ساتھ انضمام کرتا ہے تاکہ اپنی AI ایجنٹ صلاحیتوں کو طاقت فراہم کر سکے۔

## جائزہ

OpenClaw uses the pi SDK to embed an AI coding agent into its messaging gateway architecture. Instead of spawning pi as a subprocess or using RPC mode, OpenClaw directly imports and instantiates pi's `AgentSession` via `createAgentSession()`. This embedded approach provides:

- سیشن لائف سائیکل اور ایونٹ ہینڈلنگ پر مکمل کنٹرول
- حسبِ ضرورت ٹول انجیکشن (میسجنگ، sandbox، چینل کے مطابق اعمال)
- فی چینل/سیاق سسٹم پرامپٹ کی تخصیص
- برانچنگ/کمپیکشن سپورٹ کے ساتھ سیشن کی پائیداری
- فیل اوور کے ساتھ ملٹی اکاؤنٹ auth پروفائل روٹیشن
- فراہم کنندہ سے غیر وابستہ ماڈل سوئچنگ

## پیکیج انحصارات

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Package           | Purpose                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | بنیادی LLM تجریدات: `Model`, `streamSimple`, پیغام کی اقسام، فراہم کنندہ APIs                        |
| `pi-agent-core`   | ایجنٹ لوپ، ٹول ایکزیکیوشن، `AgentMessage` اقسام                                                                      |
| `pi-coding-agent` | اعلیٰ سطحی SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, بلٹ اِن ٹولز |
| `pi-tui`          | ٹرمینل UI اجزاء (OpenClaw کے لوکل TUI موڈ میں استعمال ہوتے ہیں)                                   |

## فائل اسٹرکچر

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

## بنیادی انضمامی بہاؤ

### 1. Running an Embedded Agent

اہم انٹری پوائنٹ `runEmbeddedPiAgent()` ہے جو `pi-embedded-runner/run.ts` میں واقع ہے:

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

`runEmbeddedAttempt()` کے اندر (جسے `runEmbeddedPiAgent()` کال کرتا ہے)، pi SDK استعمال کیا جاتا ہے:

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

`subscribeEmbeddedPiSession()`، pi کے `AgentSession` ایونٹس کو سبسکرائب کرتا ہے:

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

ہینڈل کیے جانے والے ایونٹس میں شامل ہیں:

- `message_start` / `message_end` / `message_update` (اسٹریمنگ متن/سوچ)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 1. 4. 2. پرامپٹنگ

سیٹ اپ کے بعد، سیشن کو پرامپٹ کیا جاتا ہے:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK مکمل ایجنٹ لوپ سنبھالتا ہے: LLM کو بھیجنا، ٹول کالز کو ایکزیکیوٹ کرنا، اور اسٹریمنگ جوابات۔

## ٹول معماری

### ٹول پائپ لائن

1. **بنیادی ٹولز**: pi کے `codingTools` (read, bash, edit, write)
2. **حسبِ ضرورت متبادلات**: OpenClaw bash کو `exec`/`process` سے بدلتا ہے، اور sandbox کے لیے read/edit/write کو حسبِ ضرورت بناتا ہے
3. **OpenClaw ٹولز**: میسجنگ، براؤزر، کینوس، سیشنز، cron، gateway، وغیرہ
4. **چینل ٹولز**: Discord/Telegram/Slack/WhatsApp کے لیے مخصوص ایکشن ٹولز
5. **پالیسی فلٹرنگ**: پروفائل، فراہم کنندہ، ایجنٹ، گروپ، sandbox پالیسیوں کے مطابق ٹولز کی فلٹرنگ
6. **اسکیما نارملائزیشن**: Gemini/OpenAI کی خامیوں کے لیے اسکیما کی صفائی
7. **AbortSignal ریپنگ**: ٹولز کو abort سگنلز کا احترام کرنے کے لیے ریپ کیا جاتا ہے

### ٹول ڈیفینیشن ایڈاپٹر

3. pi-agent-core کا `AgentTool`، pi-coding-agent کے `ToolDefinition` سے مختلف `execute` سگنیچر رکھتا ہے۔ 4. `pi-tool-definition-adapter.ts` میں موجود ایڈاپٹر اس خلا کو پُر کرتا ہے:

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

### ٹول اسپلٹ حکمتِ عملی

`splitSdkTools()` تمام ٹولز کو `customTools` کے ذریعے پاس کرتا ہے:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

یہ اس بات کو یقینی بناتا ہے کہ OpenClaw کی پالیسی فلٹرنگ، sandbox انضمام، اور توسیع شدہ ٹول سیٹ تمام فراہم کنندگان میں یکساں رہے۔

## سسٹم پرامپٹ کی تشکیل

5. سسٹم پرامپٹ `buildAgentSystemPrompt()` (`system-prompt.ts`) میں بنایا جاتا ہے۔ 6. یہ مختلف حصوں کے ساتھ ایک مکمل پرامپٹ تیار کرتا ہے جن میں Tooling، Tool Call Style، Safety guardrails، OpenClaw CLI reference، Skills، Docs، Workspace، Sandbox، Messaging، Reply Tags، Voice، Silent Replies، Heartbeats، Runtime metadata شامل ہیں، اور جب فعال ہوں تو Memory اور Reactions بھی، نیز اختیاری context فائلیں اور اضافی سسٹم پرامپٹ مواد۔ Sections are trimmed for minimal prompt mode used by subagents.

یہ پرامپٹ سیشن کی تخلیق کے بعد `applySystemPromptOverrideToSession()` کے ذریعے لاگو کیا جاتا ہے:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## سیشن مینجمنٹ

### سیشن فائلز

8. سیشنز JSONL فائلیں ہوتی ہیں جن میں درختی ساخت ہوتی ہے (id/parentId لنکنگ کے ساتھ)۔ Pi's `SessionManager` handles persistence:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw ٹول رزلٹ سیفٹی کے لیے اسے `guardSessionManager()` کے ساتھ ریپ کرتا ہے۔

### سیشن کیشنگ

`session-manager-cache.ts`، SessionManager انسٹینسز کو کیش کرتا ہے تاکہ بار بار فائل پارسنگ سے بچا جا سکے:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### ہسٹری کی حد بندی

`limitHistoryTurns()`، چینل کی قسم (DM بمقابلہ گروپ) کی بنیاد پر گفتگو کی ہسٹری کو تراشتا ہے۔

### کمپیکشن

10. کانٹیکسٹ اوورفلو پر خودکار کمپیکشن ٹرگر ہو جاتی ہے۔ 11. `compactEmbeddedPiSessionDirect()` دستی کمپیکشن کو سنبھالتا ہے:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## تصدیق اور ماڈل ریزولوشن

### Auth پروفائلز

OpenClaw ہر فراہم کنندہ کے لیے متعدد API کلیدوں کے ساتھ auth پروفائل اسٹور برقرار رکھتا ہے:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

ناکامیوں پر پروفائلز کول ڈاؤن ٹریکنگ کے ساتھ روٹیٹ ہوتے ہیں:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### ماڈل ریزولوشن

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

### فیل اوور

`FailoverError`، کنفیگر ہونے پر ماڈل فالبیک کو ٹرگر کرتا ہے:

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

## Pi ایکسٹینشنز

OpenClaw خصوصی رویّوں کے لیے حسبِ ضرورت pi ایکسٹینشنز لوڈ کرتا ہے:

### کمپیکشن سیف گارڈ

`pi-extensions/compaction-safeguard.ts` کمپیکشن میں گارڈ ریلز شامل کرتا ہے، جن میں adaptive token budgeting کے ساتھ ٹول فیلیر اور فائل آپریشن خلاصے شامل ہیں:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### سیاق کی تراش خراش

`pi-extensions/context-pruning.ts` cache-TTL پر مبنی سیاق pruning نافذ کرتا ہے:

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

## اسٹریمنگ اور بلاک جوابات

### بلاک چنکنگ

`EmbeddedBlockChunker`، اسٹریمنگ متن کو علیحدہ جوابی بلاکس میں منظم کرتا ہے:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Thinking/Final ٹیگ ہٹانا

اسٹریمنگ آؤٹ پٹ کو پروسیس کیا جاتا ہے تاکہ `<think>`/`<thinking>` بلاکس ہٹا کر `<final>` مواد نکالا جا سکے:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### جوابی ہدایات

`[[media:url]]`, `[[voice]]`, `[[reply:id]]` جیسی جوابی ہدایات کو پارس اور ایکسٹریکٹ کیا جاتا ہے:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## غلطیوں کا ازالہ

### غلطی کی درجہ بندی

`pi-embedded-helpers.ts` مناسب ہینڈلنگ کے لیے غلطیوں کی درجہ بندی کرتا ہے:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### تھنکنگ لیول فالبیک

اگر تھنکنگ لیول سپورٹ نہ ہو تو فالبیک کیا جاتا ہے:

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

## Sandbox انضمام

جب sandbox موڈ فعال ہو، تو ٹولز اور راستے محدود کر دیے جاتے ہیں:

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

## فراہم کنندہ کے مطابق ہینڈلنگ

### Anthropic

- انکار کے magic string کی صفائی
- متواتر رولز کے لیے ٹرن ویلیڈیشن
- Claude Code پیرامیٹر مطابقت

### Google/Gemini

- ٹرن آرڈرنگ فکسز (`applyGoogleTurnOrderingFix`)
- ٹول اسکیما کی صفائی (`sanitizeToolsForGoogle`)
- سیشن ہسٹری کی صفائی (`sanitizeSessionHistory`)

### OpenAI

- Codex ماڈلز کے لیے `apply_patch` ٹول
- تھنکنگ لیول ڈاؤن گریڈ ہینڈلنگ

## TUI انضمام

OpenClaw کے پاس ایک لوکل TUI موڈ بھی ہے جو pi-tui اجزاء کو براہِ راست استعمال کرتا ہے:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

یہ pi کے نیٹو موڈ سے ملتا جلتا انٹرایکٹو ٹرمینل تجربہ فراہم کرتا ہے۔

## Pi CLI سے کلیدی فرق

| Aspect          | Pi CLI                              | OpenClaw Embedded                                                                                                 |
| --------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Invocation      | `pi` کمانڈ / RPC                    | SDK بذریعہ `createAgentSession()`                                                                                 |
| Tools           | ڈیفالٹ کوڈنگ ٹولز                   | حسبِ ضرورت OpenClaw ٹول سوٹ                                                                                       |
| System prompt   | AGENTS.md + پرامپٹس | فی چینل/سیاق متحرک                                                                                                |
| Session storage | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (یا `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Auth            | واحد اسناد                          | روٹیشن کے ساتھ ملٹی پروفائل                                                                                       |
| Extensions      | ڈسک سے لوڈ کیے جاتے ہیں             | پروگراماتی + ڈسک راستے                                                                                            |
| Event handling  | TUI رینڈرنگ                         | کال بیک پر مبنی (onBlockReply وغیرہ)                                                           |

## مستقبل کے لیے غور و فکر

ممکنہ ری ورک کے شعبے:

1. **ٹول سِگنیچر الائنمنٹ**: فی الحال pi-agent-core اور pi-coding-agent کے سِگنیچرز کے درمیان موافقت
2. **سیشن مینیجر ریپنگ**: `guardSessionManager` حفاظت بڑھاتا ہے مگر پیچیدگی میں اضافہ کرتا ہے
3. **ایکسٹینشن لوڈنگ**: pi کے `ResourceLoader` کو زیادہ براہِ راست استعمال کیا جا سکتا ہے
4. **اسٹریمنگ ہینڈلر کی پیچیدگی**: `subscribeEmbeddedPiSession` خاصا بڑا ہو چکا ہے
5. **فراہم کنندہ کی خامیاں**: بہت سے provider-specific کوڈ پاتھس جنہیں pi ممکنہ طور پر خود سنبھال سکتا ہے

## ٹیسٹس

وہ تمام موجودہ ٹیسٹس جو pi انضمام اور اس کی ایکسٹینشنز کو کور کرتے ہیں:

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
