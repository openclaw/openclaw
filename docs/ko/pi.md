---
title: "Pi 통합 아키텍처"
---

# Pi 통합 아키텍처

이 문서는 OpenClaw 가 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 및 그 형제 패키지(`pi-ai`, `pi-agent-core`, `pi-tui`)와 통합되어 AI 에이전트 기능을 구동하는 방식을 설명합니다.

## 개요

OpenClaw 는 pi SDK 를 사용하여 메시징 Gateway(게이트웨이) 아키텍처에 AI 코딩 에이전트를 내장합니다. pi 를 서브프로세스로 생성하거나 RPC 모드를 사용하는 대신, OpenClaw 는 `createAgentSession()` 를 통해 pi 의 `AgentSession` 를 직접 임포트하고 인스턴스화합니다. 이 임베디드 방식은 다음을 제공합니다.

- 세션 라이프사이클 및 이벤트 처리에 대한 완전한 제어
- 커스텀 도구 주입(메시징, 샌드박스, 채널별 액션)
- 채널/컨텍스트별 시스템 프롬프트 커스터마이징
- 분기/압축을 지원하는 세션 영속성
- 장애 조치를 포함한 다중 계정 인증 프로파일 로테이션
- 프로바이더에 독립적인 모델 전환

## 패키지 의존성

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| 패키지               | 목적                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `pi-ai`           | 핵심 LLM 추상화: `Model`, `streamSimple`, 메시지 타입, 프로바이더 API                                 |
| `pi-agent-core`   | 에이전트 루프, 도구 실행, `AgentMessage` 타입                                                                      |
| `pi-coding-agent` | 고수준 SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, 내장 도구 |
| `pi-tui`          | 터미널 UI 컴포넌트(OpenClaw 의 로컬 TUI 모드에서 사용)                                              |

## 파일 구조

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

## 핵심 통합 흐름

### 1. 임베디드 에이전트 실행

메인 엔트리 포인트는 `pi-embedded-runner/run.ts` 의 `runEmbeddedPiAgent()` 입니다.

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

### 2. 세션 생성

`runEmbeddedPiAgent()` 에 의해 호출되는 `runEmbeddedAttempt()` 내부에서 pi SDK 가 사용됩니다.

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

### 3. 이벤트 구독

`subscribeEmbeddedPiSession()` 는 pi 의 `AgentSession` 이벤트를 구독합니다.

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

처리되는 이벤트에는 다음이 포함됩니다.

- `message_start` / `message_end` / `message_update` (스트리밍 텍스트/사고)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. 프롬프팅

설정이 완료되면 세션이 프롬프트됩니다.

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK 는 LLM 전송, 도구 호출 실행, 응답 스트리밍을 포함한 전체 에이전트 루프를 처리합니다.

## 도구 아키텍처

### 도구 파이프라인

1. **기본 도구**: pi 의 `codingTools` (read, bash, edit, write)
2. **커스텀 대체**: OpenClaw 는 bash 를 `exec`/`process` 로 교체하고, 샌드박스를 위해 read/edit/write 를 커스터마이징합니다.
3. **OpenClaw 도구**: 메시징, 브라우저, 캔버스, 세션, cron, Gateway(게이트웨이) 등
4. **채널 도구**: Discord/Telegram/Slack/WhatsApp 전용 액션 도구
5. **정책 필터링**: 프로파일, 프로바이더, 에이전트, 그룹, 샌드박스 정책에 따라 도구 필터링
6. **스키마 정규화**: Gemini/OpenAI 특이사항을 위한 스키마 정리
7. **AbortSignal 래핑**: 중단 신호를 존중하도록 도구 래핑

### 도구 정의 어댑터

pi-agent-core 의 `AgentTool` 는 pi-coding-agent 의 `ToolDefinition` 와 다른 `execute` 시그니처를 가집니다. `pi-tool-definition-adapter.ts` 의 어댑터가 이를 연결합니다.

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

### 도구 분할 전략

`splitSdkTools()` 는 `customTools` 를 통해 모든 도구를 전달합니다.

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

이를 통해 OpenClaw 의 정책 필터링, 샌드박스 통합, 확장된 도구 세트가 프로바이더 전반에 걸쳐 일관되게 유지됩니다.

## 시스템 프롬프트 구성

시스템 프롬프트는 `buildAgentSystemPrompt()` (`system-prompt.ts`) 에서 빌드됩니다. Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI 참조, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime 메타데이터 섹션을 포함한 전체 프롬프트를 조합합니다. 서브에이전트에서 사용하는 최소 프롬프트 모드를 위해 섹션은 트리밍됩니다.

프롬프트는 세션 생성 후 `applySystemPromptOverrideToSession()` 를 통해 적용됩니다.

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## 세션 관리

### 세션 파일

세션은 트리 구조(id/parentId 연결)의 JSONL 파일입니다. pi 의 `SessionManager` 가 영속성을 처리합니다.

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw 는 도구 결과 안전성을 위해 이를 `guardSessionManager()` 로 래핑합니다.

### 세션 캐싱

`session-manager-cache.ts` 는 반복적인 파일 파싱을 피하기 위해 SessionManager 인스턴스를 캐시합니다.

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### 히스토리 제한

`limitHistoryTurns()` 는 채널 유형(DM vs 그룹)에 따라 대화 히스토리를 트리밍합니다.

### 컴팩션

컨텍스트 오버플로우 시 자동 압축이 트리거됩니다. `compactEmbeddedPiSessionDirect()` 는 수동 압축을 처리합니다.

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## 인증 및 모델 해석

### 인증 프로파일

OpenClaw 는 프로바이더별로 여러 API 키를 포함하는 인증 프로파일 스토어를 유지합니다.

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

프로파일은 실패 시 쿨다운 추적과 함께 로테이션됩니다.

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### 모델 해석

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

### 16. 장애 조치

구성된 경우 `FailoverError` 가 모델 폴백을 트리거합니다.

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

## Pi 확장

OpenClaw 는 특수 동작을 위해 커스텀 pi 확장을 로드합니다.

### 17. 컴팩션 보호 장치

`pi-extensions/compaction-safeguard.ts` 는 적응형 토큰 예산 책정과 도구 실패 및 파일 작업 요약을 포함한 압축 가드레일을 추가합니다.

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### 컨텍스트 가지치기

`pi-extensions/context-pruning.ts` 는 캐시 TTL 기반 컨텍스트 가지치기를 구현합니다.

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

## 스트리밍 및 블록 응답

### 블록 청킹

`EmbeddedBlockChunker` 는 스트리밍 텍스트를 개별 응답 블록으로 관리합니다.

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### 18. 사고/최종 태그 제거

스트리밍 출력은 `<think>`/`<thinking>` 블록을 제거하고 `<final>` 콘텐츠를 추출하도록 처리됩니다.

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### 응답 지시문

`[[media:url]]`, `[[voice]]`, `[[reply:id]]` 와 같은 응답 지시문이 파싱 및 추출됩니다.

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## 오류 처리

### 오류 분류

`pi-embedded-helpers.ts` 는 적절한 처리를 위해 오류를 분류합니다.

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### 사고 레벨 폴백

사고 레벨이 지원되지 않는 경우 폴백됩니다.

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

## 샌드박스 통합

샌드박스 모드가 활성화되면 도구와 경로가 제한됩니다.

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

## 19. 제공자별 처리

### Anthropic

- 거절 매직 문자열 정리
- 연속 역할에 대한 턴 검증
- Claude Code 파라미터 호환성

### Google/Gemini

- 턴 순서 수정(`applyGoogleTurnOrderingFix`)
- 도구 스키마 정제(`sanitizeToolsForGoogle`)
- 세션 히스토리 정제(`sanitizeSessionHistory`)

### OpenAI

- Codex 모델을 위한 `apply_patch` 도구
- 사고 레벨 다운그레이드 처리

## TUI 통합

OpenClaw 는 pi-tui 컴포넌트를 직접 사용하는 로컬 TUI 모드도 제공합니다.

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

이는 pi 의 네이티브 모드와 유사한 대화형 터미널 경험을 제공합니다.

## Pi CLI 와의 주요 차이점

| 20. 측면 | Pi CLI                           | OpenClaw 임베디드                                                                                                     |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 호출                            | `pi` 명령 / RPC                    | `createAgentSession()` 를 통한 SDK                                                                                   |
| 도구                            | 기본 코딩 도구                         | 커스텀 OpenClaw 도구 세트                                                                                                |
| 시스템 프롬프트                      | AGENTS.md + 프롬프트 | 채널/컨텍스트별 동적 구성                                                                                                    |
| 세션 저장소                        | `~/.pi/agent/sessions/`          | `~/.openclaw/agents/<agentId>/sessions/` (또는 `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| 인증                            | 단일 자격 증명                         | 로테이션을 포함한 다중 프로파일                                                                                                 |
| 확장                            | 디스크에서 로드                         | 프로그래밍 방식 + 디스크 경로                                                                                                 |
| 이벤트 처리                        | TUI 렌더링                          | 콜백 기반(onBlockReply 등)                                                                          |

## 향후 고려 사항

잠재적 재작업 영역:

1. **도구 시그니처 정렬**: 현재 pi-agent-core 와 pi-coding-agent 시그니처 간 어댑팅
2. **세션 매니저 래핑**: `guardSessionManager` 는 안전성을 추가하지만 복잡성을 증가시킴
3. **확장 로딩**: pi 의 `ResourceLoader` 를 보다 직접적으로 사용할 수 있음
4. **스트리밍 핸들러 복잡성**: `subscribeEmbeddedPiSession` 가 크게 확장됨
5. **프로바이더 특이사항**: pi 가 잠재적으로 처리할 수 있는 많은 프로바이더별 코드 경로

## 테스트

pi 통합 및 그 확장을 다루는 모든 기존 테스트:

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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (라이브)
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
