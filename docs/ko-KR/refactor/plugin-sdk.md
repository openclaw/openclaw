````markdown
---
summary: "계획: 모든 메시징 커넥터를 위한 하나의 깔끔한 플러그인 SDK + 런타임"
read_when:
  - 플러그인 아키텍처 정의 또는 리팩토링
  - 채널 커넥터를 플러그인 SDK/런타임으로 마이그레이션
title: "플러그인 SDK 리팩터링"
---

# 플러그인 SDK + 런타임 리팩터링 계획

목표: 모든 메시징 커넥터가 하나의 안정적인 API를 사용하는 플러그인(번들 또는 외부)이다.
모든 플러그인은 `src/**`에서 직접 가져오지 않는다. 모든 종속성은 SDK나 런타임을 통해 해결된다.

## 왜 지금인가

- 현재 커넥터는 패턴이 섞여 있음: 직접 코어 가져오기, 배포 전용 브리지, 커스텀 헬퍼.
- 이것은 업그레이드를 불안정하게 만들고, 깨끗한 외부 플러그인 표면을 막는다.

## 목표 아키텍처 (두 계층)

### 1) 플러그인 SDK (컴파일 시간, 안정적, 게시 가능)

범위: 유형, 헬퍼, 설정 유틸리티. 런타임 상태 없음, 부작용 없음.

내용 (예시):

- 유형: `ChannelPlugin`, 어댑터, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- 설정 헬퍼: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- 페어링 헬퍼: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- 온보딩 헬퍼: `promptChannelAccessConfig`, `addWildcardAllowFrom`, 온보딩 유형.
- 도구 파라미터 헬퍼: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- 문서 링크 헬퍼: `formatDocsLink`.

전달:

- `openclaw/plugin-sdk`로 게시 (또는 코어에서 `openclaw/plugin-sdk`로 내보내기).
- 명시적인 안정성 보장과 함께 semver.

### 2) 플러그인 런타임 (실행 표면, 주입됨)

범위: 코어 런타임 동작과 관련된 모든 것.
플러그인에서 `src/**`를 가져오지 않고 `OpenClawPluginApi.runtime`을 통해 접근.

제안된 표면 (최소하지만 완전함):

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
      createReplyDispatcherWithTyping?: unknown; // Teams 스타일 흐름에 대한 어댑터
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: RoutePeerKind; id: string };
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
````

주의사항:

- 런타임은 코어 동작에 접근하는 유일한 방법이다.
- SDK는 의도적으로 작고 안정적이다.
- 각 런타임 메서드는 기존 코어 구현에 매핑된다 (중복 없음).

## 마이그레이션 계획 (단계적, 안전함)

### 0단계: 스캐폴딩

- `openclaw/plugin-sdk` 도입.
- `OpenClawPluginApi`에 위의 표면과 함께 `api.runtime` 추가.
- 전환 기간 동안 기존 가져오기를 유지 (사용 중단 경고).

### 1단계: 브리지 정리 (낮은 위험)

- 확장당 `core-bridge.ts`를 `api.runtime`으로 교체.
- BlueBubbles, Zalo, Zalo Personal을 먼저 마이그레이션 (이미 가까워짐).
- 중복된 브리지 코드 제거.

### 2단계: 가벼운 직접 가져오기 플러그인

- Matrix를 SDK + 런타임으로 마이그레이션.
- 온보딩, 디렉토리, 그룹 멘션 논리를 검증.

### 3단계: 무거운 직접 가져오기 플러그인

- MS Teams 마이그레이션 (가장 많은 런타임 헬퍼 세트).
- 답장/타이핑 의미가 현재 동작과 일치하는지 확인.

### 4단계: iMessage 플러그인화

- iMessage를 `extensions/imessage`로 이동.
- 직접 코어 호출을 `api.runtime`으로 교체.
- 설정 키, CLI 동작 및 문서 그대로 유지.

### 5단계: 시행

- 린트 규칙/CI 검사 추가: `extensions/**`에서 `src/**`로 가져오기 금지.
- 플러그인 SDK/버전 호환성 검사 추가 (런타임 + SDK semver).

## 호환성 및 버전 관리

- SDK: semver, 게시, 문서화된 변경 사항.
- 런타임: 코어 릴리스별 버전 관리. `api.runtime.version` 추가.
- 플러그인은 필수 런타임 범위를 선언함 (예: `openclawRuntime: ">=2026.2.0"`).

## 테스트 전략

- 어댑터 수준 단위 테스트 (실제 코어 구현으로 런타임 함수 실행).
- 플러그인별 골든 테스트: 동작 드리프트 없음 보장 (라우팅, 페어링, 허용 목록, 멘션 게이팅).
- CI에서 사용되는 단일 엔드투엔드 플러그인 샘플 (설치 + 실행 + 스모크).

## 미해결 질문

- SDK 유형을 어디에 호스팅할 것인가: 개별 패키지 또는 코어 내보내기?
- 런타임 유형 배포: SDK 내에서(유형만) 또는 코어 내에서?
- 번들화된 플러그인 vs 외부 플러그인에 대한 문서 링크를 어떻게 노출할 것인가?
- 전환 중에 리포 내 플러그인을 위해 제한된 직접 코어 가져오기를 허용할 것인가?

## 성공 기준

- 모든 채널 커넥터는 SDK + 런타임을 사용하는 플러그인이 된다.
- `extensions/**`에서 `src/**`의 가져오기가 없다.
- 새로운 커넥터 템플릿은 SDK + 런타임에만 의존.
- 외부 플러그인은 코어 소스 액세스 없이 개발 및 업데이트 가능.

관련 문서: [플러그인](/tools/plugin), [채널](/channels/index), [설정](/gateway/configuration).

```

```
