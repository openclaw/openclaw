---
title: "Pi एकीकरण वास्तुकला"
---

# Pi एकीकरण वास्तुकला

यह दस्तावेज़ वर्णन करता है कि OpenClaw किस प्रकार [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) और इसके सहोदर पैकेजों (`pi-ai`, `pi-agent-core`, `pi-tui`) के साथ एकीकृत होकर अपनी एआई एजेंट क्षमताओं को सक्षम करता है।

## अवलोकन

OpenClaw uses the pi SDK to embed an AI coding agent into its messaging gateway architecture. Instead of spawning pi as a subprocess or using RPC mode, OpenClaw directly imports and instantiates pi's `AgentSession` via `createAgentSession()`. This embedded approach provides:

- सत्र जीवनचक्र और इवेंट हैंडलिंग पर पूर्ण नियंत्रण
- कस्टम टूल इंजेक्शन (मैसेजिंग, sandbox, चैनल-विशिष्ट क्रियाएँ)
- प्रति चैनल/संदर्भ सिस्टम प्रॉम्प्ट अनुकूलन
- ब्रांचिंग/कम्पैक्शन समर्थन के साथ सत्र स्थायित्व
- फेलओवर के साथ मल्टी-अकाउंट प्रमाणीकरण प्रोफ़ाइल रोटेशन
- प्रदाता-अज्ञेय मॉडल स्विचिंग

## पैकेज निर्भरताएँ

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| पैकेज             | उद्देश्य                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | कोर LLM अमूर्तन: `Model`, `streamSimple`, संदेश प्रकार, प्रदाता API                                     |
| `pi-agent-core`   | एजेंट लूप, टूल निष्पादन, `AgentMessage` प्रकार                                                                          |
| `pi-coding-agent` | उच्च-स्तरीय SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, बिल्ट-इन टूल्स |
| `pi-tui`          | टर्मिनल UI घटक (OpenClaw के लोकल TUI मोड में उपयोग किए जाते हैं)                                     |

## फ़ाइल संरचना

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

## कोर एकीकरण प्रवाह

### 1. Running an Embedded Agent

मुख्य एंट्री पॉइंट `pi-embedded-runner/run.ts` में `runEmbeddedPiAgent()` है:

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

`runEmbeddedAttempt()` के भीतर (जिसे `runEmbeddedPiAgent()` कॉल करता है), pi SDK का उपयोग किया जाता है:

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

`subscribeEmbeddedPiSession()`, pi के `AgentSession` इवेंट्स की सदस्यता लेता है:

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

हैंडल किए जाने वाले इवेंट्स में शामिल हैं:

- `message_start` / `message_end` / `message_update` (स्ट्रीमिंग टेक्स्ट/थिंकिंग)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Prompting

सेटअप के बाद, सत्र को प्रॉम्प्ट किया जाता है:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK पूर्ण एजेंट लूप को संभालता है: LLM को भेजना, टूल कॉल निष्पादित करना, प्रतिक्रियाओं को स्ट्रीम करना।

## टूल वास्तुकला

### टूल पाइपलाइन

1. **बेस टूल्स**: pi के `codingTools` (read, bash, edit, write)
2. **कस्टम प्रतिस्थापन**: OpenClaw, bash को `exec`/`process` से बदलता है, और sandbox के लिए read/edit/write को अनुकूलित करता है
3. **OpenClaw टूल्स**: मैसेजिंग, ब्राउज़र, कैनवास, सत्र, cron, gateway, आदि
4. **चैनल टूल्स**: Discord/Telegram/Slack/WhatsApp-विशिष्ट एक्शन टूल्स
5. **नीति फ़िल्टरिंग**: प्रोफ़ाइल, प्रदाता, एजेंट, समूह, sandbox नीतियों के अनुसार टूल्स फ़िल्टर किए जाते हैं
6. **स्कीमा नॉर्मलाइज़ेशन**: Gemini/OpenAI की विशेषताओं के लिए स्कीमा साफ़ किए जाते हैं
7. **AbortSignal रैपिंग**: टूल्स को abort संकेतों का सम्मान करने हेतु रैप किया जाता है

### टूल परिभाषा एडेप्टर

pi-agent-core's `AgentTool` has a different `execute` signature than pi-coding-agent's `ToolDefinition`. The adapter in `pi-tool-definition-adapter.ts` bridges this:

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

### टूल विभाजन रणनीति

`splitSdkTools()`, सभी टूल्स को `customTools` के माध्यम से पास करता है:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

यह सुनिश्चित करता है कि OpenClaw की नीति फ़िल्टरिंग, sandbox एकीकरण, और विस्तारित टूलसेट प्रदाताओं के बीच सुसंगत रहें।

## सिस्टम प्रॉम्प्ट निर्माण

The system prompt is built in `buildAgentSystemPrompt()` (`system-prompt.ts`). It assembles a full prompt with sections including Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI reference, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata, plus Memory and Reactions when enabled, and optional context files and extra system prompt content. Sections are trimmed for minimal prompt mode used by subagents.

सत्र निर्माण के बाद प्रॉम्प्ट को `applySystemPromptOverrideToSession()` के माध्यम से लागू किया जाता है:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## सत्र प्रबंधन

### सत्र फ़ाइलें

Sessions are JSONL files with tree structure (id/parentId linking). Pi's `SessionManager` handles persistence:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw, टूल परिणाम सुरक्षा के लिए इसे `guardSessionManager()` से रैप करता है।

### सत्र कैशिंग

`session-manager-cache.ts`, बार-बार फ़ाइल पार्सिंग से बचने के लिए SessionManager इंस्टेंस को कैश करता है:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### इतिहास सीमित करना

`limitHistoryTurns()`, चैनल प्रकार (DM बनाम समूह) के आधार पर वार्तालाप इतिहास को ट्रिम करता है।

### कम्पैक्शन

Auto-compaction triggers on context overflow. `compactEmbeddedPiSessionDirect()` handles manual compaction:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## प्रमाणीकरण और मॉडल रेज़ोल्यूशन

### प्रमाणीकरण प्रोफ़ाइल्स

OpenClaw, प्रति प्रदाता कई एपीआई कुंजियों के साथ एक प्रमाणीकरण प्रोफ़ाइल स्टोर बनाए रखता है:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

कूलडाउन ट्रैकिंग के साथ विफलताओं पर प्रोफ़ाइल्स रोटेट होती हैं:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### मॉडल रेज़ोल्यूशन

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

### फेलओवर

कॉन्फ़िगर होने पर `FailoverError`, मॉडल फॉलबैक ट्रिगर करता है:

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

## Pi एक्सटेंशन्स

विशेषीकृत व्यवहार के लिए OpenClaw कस्टम pi एक्सटेंशन्स लोड करता है:

### कम्पैक्शन सेफ़गार्ड

`pi-extensions/compaction-safeguard.ts`, कम्पैक्शन में गार्डरेल्स जोड़ता है, जिनमें अनुकूली टोकन बजटिंग के साथ टूल विफलता और फ़ाइल ऑपरेशन सारांश शामिल हैं:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### संदर्भ प्रूनिंग

`pi-extensions/context-pruning.ts`, cache-TTL आधारित संदर्भ प्रूनिंग लागू करता है:

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

## स्ट्रीमिंग और ब्लॉक उत्तर

### ब्लॉक चंकिंग

`EmbeddedBlockChunker`, स्ट्रीमिंग टेक्स्ट को पृथक उत्तर ब्लॉक्स में प्रबंधित करता है:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### थिंकिंग/फ़ाइनल टैग स्ट्रिपिंग

स्ट्रीमिंग आउटपुट को `<think>`/`<thinking>` ब्लॉक्स हटाने और `<final>` सामग्री निकालने के लिए प्रोसेस किया जाता है:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### उत्तर निर्देश

`[[media:url]]`, `[[voice]]`, `[[reply:id]]` जैसे उत्तर निर्देशों को पार्स और एक्सट्रैक्ट किया जाता है:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## त्रुटि प्रबंधन

### त्रुटि वर्गीकरण

उचित हैंडलिंग के लिए `pi-embedded-helpers.ts` त्रुटियों का वर्गीकरण करता है:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### थिंकिंग स्तर फॉलबैक

यदि कोई थिंकिंग स्तर समर्थित नहीं है, तो यह फॉलबैक करता है:

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

## Sandbox एकीकरण

जब sandbox मोड सक्षम होता है, तब टूल्स और पथ सीमित कर दिए जाते हैं:

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

## प्रदाता-विशिष्ट हैंडलिंग

### Anthropic

- रिफ़्यूज़ल मैजिक स्ट्रिंग स्क्रबिंग
- लगातार भूमिकाओं के लिए टर्न वैलिडेशन
- Claude Code पैरामीटर संगतता

### Google/Gemini

- टर्न ऑर्डरिंग फ़िक्सेस (`applyGoogleTurnOrderingFix`)
- टूल स्कीमा सैनिटाइज़ेशन (`sanitizeToolsForGoogle`)
- सत्र इतिहास सैनिटाइज़ेशन (`sanitizeSessionHistory`)

### OpenAI

- Codex मॉडलों के लिए `apply_patch` टूल
- थिंकिंग स्तर डाउनग्रेड हैंडलिंग

## TUI एकीकरण

OpenClaw में एक लोकल TUI मोड भी है जो सीधे pi-tui घटकों का उपयोग करता है:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

यह pi के नेटिव मोड के समान इंटरैक्टिव टर्मिनल अनुभव प्रदान करता है।

## Pi CLI से मुख्य अंतर

| पहलू             | Pi CLI                                  | OpenClaw एम्बेडेड                                                                                                 |
| ---------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| आह्वान           | `pi` कमांड / RPC                        | `createAgentSession()` के माध्यम से SDK                                                                           |
| टूल्स            | डिफ़ॉल्ट कोडिंग टूल्स                   | कस्टम OpenClaw टूल सूट                                                                                            |
| सिस्टम प्रॉम्प्ट | AGENTS.md + प्रॉम्प्ट्स | प्रति चैनल/संदर्भ डायनेमिक                                                                                        |
| सत्र भंडारण      | `~/.pi/agent/sessions/`                 | `~/.openclaw/agents/<agentId>/sessions/` (या `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| प्रमाणीकरण       | एकल क्रेडेंशियल                         | रोटेशन के साथ मल्टी-प्रोफ़ाइल                                                                                     |
| एक्सटेंशन्स      | डिस्क से लोड किए गए                     | प्रोग्रामेटिक + डिस्क पाथ्स                                                                                       |
| इवेंट हैंडलिंग   | TUI रेंडरिंग                            | कॉलबैक-आधारित (onBlockReply, आदि)                                                              |

## भविष्य के विचार

संभावित पुनर्कार्य के क्षेत्र:

1. **टूल सिग्नेचर संरेखण**: वर्तमान में pi-agent-core और pi-coding-agent सिग्नेचर्स के बीच अनुकूलन
2. **सत्र प्रबंधक रैपिंग**: `guardSessionManager` सुरक्षा जोड़ता है लेकिन जटिलता बढ़ाता है
3. **एक्सटेंशन लोडिंग**: pi के `ResourceLoader` का अधिक सीधे उपयोग किया जा सकता है
4. **स्ट्रीमिंग हैंडलर जटिलता**: `subscribeEmbeddedPiSession` बड़ा हो गया है
5. **प्रदाता विशेषताएँ**: कई प्रदाता-विशिष्ट कोडपाथ जिन्हें pi संभावित रूप से संभाल सकता है

## परीक्षण

pi एकीकरण और इसके एक्सटेंशन्स को कवर करने वाले सभी मौजूदा परीक्षण:

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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (लाइव)
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
