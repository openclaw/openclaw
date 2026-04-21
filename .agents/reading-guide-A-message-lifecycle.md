# Reading Guide A — 메시지 한 통의 일생 (조감도)

유스케이스: 인바운드 메시지 한 건의 흐름을 따라간다 — 채널 extension → plugin loader → plugin-sdk seam → 채널 core → gateway protocol → agent → 아웃바운드 스트리밍. 각 정차역은 **barrel/진입점 수준까지만** 연다. 이번 패스에서는 구현 내부로 들어가지 말 것.

## 1. 채널 extension (대표 샘플)

경로: `extensions/telegram/`

- 역할: 외부 메시징 서피스를 OpenClaw로 끌어오는 번들 plugin 하나.
- 최상위에 보이는 공개 seam: `api.ts`, `runtime-api.ts`, `openclaw.plugin.json`, `package.json` (`src/` 내부는 아직 열지 말 것).
- 여기서 확인할 질문:
  - `api.ts`에 re-export되는 심볼과 `runtime-api.ts`의 lazy-only 심볼이 어떻게 갈리나?
  - `openclaw.plugin.json`이 capability/contract를 어떻게 선언하나 (manifest-first 컨트롤 플레인)?
  - "설정/메타데이터"와 "런타임 동작"의 경계가 어디 그어져 있나?

## 2. Plugin loader + registry

경로: `src/plugins/loader.ts`, `src/plugins/registry-types.ts`

- 역할: plugin manifest를 발견하고, 번들 plugin을 와이어링하고, 코어에 노출한다.
- 정정사항: 단일 `registry.ts`는 없다. registry 서피스가 `registry-types.ts` + `registry-empty.ts`로 쪼개져 있고, `channel-catalog-registry.ts` 같은 `*-registry.ts` 형제들이 여러 개 공존한다.
- 여기서 확인할 질문:
  - manifest가 실제 등록으로 변환되는 지점은 어디인가?
  - 어떤 등록이 transitional한 "broad mutable" 리스트이고, 어떤 게 manifest로 선언된 것인가?
  - 서드파티 plugin이 어디로 끼어들 수 있나 (숨겨진 경로 없음 원칙)?

## 3. Plugin SDK 공개 barrel

경로: `src/plugin-sdk/index.ts`

- 역할: plugin이 core에서 import할 수 있는 **유일한** seam.
- 확인된 형제 파일: `core.ts`, `channel-setup.ts`, `channel-streaming.ts` (모두 존재).
- 여기서 확인할 질문:
  - 채널 plugin이 setup 시점에 받는 구체 타입은?
  - plugin이 채널 내부를 건드리지 않게 스트리밍 primitive가 어떤 모양으로 빚어져 있나?
  - "deprecated / versioned" export가 있나 — 계약 진화의 단서.

참고: `src/plugin-sdk/channel-streaming.ts:1`

## 4. 채널 core

경로: `src/channels/`

- 역할: 채널 binding, 세션, allowlist, 드래프트 스트리밍에 대한 **코어 측** 지원 — 특정 메시징 서피스에 의존하지 않음.
- 형태 메모: flat TS 파일. per-channel 서브디렉토리 없음. 서피스별 코드는 `extensions/`에 있다. `plugins/` 서브폴더는 코어 측 plugin glue 담당.
- 여기서 확인할 질문:
  - SDK barrel과 이름이 대응되는 `channel-*` seam들 (예: `draft-stream-loop.ts`, `session.ts`, `registry.ts`).
  - extension-agnostic하게 남아야 하는 경계는 어디?
  - inbound debounce / run-state / conversation-binding이 어디 사는지 — 이것들이 메시지가 agent에 닿을지 말지를 결정한다.

## 5. Gateway protocol

경로: `src/gateway/protocol/index.ts`, `src/gateway/protocol/schema.ts`

- 역할: gateway 클라이언트-서버 간 wire 계약.
- 여기서 확인할 질문:
  - `schema/` 아래 어느 frame/session/push/command 파일이 버저닝된 shape를 소유하나?
  - 변경이 additive(안전)인지 incompatible(버저닝+문서+클라이언트 후속 필요)인지 구분하는 기준은?
  - 변경 제안 전에 `src/gateway/protocol/AGENTS.md`를 먼저 읽을 것.

## 6. Agent 진입점

경로: `src/agents/agent-command.ts`

- 역할: 확정된 세션에 대해 agent 런타임/추론 루프로 명령을 dispatch.
- 정정사항: `src/agents/` 최상위에 `agent-runtime.ts`는 없다. `agent-command.ts`에서 시작해 `agent-harness.ts`, `agent-runtime-config.ts`, transport-stream 파일들로 import를 따라갈 것.
- 여기서 확인할 질문:
  - 채널이 배달한 payload가 어떻게 agent 호출로 변환되나?
  - provider-specific 코드와 generic 추론 루프가 어디서 갈라지나?
  - 아웃바운드 스트림이 나중에 다시 붙는 훅은 어디인가?

## 7. 스트리밍 계약

경로: `docs/concepts/streaming.md`

- 역할: 외부 메시징 서피스는 **절대** token-delta 채널 메시지를 내보내면 안 된다고 선언. preview/block은 메시지 edit/chunk로 전달하고 final/fallback 배달을 보장해야 한다.
- 왜 여기서 중요한가: 유스케이스 A의 아웃바운드 절반은 이 규칙을 내재화해야 말이 된다 — 채널/SDK 스트리밍 seam이 존재하는 이유 자체가 이 불변성을 강제하기 위함.

## 읽으면서 따로 모아둘 3개 질문

읽다가 채워라. 나중에 좋은 PR이나 문서가 된다.

1. core에 아직도 번들 채널/provider id를 하드코딩해서 특수 처리하는 지점이 (있다면) 어디? manifest 필드로 표현할 수 있는데도.
2. `src/plugins/` 안에서 transitional하다고 느껴지는 "broad mutable registry"는 뭐고, 그걸 은퇴시킬 manifest 기반 대체는 어떤 모양?
3. 인바운드 경로에서 agent가 보기 전에 메시지를 drop/debounce하는 결정이 어디서 일어나고, 그 결정이 로그로 관찰 가능한가?
