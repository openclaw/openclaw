---
summary: "계획: 모든 메시징 커넥터를 위한 하나의 깔끔한 플러그인 SDK + 런타임"
read_when:
  - 플러그인 아키텍처를 정의하거나 리팩터링할 때
  - 채널 커넥터를 플러그인 SDK/런타임으로 마이그레이션할 때
title: "플러그인 SDK 리팩터링"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:11Z
---

# 플러그인 SDK + 런타임 리팩터링 계획

목표: 모든 메시징 커넥터가 하나의 안정적인 API 를 사용하는 플러그인(번들 또는 외부)이어야 합니다.
어떤 플러그인도 `src/**` 를 직접 임포트하지 않습니다. 모든 의존성은 SDK 또는 런타임을 통해서만 접근합니다.

## 지금 필요한 이유

- 현재 커넥터들은 패턴이 혼재되어 있습니다: 코어를 직접 임포트, dist 전용 브리지, 커스텀 헬퍼.
- 이로 인해 업그레이드가 취약해지고, 깔끔한 외부 플러그인 인터페이스를 제공하는 데 장애가 됩니다.

## 목표 아키텍처 (두 계층)

### 1) 플러그인 SDK (컴파일 타임, 안정적, 배포 가능)

범위: 타입, 헬퍼, 설정 유틸리티. 런타임 상태나 사이드 이펙트는 포함하지 않습니다.

구성 요소 (예시):

- 타입: `ChannelPlugin`, 어댑터, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- 설정 헬퍼: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- 페어링 헬퍼: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- 온보딩 헬퍼: `promptChannelAccessConfig`, `addWildcardAllowFrom`, 온보딩 타입.
- 도구 파라미터 헬퍼: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- 문서 링크 헬퍼: `formatDocsLink`.

전달 방식:

- `openclaw/plugin-sdk` 로 퍼블리시(또는 코어에서 `openclaw/plugin-sdk` 로 export).
- 명시적인 안정성 보장을 포함한 semver 적용.

### 2) 플러그인 런타임 (실행 표면, 주입됨)

범위: 코어 런타임 동작에 접촉하는 모든 것.
플러그인은 `OpenClawPluginApi.runtime` 를 통해서만 접근하며, `src/**` 를 직접 임포트하지 않습니다.

제안된 표면 (최소이지만 완전함):

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

참고 사항:

- 런타임은 코어 동작에 접근하는 유일한 방법입니다.
- SDK 는 의도적으로 작고 안정적으로 유지됩니다.
- 각 런타임 메서드는 기존 코어 구현에 매핑됩니다(중복 없음).

## 마이그레이션 계획 (단계적, 안전)

### Phase 0: 스캐폴딩

- `openclaw/plugin-sdk` 도입.
- 위의 표면을 포함하여 `OpenClawPluginApi` 에 `api.runtime` 추가.
- 전환 기간 동안 기존 임포트 유지(사용 중단 경고 포함).

### Phase 1: 브리지 정리 (저위험)

- 확장별 `core-bridge.ts` 를 `api.runtime` 로 교체.
- BlueBubbles, Zalo, Zalo Personal 을 먼저 마이그레이션(이미 상당 부분 근접).
- 중복된 브리지 코드 제거.

### Phase 2: 직접 임포트가 적은 플러그인

- Matrix 를 SDK + 런타임으로 마이그레이션.
- 온보딩, 디렉토리, 그룹 멘션 로직 검증.

### Phase 3: 직접 임포트가 많은 플러그인

- MS Teams 마이그레이션(런타임 헬퍼 세트가 가장 큼).
- 답장/타이핑 시맨틱이 현재 동작과 일치하는지 확인.

### Phase 4: iMessage 플러그인화

- iMessage 를 `extensions/imessage` 로 이동.
- 직접 코어 호출을 `api.runtime` 로 교체.
- 설정 키, CLI 동작, 문서는 그대로 유지.

### Phase 5: 강제 적용

- 린트 규칙 / CI 체크 추가: `src/**` 에서 `extensions/**` 임포트 금지.
- 플러그인 SDK/버전 호환성 검사 추가(런타임 + SDK semver).

## 호환성 및 버저닝

- SDK: semver, 퍼블리시, 변경 사항 문서화.
- 런타임: 코어 릴리스별로 버전 관리. `api.runtime.version` 추가.
- 플러그인은 필요한 런타임 범위를 선언(예: `openclawRuntime: ">=2026.2.0"`).

## 테스트 전략

- 어댑터 레벨 유닛 테스트(실제 코어 구현으로 런타임 함수 실행).
- 플러그인별 골든 테스트: 동작 변화 없음 보장(라우팅, 페어링, 허용 목록, 멘션 게이팅).
- CI 에서 사용하는 단일 엔드투엔드 플러그인 샘플(설치 + 실행 + 스모크 테스트).

## 열린 질문

- SDK 타입을 어디에 호스팅할 것인가: 별도 패키지 또는 코어 export?
- 런타임 타입 배포: SDK 에 포함(타입만) 또는 코어에 포함?
- 번들 플러그인과 외부 플러그인에 대해 문서 링크를 어떻게 노출할 것인가?
- 전환 기간 동안 저장소 내 플러그인에 대해 제한적인 직접 코어 임포트를 허용할 것인가?

## 성공 기준

- 모든 채널 커넥터가 SDK + 런타임을 사용하는 플러그인입니다.
- `src/**` 에서 `extensions/**` 임포트가 없습니다.
- 새로운 커넥터 템플릿은 SDK + 런타임에만 의존합니다.
- 외부 플러그인은 코어 소스 접근 없이 개발 및 업데이트할 수 있습니다.

관련 문서: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
