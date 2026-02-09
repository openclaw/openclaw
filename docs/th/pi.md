---
title: "สถาปัตยกรรมการผสานรวม Pi"
---

# สถาปัตยกรรมการผสานรวม Pi

เอกสารนี้อธิบายว่า OpenClaw ผสานรวมกับ [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) และแพ็กเกจพี่น้อง (`pi-ai`, `pi-agent-core`, `pi-tui`) อย่างไร เพื่อขับเคลื่อนความสามารถของเอเจนต์ AI

## ภาพรวม

50. OpenClaw ใช้ pi SDK เพื่อฝังเอเจนต์เขียนโค้ด AI เข้าไปในสถาปัตยกรรมเกตเวย์รับส่งข้อความของตน OpenClaw ใช้ pi SDK เพื่อฝังเอเจนต์เขียนโค้ดด้วย AI เข้าไปในสถาปัตยกรรม Gateway สำหรับระบบส่งข้อความ แทนที่จะเรียก pi เป็น subprocess หรือใช้โหมด RPC นั้น OpenClaw จะนำเข้าและสร้างอินสแตนซ์ `AgentSession` ของ pi โดยตรงผ่าน `createAgentSession()` แนวทางแบบฝังนี้ให้ประโยชน์ดังนี้: แนวทางแบบฝังนี้มีให้:

- ควบคุมวงจรชีวิตของเซสชันและการจัดการอีเวนต์ได้อย่างเต็มที่
- การฉีดเครื่องมือแบบกำหนดเอง (การส่งข้อความ, sandbox, การกระทำเฉพาะช่องทาง)
- การปรับแต่ง system prompt แยกตามช่องทาง/บริบท
- การคงอยู่ของเซสชันพร้อมการรองรับการแตกแขนง/การบีบอัด
- การหมุนโปรไฟล์การยืนยันตัวตนหลายบัญชีพร้อมกลไก failover
- การสลับโมเดลโดยไม่ผูกกับผู้ให้บริการ

## การพึ่งพาแพ็กเกจ

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| แพ็กเกจ           | วัตถุประสงค์                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | abstraction หลักของ LLM: `Model`, `streamSimple`, ชนิดข้อความ, API ของผู้ให้บริการ                         |
| `pi-agent-core`   | ลูปเอเจนต์, การรันเครื่องมือ, ชนิด `AgentMessage`                                                                          |
| `pi-coding-agent` | SDK ระดับสูง: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, เครื่องมือที่มาพร้อม |
| `pi-tui`          | คอมโพเนนต์ UI บนเทอร์มินัล (ใช้ในโหมด TUI ภายในเครื่องของ OpenClaw)                                     |

## โครงสร้างไฟล์

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

## โฟลว์การผสานรวมหลัก

### 1. การรันเอเจนต์แบบฝัง

จุดเริ่มต้นหลักคือ `runEmbeddedPiAgent()` ใน `pi-embedded-runner/run.ts`:

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

### 2. การสร้างเซสชัน

ภายใน `runEmbeddedAttempt()` (ถูกเรียกโดย `runEmbeddedPiAgent()`) จะใช้ pi SDK ดังนี้:

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

### 3. การสมัครรับอีเวนต์

`subscribeEmbeddedPiSession()` สมัครรับอีเวนต์ `AgentSession` ของ pi:

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

อีเวนต์ที่จัดการประกอบด้วย:

- `message_start` / `message_end` / `message_update` (การสตรีมข้อความ/การคิด)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. การกระตุ้นพรอมต์

หลังจากตั้งค่าแล้ว จะมีการส่งพรอมต์ให้เซสชัน:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK จะจัดการลูปเอเจนต์ทั้งหมด: การส่งไปยัง LLM, การรันการเรียกเครื่องมือ, และการสตรีมการตอบกลับ

## สถาปัตยกรรมเครื่องมือ

### ไปป์ไลน์ของเครื่องมือ

1. **เครื่องมือพื้นฐาน**: `codingTools` ของ pi (read, bash, edit, write)
2. **การแทนที่แบบกำหนดเอง**: OpenClaw แทนที่ bash ด้วย `exec`/`process` และปรับแต่ง read/edit/write สำหรับ sandbox
3. **เครื่องมือของ OpenClaw**: การส่งข้อความ, เบราว์เซอร์, แคนวาส, เซสชัน, cron, gateway ฯลฯ
4. **เครื่องมือเฉพาะช่องทาง**: เครื่องมือการกระทำเฉพาะ Discord/Telegram/Slack/WhatsApp
5. **การกรองตามนโยบาย**: กรองเครื่องมือตามโปรไฟล์, ผู้ให้บริการ, เอเจนต์, กลุ่ม, นโยบาย sandbox
6. **การทำ schema ให้เป็นมาตรฐาน**: ทำความสะอาด schema สำหรับข้อจำกัดเฉพาะของ Gemini/OpenAI
7. **การห่อด้วย AbortSignal**: ห่อเครื่องมือเพื่อเคารพสัญญาณยกเลิก

### อะแดปเตอร์การกำหนดเครื่องมือ

`AgentTool` ของ pi-agent-core มี signature ของ `execute` ที่แตกต่างจาก `ToolDefinition` ของ pi-coding-agent อะแดปเตอร์ใน `pi-tool-definition-adapter.ts` ทำหน้าที่เชื่อมช่องว่างนี้: อะแดปเตอร์ใน `pi-tool-definition-adapter.ts` ทำหน้าที่เชื่อมสิ่งนี้:

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

### กลยุทธ์การแยกเครื่องมือ

`splitSdkTools()` ส่งเครื่องมือทั้งหมดผ่าน `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

สิ่งนี้ทำให้การกรองตามนโยบายของ OpenClaw การผสานรวม sandbox และชุดเครื่องมือที่ขยายเพิ่มเติมคงความสอดคล้องกันข้ามผู้ให้บริการทั้งหมด

## การสร้าง System Prompt

system prompt ถูกสร้างใน `buildAgentSystemPrompt()` (`system-prompt.ts`) โดยประกอบเป็นพรอมต์ฉบับเต็มที่มีส่วนต่างๆ ได้แก่ Tooling, Tool Call Style, Safety guardrails, เอกสารอ้างอิง OpenClaw CLI, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, เมทาดาทาขณะรัน รวมถึง Memory และ Reactions เมื่อเปิดใช้งาน และไฟล์บริบทเพิ่มเติมกับเนื้อหา system prompt เสริมตามต้องการ ส่วนต่างๆ จะถูกตัดทอนเมื่อใช้โหมดพรอมต์ขั้นต่ำสำหรับซับเอเจนต์ มันประกอบพรอมต์แบบเต็มพร้อมส่วนต่าง ๆ รวมถึง Tooling, Tool Call Style, Safety guardrails, เอกสารอ้างอิง OpenClaw CLI, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata รวมถึง Memory และ Reactions เมื่อเปิดใช้งาน และไฟล์บริบทเพิ่มเติมกับเนื้อหา system prompt เสริมที่เป็นตัวเลือก ส่วนต่าง ๆ จะถูกตัดทอนสำหรับโหมดพรอมต์ขั้นต่ำที่ใช้โดยซับเอเจนต์

พรอมต์จะถูกนำไปใช้หลังการสร้างเซสชันผ่าน `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## การจัดการเซสชัน

### ไฟล์เซสชัน

เซสชันเป็นไฟล์ JSONL ที่มีโครงสร้างแบบต้นไม้ (เชื่อมด้วย id/parentId) โดย `SessionManager` ของ pi จัดการการคงอยู่ของข้อมูล: `SessionManager` ของ Pi จัดการเรื่องการคงอยู่ของข้อมูล:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw ห่อหุ้มสิ่งนี้ด้วย `guardSessionManager()` เพื่อความปลอดภัยของผลลัพธ์จากเครื่องมือ

### การแคชเซสชัน

`session-manager-cache.ts` แคชอินสแตนซ์ SessionManager เพื่อหลีกเลี่ยงการพาร์สไฟล์ซ้ำ:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### การจำกัดประวัติ

`limitHistoryTurns()` ตัดทอนประวัติการสนทนาตามประเภทช่องทาง (DM เทียบกับกลุ่ม)

### การบีบอัด

การบีบอัดอัตโนมัติจะทำงานเมื่อบริบทล้น การบีบอัดอัตโนมัติจะเริ่มเมื่อบริบทล้น โดย `compactEmbeddedPiSessionDirect()` จัดการการบีบอัดแบบแมนนวล:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## การยืนยันตัวตนและการเลือกโมเดล

### โปรไฟล์การยืนยันตัวตน

OpenClaw ดูแลสโตร์โปรไฟล์การยืนยันตัวตนที่มีคีย์ API หลายชุดต่อผู้ให้บริการ:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

โปรไฟล์จะหมุนเมื่อเกิดความล้มเหลว พร้อมการติดตามคูลดาวน์:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### การเลือกโมเดล

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

`FailoverError` จะกระตุ้นการสลับโมเดลสำรองเมื่อมีการกำหนดค่าไว้:

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

## ส่วนขยายของ Pi

OpenClaw โหลดส่วนขยาย pi แบบกำหนดเองสำหรับพฤติกรรมเฉพาะทาง:

### การป้องกันการบีบอัด

`pi-extensions/compaction-safeguard.ts` เพิ่ม guardrails ให้การบีบอัด รวมถึงการจัดงบโทเคนแบบปรับตัวได้ พร้อมสรุปความล้มเหลวของเครื่องมือและการดำเนินการไฟล์:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### การตัดบริบท

`pi-extensions/context-pruning.ts` ใช้การตัดบริบทตาม cache-TTL:

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

## การสตรีมและการตอบกลับแบบบล็อก

### การแบ่งบล็อก

`EmbeddedBlockChunker` จัดการการสตรีมข้อความให้เป็นบล็อกการตอบกลับแบบแยกส่วน:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### การตัดแท็ก Thinking/Final

เอาต์พุตที่สตรีมจะถูกประมวลผลเพื่อตัดบล็อก `<think>`/`<thinking>` และดึงเนื้อหา `<final>` ออกมา:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### คำสั่งการตอบกลับ

คำสั่งการตอบกลับ เช่น `[[media:url]]`, `[[voice]]`, `[[reply:id]]` จะถูกพาร์สและแยกออกมา:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## การจัดการข้อผิดพลาด

### การจัดประเภทข้อผิดพลาด

`pi-embedded-helpers.ts` จัดประเภทข้อผิดพลาดเพื่อการจัดการที่เหมาะสม:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### การ fallback ระดับการคิด

หากไม่รองรับระดับการคิด จะมีการ fallback:

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

## การผสานรวม Sandbox

เมื่อเปิดใช้งานโหมด sandbox เครื่องมือและพาธจะถูกจำกัด:

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

## การจัดการเฉพาะผู้ให้บริการ

### Anthropic

- การล้าง magic string สำหรับการปฏิเสธ
- การตรวจสอบลำดับเทิร์นสำหรับบทบาทที่ต่อเนื่อง
- ความเข้ากันได้ของพารามิเตอร์ Claude Code

### Google/Gemini

- การแก้ไขลำดับเทิร์น (`applyGoogleTurnOrderingFix`)
- การทำความสะอาด schema ของเครื่องมือ (`sanitizeToolsForGoogle`)
- การทำความสะอาดประวัติเซสชัน (`sanitizeSessionHistory`)

### OpenAI

- เครื่องมือ `apply_patch` สำหรับโมเดล Codex
- การจัดการการลดระดับ thinking

## การผสานรวม TUI

OpenClaw ยังมีโหมด TUI ภายในเครื่องที่ใช้คอมโพเนนต์ pi-tui โดยตรง:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

สิ่งนี้มอบประสบการณ์เทอร์มินัลแบบโต้ตอบที่คล้ายกับโหมดเนทีฟของ pi

## ความแตกต่างหลักจาก Pi CLI

| Aspect           | Pi CLI                             | OpenClaw แบบฝัง                                                                                                     |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| การเรียกใช้งาน   | คำสั่ง `pi` / RPC                  | SDK ผ่าน `createAgentSession()`                                                                                     |
| เครื่องมือ       | เครื่องมือเขียนโค้ดเริ่มต้น        | ชุดเครื่องมือ OpenClaw แบบกำหนดเอง                                                                                  |
| System prompt    | AGENTS.md + พรอมต์ | แบบไดนามิกตามช่องทาง/บริบท                                                                                          |
| การจัดเก็บเซสชัน | `~/.pi/agent/sessions/`            | `~/.openclaw/agents/<agentId>/sessions/` (หรือ `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| การยืนยันตัวตน   | ข้อมูลรับรองเดียว                  | หลายโปรไฟล์พร้อมการหมุน                                                                                             |
| ส่วนขยาย         | โหลดจากดิสก์                       | แบบโปรแกรม + พาธบนดิสก์                                                                                             |
| การจัดการอีเวนต์ | การเรนเดอร์ TUI                    | แบบ callback (onBlockReply เป็นต้น)                                                              |

## ประเด็นที่ควรพิจารณาในอนาคต

พื้นที่ที่อาจต้องปรับปรุง:

1. **การจัดแนว signature ของเครื่องมือ**: ปัจจุบันมีการปรับระหว่าง signature ของ pi-agent-core และ pi-coding-agent
2. **การห่อ Session manager**: `guardSessionManager` เพิ่มความปลอดภัยแต่เพิ่มความซับซ้อน
3. **การโหลดส่วนขยาย**: อาจใช้ `ResourceLoader` ของ pi โดยตรงมากขึ้น
4. **ความซับซ้อนของตัวจัดการสตรีม**: `subscribeEmbeddedPiSession` มีขนาดใหญ่ขึ้นมาก
5. **ความเฉพาะของผู้ให้บริการ**: มีโค้ดเฉพาะผู้ให้บริการจำนวนมากที่ pi อาจจัดการได้เอง

## การทดสอบ

การทดสอบทั้งหมดที่มีอยู่ซึ่งครอบคลุมการผสานรวม pi และส่วนขยายของมัน:

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
