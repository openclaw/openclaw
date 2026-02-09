---
title: "بنية تكامل Pi"
---

# بنية تكامل Pi

تصف هذه الوثيقة كيفية تكامل OpenClaw مع ‎[pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)‎ وحِزَمِه الشقيقة (`pi-ai`، `pi-agent-core`، `pi-tui`) لتشغيل قدرات وكيل الذكاء الاصطناعي.

## نظرة عامة

يستخدم OpenClaw حزمة pi SDK لدمج وكيل ترميز بالذكاء الاصطناعي ضمن بنية Gateway الخاصة بالمراسلة. وبدلًا من تشغيل pi كعملية فرعية أو استخدام وضع RPC، يقوم OpenClaw باستيراد وإنشاء `AgentSession` الخاص بـ pi مباشرةً عبر `createAgentSession()`. يوفّر هذا النهج المُضمَّن ما يلي:

- تحكّمًا كاملًا في دورة حياة الجلسة ومعالجة الأحداث
- حقن أدوات مخصّصة (المراسلة، sandbox، إجراءات خاصة بالقنوات)
- تخصيص مطالبة النظام لكل قناة/سياق
- استمرارية الجلسات مع دعم التفرّع/الدمج
- تدوير ملفات مصادقة متعددة للحسابات مع التحويل التلقائي عند الفشل
- تبديل نموذج المزود

## تبعيات الحزمة

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| الحزمة            | الغرض                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | تجريدات LLM الأساسية: `Model`، `streamSimple`، أنواع الرسائل، واجهات برمجة تطبيقات الموفّرين          |
| `pi-agent-core`   | حلقة الوكيل، تنفيذ الأدوات، أنواع `AgentMessage`                                                                      |
| `pi-coding-agent` | SDK عالي المستوى: `createAgentSession`، `SessionManager`، `AuthStorage`، `ModelRegistry`، أدوات مدمجة |
| `pi-tui`          | مكوّنات واجهة المستخدم الطرفية (تُستخدم في وضع TUI المحلي لـ OpenClaw)                             |

## بنية الملفات

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

## تدفّق التكامل الأساسي

### 1. تشغيل وكيل مُضمَّن

نقطة الدخول الرئيسية هي `runEmbeddedPiAgent()` في `pi-embedded-runner/run.ts`:

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

### 2. إنشاء الجلسة

داخل `runEmbeddedAttempt()` (المستدعاة بواسطة `runEmbeddedPiAgent()`)، تُستخدم pi SDK:

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

### 3. الاشتراك في الأحداث

يقوم `subscribeEmbeddedPiSession()` بالاشتراك في أحداث `AgentSession` الخاصة بـ pi:

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

تشمل الأحداث التي تتم معالجتها:

- `message_start` / `message_end` / `message_update` (بث النص/التفكير)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. إرسال المطالبة

بعد الإعداد، تُحفَّز الجلسة:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

يتولى SDK حلقة الوكيل كاملة: الإرسال إلى LLM، وتنفيذ استدعاءات الأدوات، وبث الردود.

## بنية الأدوات

### خط أنابيب الأدوات

1. **الأدوات الأساسية**: `codingTools` الخاصة بـ pi (read، bash، edit، write)
2. **الاستبدالات المخصّصة**: يستبدل OpenClaw أداة bash بـ `exec`/`process`، ويخصّص read/edit/write للـ sandbox
3. **أدوات OpenClaw**: المراسلة، المتصفح، اللوحة، الجلسات، cron، Gateway، إلخ
4. **أدوات القنوات**: أدوات إجراءات خاصة بـ Discord/Telegram/Slack/WhatsApp
5. **ترشيح السياسات**: ترشيح الأدوات حسب الملف الشخصي، والموفّر، والوكيل، والمجموعة، وسياسات sandbox
6. **توحيد المخططات**: تنظيف المخططات لمعالجة خصوصيات Gemini/OpenAI
7. **التغليف بإشارات الإلغاء**: تغليف الأدوات لاحترام إشارات الإلغاء

### مُهايئ تعريف الأدوات

يحتوي `AgentTool` في pi-agent-core على توقيع `execute` مختلف عن `ToolDefinition` في pi-coding-agent. يقوم المُهايئ في `pi-tool-definition-adapter.ts` بجسر هذه الفجوة:

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

### استراتيجية تقسيم الأدوات

يمرّر `splitSdkTools()` جميع الأدوات عبر `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

يضمن ذلك بقاء ترشيح السياسات، وتكامل sandbox، ومجموعة الأدوات الموسّعة في OpenClaw متّسقة عبر الموفّرين.

## بناء مطالبة النظام

تُبنى مطالبة النظام في `buildAgentSystemPrompt()` (`system-prompt.ts`). حيث تُجمَّع مطالبة كاملة تتضمن أقسامًا مثل: الأدوات، أسلوب استدعاء الأدوات، ضوابط السلامة، مرجع OpenClaw CLI، Skills، الوثائق، مساحة العمل، Sandbox، المراسلة، وسوم الرد، الصوت، الردود الصامتة، نبضات الحالة، بيانات وقت التشغيل الوصفية، بالإضافة إلى الذاكرة والتفاعلات عند تمكينها، وملفات السياق الاختيارية ومحتوى إضافي لمطالبة النظام. يتم تقليص الأقسام لاستخدام وضع المطالبة الدنيا الخاص بالوكلاء الفرعيين.

تُطبَّق المطالبة بعد إنشاء الجلسة عبر `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## إدارة الجلسات

### ملفات الجلسات

الجلسات هي ملفات JSONL ذات بنية شجرية (ربط id/parentId). يتولى `SessionManager` الخاص بـ Pi الاستمرارية:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

يقوم OpenClaw بتغليف ذلك باستخدام `guardSessionManager()` لضمان سلامة نتائج الأدوات.

### التخزين المؤقّت للجلسات

يقوم `session-manager-cache.ts` بتخزين مثيلات SessionManager مؤقتًا لتجنّب إعادة تحليل الملفات:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### الحد من السجل

يقوم `limitHistoryTurns()` بتقليم سجل المحادثة بناءً على نوع القناة (محادثة خاصة مقابل مجموعة).

### الدمج (Compaction)

يتم تشغيل الدمج التلقائي عند تجاوز سعة السياق. يتولى `compactEmbeddedPiSessionDirect()` الدمج اليدوي:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## المصادقة وحلّ النموذج

### ملفات المصادقة

يحافظ OpenClaw على مخزن لملفات المصادقة مع مفاتيح API متعددة لكل موفّر:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

تدوير الملفات الشخصية عند الفشل مع تتبع التبريد:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### حلّ النموذج

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

### فشل

يُفعِّل `FailoverError` الرجوع إلى نموذج بديل عند تهيئته:

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

## امتدادات Pi

يقوم OpenClaw بتحميل امتدادات pi مخصّصة لسلوكيات متخصصة:

### ضمانات الدمج

يضيف `pi-extensions/compaction-safeguard.ts` ضوابط أمان للدمج، بما في ذلك إعداد ميزانية رموز تكيفية، إضافةً إلى ملخّصات لفشل الأدوات وعمليات الملفات:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### تقليم السياق

ينفّذ `pi-extensions/context-pruning.ts` تقليمًا للسياق قائمًا على TTL للتخزين المؤقّت:

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

## البث وردود الكتل

### تقسيم الكتل

يدير `EmbeddedBlockChunker` بث النص إلى كتل ردّ منفصلة:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### تفكير/وضع علامة نهائية

تُعالج مخرجات البث لإزالة كتل `<think>`/`<thinking>` واستخراج محتوى `<final>`:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### توجيهات الرد

تُحلَّل وتُستخرج توجيهات الرد مثل `[[media:url]]`، `[[voice]]`، `[[reply:id]]`:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## معالجة الأخطاء

### تصنيف الأخطاء

يقوم `pi-embedded-helpers.ts` بتصنيف الأخطاء لمعالجتها بالشكل المناسب:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### الرجوع في مستوى التفكير

إذا كان مستوى التفكير غير مدعوم، يتم الرجوع إلى مستوى بديل:

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

## تكامل Sandbox

عند تمكين وضع sandbox، تُقيَّد الأدوات والمسارات:

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

## التعامل مع المزود الخاص

### Anthropic

- تنظيف سلسلة الرفض السحرية
- التحقق من الأدوار المتتالية في الأدوار
- توافق معاملات Claude Code

### Google/Gemini

- إصلاح ترتيب الأدوار (`applyGoogleTurnOrderingFix`)
- تنقية مخططات الأدوات (`sanitizeToolsForGoogle`)
- تنقية سجل الجلسة (`sanitizeSessionHistory`)

### OpenAI

- أداة `apply_patch` لنماذج Codex
- معالجة خفض مستوى التفكير

## تكامل TUI

يحتوي OpenClaw أيضًا على وضع TUI محلي يستخدم مكوّنات pi-tui مباشرةً:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

يوفّر ذلك تجربة طرفية تفاعلية مشابهة لوضع pi الأصلي.

## الفروقات الرئيسية عن Pi CLI

| الجانب         | Pi CLI                              | OpenClaw المُضمَّن                                                                                                |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| الاستدعاء      | أمر `pi` / RPC                      | SDK عبر `createAgentSession()`                                                                                    |
| الأدوات        | أدوات الترميز الافتراضية            | مجموعة أدوات OpenClaw المخصّصة                                                                                    |
| مطالبة النظام  | AGENTS.md + مطالبات | ديناميكية حسب القناة/السياق                                                                                       |
| تخزين الجلسة   | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (أو `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| المصادقة       | اعتماد واحد                         | ملفات متعددة مع تدوير                                                                                             |
| الامتدادات     | محمّلة من القرص                     | برمجية + مسارات قرص                                                                                               |
| معالجة الأحداث | عرض TUI                             | قائم على الاستدعاءات الراجعة (onBlockReply، إلخ)                                               |

## اعتبارات مستقبلية

مجالات لإعادة العمل المحتملة:

1. **محاذاة تواقيع الأدوات**: التكيّف الحالي بين تواقيع pi-agent-core و pi-coding-agent
2. **تغليف مدير الجلسات**: يضيف `guardSessionManager` أمانًا لكنه يزيد التعقيد
3. **تحميل الامتدادات**: يمكن استخدام `ResourceLoader` الخاص بـ pi بشكل أكثر مباشرة
4. **تعقيد معالج البث**: أصبح `subscribeEmbeddedPiSession` كبيرًا
5. **خصوصيات الموفّرين**: مسارات كود خاصة بالموفّرين يمكن لـ pi معالجتها محتملًا

## الاختبارات

جميع الاختبارات الحالية التي تغطي تكامل pi وامتداداته:

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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (مباشر)
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
