---
summary: "계획: 모든 메시징 커넥터를 위한 하나의 깨끗한 플러그인 SDK + 런타임"
read_when:
  - Defining or refactoring the plugin architecture
  - Migrating channel connectors to the plugin SDK/runtime
title: "플러그인 SDK 리팩터"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/refactor/plugin-sdk.md
  workflow: 15
---

# 플러그인 SDK + 런타임 리팩터 계획

목표: 모든 메시징 커넥터는 하나의 안정적인 API를 사용하는 플러그인 (번들 또는 외부)입니다.
플러그인이 `src/**`에서 직접 import하지 않습니다. 모든 의존성은 SDK 또는 런타임을 통해 갑니다.

## 지금 왜

- 현재 커넥터는 패턴을 혼합합니다: 직접 core import, dist-only 브리지 및 custom 헬퍼.
- 이것은 업그레이드를 취약하게 만들고 깨끗한 외부 플러그인 표면을 차단합니다.

## 목표 아키텍처 (두 레이어)

### 1) 플러그인 SDK (컴파일-시간, 안정적, 게시 가능)

범위: 유형, 헬퍼 및 config 유틸리티. 런타임 상태 없음, 부작용 없음.

내용 (예):

- 유형: `ChannelPlugin`, 어댑터, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Config 헬퍼: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- 페어링 헬퍼: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Onboarding 헬퍼: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding 유형.
- Tool 매개변수 헬퍼: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Docs 링크 헬퍼: `formatDocsLink`.

배송:

- `openclaw/plugin-sdk`로 게시합니다 (또는 core에서 `openclaw/plugin-sdk`로 export).
- 명시적 안정성 보장이 있는 Semver.

### 2) 플러그인 런타임 (실행 표면, 주입됨)

범위: core 런타임 동작을 건드리는 모든 것.
`OpenClawPluginApi.runtime`을 통해 액세스하므로 플러그인이 절대 `src/**`를 import하지 않습니다.

제안된 표면 (최소이지만 완전):

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

노트:

- 런타임은 core 동작에 액세스하는 유일한 방법입니다.
- SDK는 의도적으로 작고 안정적입니다.
- 각 런타임 메서드는 기존 core 구현에 매핑됩니다 (중복 없음).

## 마이그레이션 계획 (단계적, 안전)

### Phase 0: 스캐폴딩

- `openclaw/plugin-sdk`를 도입합니다.
- `OpenClawPluginApi`에 위의 표면이 있는 `api.runtime`을 추가합니다.
- 전환 창 동안 기존 import를 유지합니다 (감가상각 경고).

### Phase 1: 브리지 cleanup (낮은 위험)

- 확장별 `core-bridge.ts`를 `api.runtime`으로 바꾸기.
- BlueBubbles, Zalo, Zalo Personal을 먼저 마이그레이션합니다 (이미 가까움).
- 중복된 브리지 코드를 제거합니다.

### Phase 2: 가벼운 direct-import 플러그인

- Matrix를 SDK + 런타임으로 마이그레이션합니다.
- Onboarding, 디렉토리, group mention 로직을 검증합니다.

### Phase 3: 무거운 direct-import 플러그인

- MS Teams를 마이그레이션합니다 (런타임 헬퍼의 가장 큰 세트).
- Reply/typing 의미론이 현재 동작과 일치하는지 확인합니다.

### Phase 4: iMessage pluginization

- iMessage를 `extensions/imessage`로 이동합니다.
- 직접 core 호출을 `api.runtime`으로 바꾸기.
- config 키, CLI 동작 및 문서를 유지합니다.

### Phase 5: 적용

- Lint 규칙 / CI 검사 추가: `extensions/**`이 `src/**`에서 import하지 않음.
- 플러그인 SDK/버전 호환성 검사 추가 (런타임 + SDK semver).

## 호환성 및 버전 관리

- SDK: semver, 게시됨, 문서화된 변경.
- 런타임: core 릴리스별 버전화. `api.runtime.version` 추가.
- 플러그인은 필수 런타임 범위를 선언합니다 (예: `openclawRuntime: ">=2026.2.0"`).

## 테스트 전략

- 어댑터-수준 단위 테스트 (실제 core 구현으로 실행되는 런타임 함수).
- 플러그인별 golden 테스트: 동작 드리프트가 없는지 확인합니다 (라우팅, 페어링, 허용 목록, mention gating).
- CI에 사용되는 단일 end-to-end 플러그인 샘플 (설치 + 실행 + 스모크).

## 미해결 질문

- SDK 유형을 호스팅할 위치: 별도 패키지 또는 core export?
- 런타임 유형 배포: SDK에서 (유형만) 또는 core에서?
- 번들 vs 외부 플러그인에 대한 docs 링크를 노출하는 방법?
- 전환 중에 in-repo 플러그인에 대한 제한된 직접 core import를 허용할까요?

## 성공 기준

- 모든 채널 커넥터는 SDK + 런타임을 사용하는 플러그인입니다.
- `extensions/**`이 `src/**`에서 import하지 않습니다.
- 새로운 커넥터 템플릿은 SDK + 런타임에만 의존합니다.
- 외부 플러그인은 core source 액세스 없이 개발 및 업데이트할 수 있습니다.

관련 문서: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
