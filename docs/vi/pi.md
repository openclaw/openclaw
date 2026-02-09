---
title: "Kiến trúc tích hợp Pi"
---

# Kiến trúc tích hợp Pi

Tài liệu này mô tả cách OpenClaw tích hợp với [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) và các gói liên quan (`pi-ai`, `pi-agent-core`, `pi-tui`) để cung cấp năng lực tác tử AI.

## Tổng quan

11. OpenClaw sử dụng SDK pi để nhúng một agent lập trình AI vào kiến trúc gateway nhắn tin của nó. 12. Thay vì khởi chạy pi như một tiến trình con hoặc dùng chế độ RPC, OpenClaw trực tiếp import và khởi tạo `AgentSession` của pi thông qua `createAgentSession()`. 13. Cách tiếp cận nhúng này cung cấp:

- Toàn quyền kiểm soát vòng đời phiên và xử lý sự kiện
- Tiêm công cụ tùy chỉnh (nhắn tin, sandbox, hành động theo kênh)
- Tùy biến system prompt theo từng kênh/ngữ cảnh
- Lưu trạng thái phiên với hỗ trợ phân nhánh/nén gọn
- Xoay vòng hồ sơ xác thực đa tài khoản với cơ chế dự phòng
- Chuyển đổi mô hình độc lập với nhà cung cấp

## Phụ thuộc gói

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Package           | Mục đích                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Trừu tượng LLM cốt lõi: `Model`, `streamSimple`, các kiểu message, API nhà cung cấp                   |
| `pi-agent-core`   | Vòng lặp tác tử, thực thi công cụ, các kiểu `AgentMessage`                                                            |
| `pi-coding-agent` | SDK mức cao: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, công cụ dựng sẵn |
| `pi-tui`          | Các thành phần UI terminal (dùng trong chế độ TUI local của OpenClaw)                              |

## Cấu trúc thư mục

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

## Luồng tích hợp cốt lõi

### 14. 1. 15. Chạy một Embedded Agent

Điểm vào chính là `runEmbeddedPiAgent()` trong `pi-embedded-runner/run.ts`:

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

### 16. 2. 17. Tạo Session

Bên trong `runEmbeddedAttempt()` (được gọi bởi `runEmbeddedPiAgent()`), SDK của pi được sử dụng:

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

### 18. 3. 19. Đăng ký Sự kiện

`subscribeEmbeddedPiSession()` đăng ký các sự kiện `AgentSession` của pi:

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

Các sự kiện được xử lý bao gồm:

- `message_start` / `message_end` / `message_update` (stream văn bản/suy nghĩ)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 20. 4. 21. Prompting

Sau khi thiết lập, phiên được gửi prompt:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK xử lý toàn bộ vòng lặp tác tử: gửi tới LLM, thực thi gọi công cụ, stream phản hồi.

## Kiến trúc công cụ

### Pipeline công cụ

1. **Công cụ cơ bản**: `codingTools` của pi (read, bash, edit, write)
2. **Thay thế tùy chỉnh**: OpenClaw thay thế bash bằng `exec`/`process`, tùy biến read/edit/write cho sandbox
3. **Công cụ OpenClaw**: nhắn tin, trình duyệt, canvas, phiên, cron, gateway, v.v.
4. **Công cụ theo kênh**: công cụ hành động riêng cho Discord/Telegram/Slack/WhatsApp
5. **Lọc theo chính sách**: công cụ được lọc theo hồ sơ, nhà cung cấp, tác tử, nhóm, chính sách sandbox
6. **Chuẩn hóa schema**: làm sạch schema cho các đặc thù của Gemini/OpenAI
7. **Bao bọc AbortSignal**: công cụ được bao để tôn trọng tín hiệu hủy

### Adapter định nghĩa công cụ

22. `AgentTool` của pi-agent-core có chữ ký `execute` khác với `ToolDefinition` của pi-coding-agent. 23. Adapter trong `pi-tool-definition-adapter.ts` thực hiện việc kết nối này:

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

### Chiến lược tách công cụ

`splitSdkTools()` truyền tất cả công cụ thông qua `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Điều này đảm bảo việc lọc chính sách, tích hợp sandbox và bộ công cụ mở rộng của OpenClaw luôn nhất quán trên các nhà cung cấp.

## Xây dựng system prompt

24. System prompt được xây dựng trong `buildAgentSystemPrompt()` (`system-prompt.ts`). 25. Nó lắp ráp một prompt đầy đủ với các phần bao gồm Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI reference, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata, cùng với Memory và Reactions khi được bật, và các file ngữ cảnh tùy chọn cùng nội dung system prompt bổ sung. 26. Các phần được cắt gọn cho chế độ prompt tối giản dùng bởi subagent.

Prompt được áp dụng sau khi tạo phiên thông qua `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Quản lý phiên

### Tệp phiên

27. Session là các file JSONL với cấu trúc cây (liên kết id/parentId). 28. `SessionManager` của Pi xử lý việc lưu trữ:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw bọc thêm `guardSessionManager()` để đảm bảo an toàn cho kết quả công cụ.

### Cache phiên

`session-manager-cache.ts` cache các instance SessionManager để tránh phải parse tệp lặp lại:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Giới hạn lịch sử

`limitHistoryTurns()` cắt bớt lịch sử hội thoại dựa trên loại kênh (DM so với nhóm).

### Nén gọn

29. Tự động compact khi tràn ngữ cảnh. 30. `compactEmbeddedPiSessionDirect()` xử lý việc compact thủ công:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Xác thực & phân giải mô hình

### Hồ sơ xác thực

OpenClaw duy trì kho hồ sơ xác thực với nhiều khóa API cho mỗi nhà cung cấp:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Các hồ sơ được xoay vòng khi gặp lỗi, kèm theo theo dõi thời gian chờ:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Phân giải mô hình

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

### Dự phòng

`FailoverError` kích hoạt chuyển mô hình dự phòng khi được cấu hình:

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

## Mở rộng Pi

OpenClaw tải các extension pi tùy chỉnh cho hành vi chuyên biệt:

### Bảo vệ nén gọn

`pi-extensions/compaction-safeguard.ts` thêm các guardrail cho nén gọn, bao gồm phân bổ token thích ứng cùng với tóm tắt lỗi công cụ và thao tác tệp:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Cắt tỉa ngữ cảnh

`pi-extensions/context-pruning.ts` triển khai cắt tỉa ngữ cảnh dựa trên cache-TTL:

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

## Streaming & phản hồi theo khối

### Chia khối phản hồi

`EmbeddedBlockChunker` quản lý việc stream văn bản thành các khối phản hồi rời rạc:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Loại bỏ thẻ Thinking/Final

Đầu ra streaming được xử lý để loại bỏ các khối `<think>`/`<thinking>` và trích xuất nội dung `<final>`:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Chỉ thị phản hồi

Các chỉ thị phản hồi như `[[media:url]]`, `[[voice]]`, `[[reply:id]]` được phân tích và trích xuất:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Xử lý lỗi

### Phân loại lỗi

`pi-embedded-helpers.ts` phân loại lỗi để xử lý phù hợp:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Dự phòng mức độ suy nghĩ

Nếu một mức độ suy nghĩ không được hỗ trợ, hệ thống sẽ fallback:

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

## Tích hợp sandbox

Khi bật chế độ sandbox, các công cụ và đường dẫn bị giới hạn:

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

## Xử lý theo nhà cung cấp

### Anthropic

- Loại bỏ magic string từ chối
- Xác thực lượt cho các vai trò liên tiếp
- Tương thích tham số Claude Code

### Google/Gemini

- Sửa thứ tự lượt (`applyGoogleTurnOrderingFix`)
- Làm sạch schema công cụ (`sanitizeToolsForGoogle`)
- Làm sạch lịch sử phiên (`sanitizeSessionHistory`)

### OpenAI

- Công cụ `apply_patch` cho các mô hình Codex
- Xử lý hạ cấp mức độ suy nghĩ

## Tích hợp TUI

OpenClaw cũng có chế độ TUI local sử dụng trực tiếp các thành phần pi-tui:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Điều này cung cấp trải nghiệm terminal tương tác tương tự chế độ gốc của pi.

## Khác biệt chính so với Pi CLI

| Khía cạnh     | Pi CLI                              | OpenClaw nhúng                                                                                                      |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Cách gọi      | Lệnh `pi` / RPC                     | SDK thông qua `createAgentSession()`                                                                                |
| Công cụ       | Công cụ viết mã mặc định            | Bộ công cụ OpenClaw tùy chỉnh                                                                                       |
| System prompt | AGENTS.md + prompts | Động theo từng kênh/ngữ cảnh                                                                                        |
| Lưu phiên     | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (hoặc `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Xác thực      | Một thông tin xác thực              | Đa hồ sơ với xoay vòng                                                                                              |
| Extension     | Tải từ đĩa                          | Lập trình + đường dẫn đĩa                                                                                           |
| Xử lý sự kiện | Kết xuất TUI                        | Dựa trên callback (onBlockReply, v.v.)                           |

## Cân nhắc tương lai

Các khu vực có thể cần làm lại:

1. **Căn chỉnh chữ ký công cụ**: Hiện đang phải thích ứng giữa chữ ký pi-agent-core và pi-coding-agent
2. **Bọc session manager**: `guardSessionManager` tăng độ an toàn nhưng làm tăng độ phức tạp
3. **Tải extension**: Có thể sử dụng trực tiếp `ResourceLoader` của pi hơn
4. **Độ phức tạp xử lý streaming**: `subscribeEmbeddedPiSession` đã phát triển khá lớn
5. **Đặc thù nhà cung cấp**: Nhiều nhánh code riêng cho từng nhà cung cấp mà pi có thể xử lý

## Kiểm thử

Tất cả các bài kiểm thử hiện có bao phủ tích hợp pi và các extension của nó:

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
