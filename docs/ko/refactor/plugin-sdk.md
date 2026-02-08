---
read_when:
    - 플러그인 아키텍처 정의 또는 리팩토링
    - 채널 커넥터를 플러그인 SDK/런타임으로 마이그레이션
summary: '계획: 하나의 클린 플러그인 SDK + 모든 메시징 커넥터에 대한 런타임'
title: 플러그인 SDK 리팩터링
x-i18n:
    generated_at: "2026-02-08T16:02:16Z"
    model: gtx
    provider: google-translate
    source_hash: 1f3519f43632fcac9f59ba5ef4c0d59707f18ab5a1e2f451616db89bc7bf43ff
    source_path: refactor/plugin-sdk.md
    workflow: 15
---

# 플러그인 SDK + 런타임 리팩터링 계획

목표: 모든 메시징 커넥터는 하나의 안정적인 API를 사용하는 플러그인(번들 또는 외부)입니다.
다음에서 플러그인을 가져올 수 없습니다. `src/**` 곧장. 모든 종속성은 SDK 또는 런타임을 거칩니다.

## 왜 지금인가?

- 현재 커넥터 혼합 패턴: 직접 코어 가져오기, dist 전용 브리지 및 사용자 지정 도우미.
- 이로 인해 업그레이드가 불안정해지고 깨끗한 외부 플러그인 표면이 차단됩니다.

## 대상 아키텍처(2개 계층)

### 1) 플러그인 SDK(컴파일 시간, 안정적, 게시 가능)

범위: 유형, 도우미 및 구성 유틸리티. 런타임 상태도 없고 부작용도 없습니다.

내용(예):

- 유형: `ChannelPlugin`, 어댑터, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- 구성 도우미: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`, 
  `applyAccountNameToChannelSection`.
- 페어링 도우미: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- 온보딩 도우미: `promptChannelAccessConfig`, `addWildcardAllowFrom`, 온보딩 유형.
- 도구 매개변수 도우미: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- 문서 링크 도우미: `formatDocsLink`.

배달:

- 다음으로 게시 `openclaw/plugin-sdk` (또는 아래 코어에서 내보내기 `openclaw/plugin-sdk`).
- 명시적인 안정성을 보장하는 Semver.

### 2) 플러그인 런타임(실행 표면, 주입)

범위: 핵심 런타임 동작과 관련된 모든 것.
다음을 통해 액세스 `OpenClawPluginApi.runtime` 그래서 플러그인은 절대 가져오지 않습니다 `src/**`.

제안된 표면(최소하지만 완전한):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

참고:

- 런타임은 핵심 동작에 액세스하는 유일한 방법입니다.
- SDK는 의도적으로 작고 안정적입니다.
- 각 런타임 메서드는 기존 핵심 구현에 매핑됩니다(중복 없음).

## 마이그레이션 계획(단계적, 안전)

### 0단계: 비계

- 소개하다 `openclaw/plugin-sdk`.
- 추가하다 `api.runtime` 에게 `OpenClawPluginApi` 위의 표면으로.
- 전환 기간 동안 기존 가져오기를 유지합니다(지원 중단 경고).

### 1단계: 교량 청소(낮은 위험)

- 확장자별 교체 `core-bridge.ts` ~와 함께 `api.runtime`.
- BlueBubbles, Zalo, Zalo Personal을 먼저 마이그레이션합니다(이미 종료됨).
- 중복된 브리지 코드를 제거합니다.

### 2단계: 가벼운 직접 가져오기 플러그인

- Matrix를 SDK + 런타임으로 마이그레이션합니다.
- 온보딩, 디렉터리, 그룹 언급 논리를 검증합니다.

### 3단계: 무거운 직접 가져오기 플러그인

- MS Teams(가장 큰 런타임 도우미 세트)를 마이그레이션합니다.
- 응답/입력 의미 체계가 현재 동작과 일치하는지 확인하세요.

### 4단계: iMessage 플러그인화

- iMessage를 다음으로 이동하세요. `extensions/imessage`.
- 직접 핵심 호출을 다음으로 대체 `api.runtime`.
- 구성 키, CLI 동작 및 문서를 그대로 유지합니다.

### 5단계: 시행

- 린트 규칙/CI 확인 추가: 아니요 `extensions/**` 에서 수입 `src/**`.
- 플러그인 SDK/버전 호환성 검사를 추가합니다(런타임 + SDK semver).

## 호환성 및 버전 관리

- SDK: semver, 게시, 문서화된 변경 사항.
- 런타임: 코어 릴리스별로 버전이 지정됩니다. 추가하다 `api.runtime.version`.
- 플러그인은 필수 런타임 범위를 선언합니다(예: `openclawRuntime: ">=2026.2.0"`).

## 테스트 전략

- 어댑터 수준 단위 테스트(실제 핵심 구현으로 실행되는 런타임 기능)
- 플러그인별 골든 테스트: 동작 드리프트(라우팅, 페어링, 허용 목록, 멘션 게이팅)가 없는지 확인합니다.
- CI(설치 + 실행 + 스모크)에 사용되는 단일 엔드투엔드 플러그인 샘플입니다.

## 공개 질문

- SDK 유형을 호스팅할 위치: 별도의 패키지 또는 코어 내보내기?
- 런타임 유형 배포: SDK(유형만) 또는 코어에서?
- 번들 플러그인과 외부 플러그인에 대한 문서 링크를 노출하는 방법은 무엇입니까?
- 전환 중에 저장소 내 플러그인에 대해 제한된 직접 코어 가져오기를 허용합니까?

## 성공 기준

- 모든 채널 커넥터는 SDK + 런타임을 사용하는 플러그인입니다.
- 아니요 `extensions/**` 에서 수입 `src/**`.
- 새 커넥터 템플릿은 SDK + 런타임에만 의존합니다.
- 핵심 소스에 액세스하지 않고도 외부 플러그인을 개발하고 업데이트할 수 있습니다.

관련 문서: [플러그인](/tools/plugin), [채널](/channels/index), [구성](/gateway/configuration).
