---
title: "Pi Integration Architecture"
x-i18n:
  source_hash: 98b12f1211f70b1a25f58e68c7a4d0fe3827412ca53ba0ea2cd41ac9c0448458
---

# Pi 통합 아키텍처

이 문서에서는 OpenClaw가 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 및 형제 패키지(`pi-ai`, `pi-agent-core`, `pi-tui`)와 통합하여 AI 에이전트 기능을 강화하는 방법을 설명합니다.

## 개요

OpenClaw는 pi SDK를 사용하여 메시징 게이트웨이 아키텍처에 AI 코딩 에이전트를 내장합니다. pi를 하위 프로세스로 생성하거나 RPC 모드를 사용하는 대신 OpenClaw는 `createAgentSession()`를 통해 pi의 `AgentSession`를 직접 가져오고 인스턴스화합니다. 이 내장형 접근 방식은 다음을 제공합니다.

- 세션 수명주기 및 이벤트 처리에 대한 전체 제어
- 맞춤형 도구 주입(메시징, 샌드박스, 채널별 작업)
- 채널/컨텍스트별 시스템 프롬프트 사용자 정의
- 분기/압축 지원을 통한 세션 지속성
- 장애 조치를 통한 다중 계정 인증 프로필 교체
- 공급자에 구애받지 않는 모델 전환

## 패키지 종속성

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| 패키지            | 목적                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `pi-ai`           | 핵심 LLM 추상화: `Model`, `streamSimple`, 메시지 유형, 공급자 API                           |
| `pi-agent-core`   | 에이전트 루프, 도구 실행, `AgentMessage` 유형                                               |
| `pi-coding-agent` | 고급 SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, 내장 도구 |
| `pi-tui`          | 터미널 UI 구성요소(OpenClaw의 로컬 TUI 모드에서 사용됨)                                     |

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

### 1. 내장 에이전트 실행

주요 진입점은 `pi-embedded-runner/run.ts`의 `runEmbeddedPiAgent()`입니다.

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

`runEmbeddedAttempt()`(`runEmbeddedPiAgent()`에 의해 호출됨) 내부에서는 pi SDK가 사용됩니다.

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

`subscribeEmbeddedPiSession()`는 pi의 `AgentSession` 이벤트를 구독합니다.

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

처리되는 이벤트는 다음과 같습니다.

- `message_start` / `message_end` / `message_update` (스트리밍 텍스트/생각)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. 프롬프트

설정 후 세션에 대한 메시지가 표시됩니다.

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK는 LLM으로 전송, 도구 호출 실행, 응답 스트리밍 등 전체 에이전트 루프를 처리합니다.

## 도구 아키텍처

### 도구 파이프라인

1. **기본 도구**: pi의 `codingTools` (읽기, bash, 편집, 쓰기)
2. **사용자 정의 대체**: OpenClaw는 bash를 `exec`/`process`로 대체하고 샌드박스에 대한 읽기/편집/쓰기를 사용자 정의합니다.
3. **OpenClaw 도구**: 메시징, 브라우저, 캔버스, 세션, 크론, 게이트웨이 등
4. **채널 도구**: Discord/Telegram/Slack/WhatsApp 전용 작업 도구
5. **정책 필터링**: 프로필, 공급자, 에이전트, 그룹, 샌드박스 정책별로 필터링된 도구
6. **스키마 정규화**: Gemini/OpenAI 문제에 대해 정리된 스키마
7. **AbortSignal Wrapping**: 중단 신호를 존중하도록 래핑된 도구

### 도구 정의 어댑터

pi-agent-core의 `AgentTool`에는 pi-coding-agent의 `ToolDefinition`와 다른 `execute` 서명이 있습니다. `pi-tool-definition-adapter.ts`의 어댑터는 다음을 연결합니다.

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

`splitSdkTools()`는 `customTools`를 통해 모든 도구를 전달합니다.

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

이를 통해 OpenClaw의 정책 필터링, 샌드박스 통합 및 확장된 도구 세트가 공급자 간에 일관되게 유지됩니다.

## 시스템 프롬프트 구축

시스템 프롬프트는 `buildAgentSystemPrompt()` (`system-prompt.ts`)에 내장되어 있습니다. 도구, 도구 호출 스타일, 안전 가드레일, OpenClaw CLI 참조, 기술, 문서, 작업 공간, 샌드박스, 메시징, 응답 태그, 음성, 자동 응답, 하트비트, 런타임 메타데이터, 활성화된 경우 메모리 및 반응, 선택적 컨텍스트 파일 및 추가 시스템 프롬프트 콘텐츠를 포함한 섹션으로 전체 프롬프트를 구성합니다. 하위 에이전트에서 사용하는 최소 프롬프트 모드에 맞게 섹션이 잘립니다.

프롬프트는 `applySystemPromptOverrideToSession()`를 통해 세션 생성 후 적용됩니다.

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## 세션 관리

### 세션 파일

세션은 트리 구조(id/parentId 연결)가 있는 JSONL 파일입니다. Pi의 `SessionManager`는 지속성을 처리합니다.

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw는 도구 결과 안전을 위해 이를 `guardSessionManager()`로 래핑합니다.

### 세션 캐싱

`session-manager-cache.ts` 반복되는 파일 구문 분석을 피하기 위해 SessionManager 인스턴스를 캐시합니다.

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### 기록 제한

`limitHistoryTurns()` 채널 유형(DM 대 그룹)에 따라 대화 기록을 자릅니다.

### 압축

컨텍스트 오버플로 시 자동 압축이 트리거됩니다. `compactEmbeddedPiSessionDirect()`는 수동 압축을 처리합니다.

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## 인증 및 모델 확인

### 인증 프로필

OpenClaw는 공급자당 여러 API 키를 사용하여 인증 프로필 저장소를 유지 관리합니다.

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

쿨다운 추적을 통해 실패 시 프로필이 순환됩니다.

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### 모델 해상도

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

### 장애 조치

`FailoverError`는 다음과 같이 구성된 경우 모델 대체를 트리거합니다.

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

## 파이 확장

OpenClaw는 특수한 동작을 위해 맞춤형 pi 확장을 로드합니다.

### 다짐 보호 장치

`pi-extensions/compaction-safeguard.ts`는 적응형 토큰 예산 책정과 도구 오류 및 파일 작업 요약을 포함하여 압축에 가드레일을 추가합니다.

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### 컨텍스트 가지치기

`pi-extensions/context-pruning.ts`는 캐시 TTL 기반 컨텍스트 정리를 구현합니다.

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

## 스트리밍 및 응답 차단

### 블록 청킹

`EmbeddedBlockChunker` 스트리밍 텍스트를 개별 응답 블록으로 관리합니다.

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### 생각/최종 태그 제거

스트리밍 출력은 `<think>`/`<thinking>` 블록을 제거하고 `<final>` 콘텐츠를 추출하도록 처리됩니다.

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### 응답 지시어

`[[media:url]]`, `[[voice]]`, `[[reply:id]]`와 같은 응답 지시문이 구문 분석되고 추출됩니다.

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## 오류 처리

### 오류 분류

`pi-embedded-helpers.ts`는 적절한 처리를 위해 오류를 분류합니다.

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### 사고 수준 대체

사고 수준이 지원되지 않으면 다음과 같이 대체됩니다.

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

## 공급자별 처리

### 인류학

- 거부 마법의 끈 닦기
- 연속 역할에 대한 차례 검증
- Claude Code 매개변수 호환성

### 구글/제미니

- 턴 순서 수정 (`applyGoogleTurnOrderingFix`)
- 도구 스키마 정리 (`sanitizeToolsForGoogle`)
- 세션 기록 정리 (`sanitizeSessionHistory`)

### 오픈AI

- Codex 모델용 `apply_patch` 도구
- 사고레벨 다운그레이드 처리

## TUI 통합

OpenClaw에는 pi-tui 구성 요소를 직접 사용하는 로컬 TUI 모드도 있습니다.

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

이는 pi의 기본 모드와 유사한 대화형 터미널 경험을 제공합니다.

## Pi CLI와의 주요 차이점

| 측면            | 파이 CLI                | OpenClaw 임베디드                                                                                |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| 호출            | `pi` 명령 / RPC         | `createAgentSession()`를 통한 SDK                                                                |
| 도구            | 기본 코딩 도구          | 맞춤형 OpenClaw 도구 모음                                                                        |
| 시스템 프롬프트 | AGENTS.md + 프롬프트    | 동적 채널별/컨텍스트                                                                             |
| 세션 저장       | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/` (또는 `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| 인증            | 단일 자격 증명          | 회전이 포함된 다중 프로필                                                                        |
| 확장            | 디스크에서 로드됨       | 프로그래밍 방식 + 디스크 경로                                                                    |
| 이벤트 처리     | TUI 렌더링              | 콜백 기반(onBlockReply 등)                                                                       |

## 향후 고려 사항

재작업 가능성이 있는 영역:

1. **도구 서명 정렬**: 현재 pi-agent-core와 pi-coding-agent 서명 간에 조정 중입니다.
2. **세션 관리자 래핑**: `guardSessionManager`은 안전성을 추가하지만 복잡성을 증가시킵니다.
3. **확장 로딩**: pi의 `ResourceLoader`를 더 직접적으로 사용할 수 있습니다.
4. **스트리밍 핸들러 복잡도**: `subscribeEmbeddedPiSession`가 커졌습니다.
5. **공급자 문제**: pi가 잠재적으로 처리할 수 있는 많은 공급자별 코드 경로

## 테스트

pi 통합 및 확장을 다루는 모든 기존 테스트:

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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (실시간)
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
