---
summary: "OpenClaw 플러그인 설치, 구성 및 관리"
read_when:
  - 플러그인을 설치하거나 구성할 때
  - 플러그인 검색 및 로드 규칙을 이해할 때
  - Codex/Claude 호환 플러그인 번들로 작업할 때
title: "플러그인"
sidebarTitle: "설치 및 구성"
x-i18n:
  source_path: docs/tools/plugin.md
---

# 플러그인

플러그인은 채널, 모델 프로바이더, 도구, Skills, 음성, 이미지 생성 등의 새로운 기능으로 OpenClaw 를 확장합니다. 일부 플러그인은 **코어**(OpenClaw 와 함께 배포)이고, 다른 플러그인은 **외부**(커뮤니티에서 npm 에 게시)입니다.

## 빠른 시작

<Steps>
  <Step title="로드된 항목 확인">
    ```bash
    openclaw plugins list
    ```
  </Step>

  <Step title="플러그인 설치">
    ```bash
    # npm 에서
    openclaw plugins install @openclaw/voice-call

    # 로컬 디렉토리 또는 아카이브에서
    openclaw plugins install ./my-plugin
    openclaw plugins install ./my-plugin.tgz
    ```

  </Step>

  <Step title="Gateway 재시작">
    ```bash
    openclaw gateway restart
    ```

    그런 다음 설정 파일에서 `plugins.entries.\<id\>.config` 아래에서 구성합니다.

  </Step>
</Steps>

## 플러그인 유형

OpenClaw 은 두 가지 플러그인 형식을 인식합니다:

| 형식       | 작동 방식                                                  | 예시                                                   |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| **Native** | `openclaw.plugin.json` + 런타임 모듈; 프로세스 내에서 실행 | 공식 플러그인, 커뮤니티 npm 패키지                     |
| **Bundle** | Codex/Claude/Cursor 호환 레이아웃; OpenClaw 기능에 매핑    | `.codex-plugin/`, `.claude-plugin/`, `.cursor-plugin/` |

둘 다 `openclaw plugins list`에 표시됩니다. 번들 세부 사항은 [플러그인 번들](/plugins/bundles)을 참조하세요.

## 공식 플러그인

### 설치 가능 (npm)

| 플러그인        | 패키지                 | 문서                                 |
| --------------- | ---------------------- | ------------------------------------ |
| Matrix          | `@openclaw/matrix`     | [Matrix](/channels/matrix)           |
| Microsoft Teams | `@openclaw/msteams`    | [Microsoft Teams](/channels/msteams) |
| Nostr           | `@openclaw/nostr`      | [Nostr](/channels/nostr)             |
| Voice Call      | `@openclaw/voice-call` | [Voice Call](/plugins/voice-call)    |
| Zalo            | `@openclaw/zalo`       | [Zalo](/channels/zalo)               |
| Zalo Personal   | `@openclaw/zalouser`   | [Zalo Personal](/plugins/zalouser)   |

### 코어 (OpenClaw 와 함께 배포)

<AccordionGroup>
  <Accordion title="모델 프로바이더 (기본 활성화)">
    `anthropic`, `byteplus`, `cloudflare-ai-gateway`, `github-copilot`, `google`,
    `huggingface`, `kilocode`, `kimi-coding`, `minimax`, `mistral`, `modelstudio`,
    `moonshot`, `nvidia`, `openai`, `opencode`, `opencode-go`, `openrouter`,
    `qianfan`, `qwen-portal-auth`, `synthetic`, `together`, `venice`,
    `vercel-ai-gateway`, `volcengine`, `xiaomi`, `zai`
  </Accordion>

  <Accordion title="메모리 플러그인">
    - `memory-core` — 번들 메모리 검색 (기본값, `plugins.slots.memory`를 통해)
    - `memory-lancedb` — 자동 회상/캡처 기능이 있는 주문형 설치 장기 메모리 (`plugins.slots.memory = "memory-lancedb"` 설정)
  </Accordion>

  <Accordion title="음성 프로바이더 (기본 활성화)">
    `elevenlabs`, `microsoft`
  </Accordion>

  <Accordion title="기타">
    - `copilot-proxy` — VS Code Copilot Proxy 브리지 (기본 비활성화)
  </Accordion>
</AccordionGroup>

서드파티 플러그인을 찾고 계신가요? [커뮤니티 플러그인](/plugins/community)을 참조하세요.

## 구성

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

| 필드             | 설명                                             |
| ---------------- | ------------------------------------------------ |
| `enabled`        | 마스터 토글 (기본값: `true`)                     |
| `allow`          | 플러그인 허용 목록 (선택사항)                    |
| `deny`           | 플러그인 거부 목록 (선택사항; 거부가 우선)       |
| `load.paths`     | 추가 플러그인 파일/디렉토리                      |
| `slots`          | 독점 슬롯 선택기 (예: `memory`, `contextEngine`) |
| `entries.\<id\>` | 플러그인별 토글 + 설정                           |

설정 변경은 **Gateway 재시작이 필요합니다**.

<Accordion title="플러그인 상태: 비활성화 vs 누락 vs 유효하지 않음">
  - **비활성화**: 플러그인이 존재하지만 활성화 규칙에 의해 꺼졌습니다. 설정은 유지됩니다.
  - **누락**: 설정이 검색에서 찾지 못한 플러그인 ID 를 참조합니다.
  - **유효하지 않음**: 플러그인이 존재하지만 설정이 선언된 스키마와 일치하지 않습니다.
</Accordion>

## 검색 및 우선순위

OpenClaw 은 다음 순서로 플러그인을 검색합니다 (첫 번째 일치가 적용됨):

<Steps>
  <Step title="설정 경로">
    `plugins.load.paths` — 명시적 파일 또는 디렉토리 경로.
  </Step>

  <Step title="워크스페이스 확장">
    `\<workspace\>/.openclaw/extensions/*.ts` 및 `\<workspace\>/.openclaw/extensions/*/index.ts`.
  </Step>

  <Step title="전역 확장">
    `~/.openclaw/extensions/*.ts` 및 `~/.openclaw/extensions/*/index.ts`.
  </Step>

  <Step title="번들 플러그인">
    OpenClaw 와 함께 배포됩니다. 많은 것이 기본적으로 활성화됩니다 (모델 프로바이더, 음성).
    나머지는 명시적 활성화가 필요합니다.
  </Step>
</Steps>

### 활성화 규칙

- `plugins.enabled: false`는 모든 플러그인을 비활성화합니다
- `plugins.deny`는 항상 허용보다 우선합니다
- `plugins.entries.\<id\>.enabled: false`는 해당 플러그인을 비활성화합니다
- 워크스페이스 출처 플러그인은 **기본적으로 비활성화**됩니다 (명시적으로 활성화해야 함)
- 번들 플러그인은 재정의되지 않는 한 기본 활성 세트를 따릅니다
- 독점 슬롯은 해당 슬롯에 대해 선택된 플러그인을 강제 활성화할 수 있습니다

## 플러그인 슬롯 (독점 카테고리)

일부 카테고리는 독점적입니다 (한 번에 하나만 활성):

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 또는 비활성화하려면 "none"
      contextEngine: "legacy", // 또는 플러그인 ID
    },
  },
}
```

| 슬롯            | 제어 대상            | 기본값          |
| --------------- | -------------------- | --------------- |
| `memory`        | 활성 메모리 플러그인 | `memory-core`   |
| `contextEngine` | 활성 컨텍스트 엔진   | `legacy` (내장) |

## CLI 참조

```bash
openclaw plugins list                    # 간단한 인벤토리
openclaw plugins inspect <id>            # 상세 정보
openclaw plugins inspect <id> --json     # 기계 판독 가능
openclaw plugins status                  # 운영 요약
openclaw plugins doctor                  # 진단

openclaw plugins install <npm-spec>      # npm 에서 설치
openclaw plugins install <path>          # 로컬 경로에서 설치
openclaw plugins install -l <path>       # 링크 (복사 없음) 개발용
openclaw plugins update <id>             # 하나의 플러그인 업데이트
openclaw plugins update --all            # 모두 업데이트

openclaw plugins enable <id>
openclaw plugins disable <id>
```

자세한 내용은 [`openclaw plugins` CLI 참조](/cli/plugins)를 확인하세요.

## 플러그인 API 개요

플러그인은 함수 또는 `register(api)`를 가진 객체를 내보냅니다:

```typescript
export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    api.registerProvider({
      /* ... */
    });
    api.registerTool({
      /* ... */
    });
    api.registerChannel({
      /* ... */
    });
  },
});
```

일반적인 등록 메서드:

| 메서드                               | 등록 대상              |
| ------------------------------------ | ---------------------- |
| `registerProvider`                   | 모델 프로바이더 (LLM)  |
| `registerChannel`                    | 채팅 채널              |
| `registerTool`                       | 에이전트 도구          |
| `registerHook` / `on(...)`           | 라이프사이클 훅        |
| `registerSpeechProvider`             | 텍스트 음성 변환 / STT |
| `registerMediaUnderstandingProvider` | 이미지/오디오 분석     |
| `registerImageGenerationProvider`    | 이미지 생성            |
| `registerWebSearchProvider`          | 웹 검색                |
| `registerHttpRoute`                  | HTTP 엔드포인트        |
| `registerCommand` / `registerCli`    | CLI 명령               |
| `registerContextEngine`              | 컨텍스트 엔진          |
| `registerService`                    | 백그라운드 서비스      |

## 관련 문서

- [플러그인 만들기](/plugins/building-plugins) — 자체 플러그인 만들기
- [플러그인 번들](/plugins/bundles) — Codex/Claude/Cursor 번들 호환성
- [플러그인 매니페스트](/plugins/manifest) — 매니페스트 스키마
- [도구 등록](/plugins/building-plugins#registering-agent-tools) — 플러그인에서 에이전트 도구 추가
- [플러그인 내부 구조](/plugins/architecture) — 기능 모델 및 로드 파이프라인
- [커뮤니티 플러그인](/plugins/community) — 서드파티 목록
