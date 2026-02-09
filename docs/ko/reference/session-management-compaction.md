---
summary: "심층 분석: 세션 스토어 + 트랜스크립트, 라이프사이클, 그리고 (자동) 컴팩션 내부 동작"
read_when:
  - 세션 id, 트랜스크립트 JSONL, 또는 sessions.json 필드를 디버그해야 할 때
  - 자동 컴팩션 동작을 변경하거나 '사전 컴팩션' 하우스키핑을 추가할 때
  - 메모리 플러시 또는 사용자에게 보이지 않는 시스템 턴을 구현하려는 경우
title: "세션 관리 심층 분석"
---

# 세션 관리 & 컴팩션 (심층 분석)

이 문서는 OpenClaw 가 세션을 엔드투엔드로 관리하는 방식을 설명합니다:

- **세션 라우팅** (인바운드 메시지가 `sessionKey` 에 어떻게 매핑되는지)
- **세션 스토어** (`sessions.json`) 와 그 추적 대상
- **트랜스크립트 영속화** (`*.jsonl`) 및 구조
- **트랜스크립트 위생** (실행 전 프로바이더별 보정)
- **컨텍스트 한계** (컨텍스트 윈도우 vs 추적 토큰)
- **컴팩션** (수동 + 자동 컴팩션) 및 사전 컴팩션 작업을 연결하는 위치
- **무음 하우스키핑** (예: 사용자에게 보이는 출력이 없어야 하는 메모리 쓰기)

먼저 상위 수준의 개요가 필요하다면 다음부터 시작하십시오:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## 진실의 원천: Gateway(게이트웨이)

OpenClaw 는 세션 상태를 소유하는 단일 **Gateway 프로세스**를 중심으로 설계되었습니다.

- UI (macOS 앱, 웹 Control UI, TUI) 는 세션 목록과 토큰 수를 Gateway 에 질의해야 합니다.
- 원격 모드에서는 세션 파일이 원격 호스트에 있으며, '로컬 Mac 파일 확인'은 Gateway 가 사용하는 내용을 반영하지 않습니다.

---

## 두 가지 영속화 계층

OpenClaw 는 세션을 두 계층으로 영속화합니다:

1. **세션 스토어 (`sessions.json`)**
   - 키/값 맵: `sessionKey -> SessionEntry`
   - 작고 가변적이며, 편집(또는 항목 삭제)이 안전합니다.
   - 세션 메타데이터(현재 세션 id, 마지막 활동, 토글, 토큰 카운터 등)를 추적합니다.

2. **트랜스크립트 (`<sessionId>.jsonl`)**
   - 트리 구조를 가진 append-only 트랜스크립트(항목은 `id` + `parentId` 를 가짐)
   - 실제 대화 + 도구 호출 + 컴팩션 요약을 저장합니다.
   - 향후 턴을 위한 모델 컨텍스트를 재구성하는 데 사용됩니다.

---

## 디스크 상 위치

Gateway 호스트에서 에이전트별로:

- 스토어: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- 트랜스크립트: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram 토픽 세션: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw 는 `src/config/sessions.ts` 를 통해 이를 해석합니다.

---

## 세션 키 (`sessionKey`)

`sessionKey` 는 _어떤 대화 버킷_에 있는지를 식별합니다(라우팅 + 격리).

일반적인 패턴:

- 메인/다이렉트 채팅(에이전트별): `agent:<agentId>:<mainKey>` (기본값 `main`)
- 그룹: `agent:<agentId>:<channel>:group:<id>`
- 룸/채널(Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` 또는 `...:room:<id>`
- 크론: `cron:<job.id>`
- 웹훅: `hook:<uuid>` (재정의되지 않는 한)

정식 규칙은 [/concepts/session](/concepts/session) 에 문서화되어 있습니다.

---

## 세션 id (`sessionId`)

각 `sessionKey` 는 현재 `sessionId` (대화를 이어가는 트랜스크립트 파일)을 가리킵니다.

경험칙:

- **리셋** (`/new`, `/reset`) 은 해당 `sessionKey` 에 대해 새로운 `sessionId` 를 생성합니다.
- **일일 리셋** (기본값 Gateway 호스트 로컬 시간 오전 4:00) 은 리셋 경계 이후 첫 메시지에서 새로운 `sessionId` 를 생성합니다.
- **유휴 만료** (`session.reset.idleMinutes` 또는 레거시 `session.idleMinutes`) 는 유휴 윈도우 이후 메시지가 도착하면 새로운 `sessionId` 를 생성합니다. 일일 + 유휴가 모두 구성된 경우 먼저 만료되는 쪽이 우선합니다.

구현 세부 사항: 결정은 `src/auto-reply/reply/session.ts` 의 `initSessionState()` 에서 이루어집니다.

---

## 세션 스토어 스키마 (`sessions.json`)

스토어의 값 타입은 `src/config/sessions.ts` 의 `SessionEntry` 입니다.

주요 필드(전부는 아님):

- `sessionId`: 현재 트랜스크립트 id (파일명은 `sessionFile` 가 설정되지 않는 한 여기에서 파생됨)
- `updatedAt`: 마지막 활동 타임스탬프
- `sessionFile`: 선택적 명시적 트랜스크립트 경로 오버라이드
- `chatType`: `direct | group | room` (UI 및 전송 정책에 도움)
- `provider`, `subject`, `room`, `space`, `displayName`: 그룹/채널 라벨링을 위한 메타데이터
- 토글:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (세션별 오버라이드)
- 모델 선택:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- 토큰 카운터(최선의 노력 / 프로바이더 의존):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: 이 세션 키에 대해 자동 컴팩션이 완료된 횟수
- `memoryFlushAt`: 마지막 사전 컴팩션 메모리 플러시의 타임스탬프
- `memoryFlushCompactionCount`: 마지막 플러시가 실행되었을 때의 컴팩션 카운트

스토어는 편집해도 안전하지만, 권한은 Gateway 에 있습니다. 세션 실행 중 항목을 다시 쓰거나 재수화할 수 있습니다.

---

## 트랜스크립트 구조 (`*.jsonl`)

트랜스크립트는 `@mariozechner/pi-coding-agent` 의 `SessionManager` 에 의해 관리됩니다.

파일은 JSONL 입니다:

- 첫 줄: 세션 헤더 (`type: "session"`, `id`, `cwd`, `timestamp`, 선택적 `parentSession` 포함)
- 이후: `id` + `parentId` (트리) 를 가진 세션 항목

주요 항목 유형:

- `message`: 사용자/어시스턴트/toolResult 메시지
- `custom_message`: 모델 컨텍스트에 _포함되는_ 확장 주입 메시지(UI 에서 숨길 수 있음)
- `custom`: 모델 컨텍스트에 _포함되지 않는_ 확장 상태
- `compaction`: `firstKeptEntryId` 와 `tokensBefore` 를 포함한 영속화된 컴팩션 요약
- `branch_summary`: 트리 브랜치를 탐색할 때의 영속화된 요약

OpenClaw 는 의도적으로 트랜스크립트를 “수정”하지 않습니다. Gateway 는 `SessionManager` 를 사용해 이를 읽고 씁니다.

---

## 컨텍스트 윈도우 vs 추적 토큰

두 가지 서로 다른 개념이 중요합니다:

1. **모델 컨텍스트 윈도우**: 모델별 하드 상한(모델에 보이는 토큰)
2. **세션 스토어 카운터**: `sessions.json` 에 기록되는 롤링 통계(/status 및 대시보드에 사용)

한계를 조정할 때:

- 컨텍스트 윈도우는 모델 카탈로그에서 오며(구성으로 오버라이드 가능),
- 스토어의 `contextTokens` 는 런타임 추정/리포팅 값이므로 엄격한 보장으로 취급하지 마십시오.

자세한 내용은 [/token-use](/reference/token-use) 를 참고하십시오.

---

## 컴팩션: 무엇인가

컴팩션은 오래된 대화를 트랜스크립트의 영속화된 `compaction` 항목으로 요약하고, 최근 메시지는 그대로 유지합니다.

컴팩션 이후의 향후 턴에서는 다음을 보게 됩니다:

- 컴팩션 요약
- `firstKeptEntryId` 이후의 메시지

컴팩션은 **영속적**입니다(세션 프루닝과 달리). [/concepts/session-pruning](/concepts/session-pruning) 을 참고하십시오.

---

## 자동 컴팩션이 발생하는 시점 (Pi 런타임)

임베디드 Pi 에이전트에서 자동 컴팩션은 두 가지 경우에 트리거됩니다:

1. **오버플로 복구**: 모델이 컨텍스트 오버플로 오류를 반환 → 컴팩트 → 재시도.
2. **임계값 유지**: 성공적인 턴 이후, 다음 조건일 때:

`contextTokens > contextWindow - reserveTokens`

여기서:

- `contextWindow` 는 모델의 컨텍스트 윈도우입니다.
- `reserveTokens` 는 프롬프트 + 다음 모델 출력에 예약된 여유 공간입니다.

이는 Pi 런타임 의미론입니다(OpenClaw 는 이벤트를 소비하지만, 컴팩션 시점은 Pi 가 결정합니다).

---

## 컴팩션 설정 (`reserveTokens`, `keepRecentTokens`)

Pi 의 컴팩션 설정은 Pi 설정에 있습니다:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw 는 임베디드 실행에 대해 안전 하한을 강제합니다:

- `compaction.reserveTokens < reserveTokensFloor` 인 경우, OpenClaw 가 이를 상향합니다.
- 기본 하한은 `20000` 토큰입니다.
- `agents.defaults.compaction.reserveTokensFloor: 0` 를 설정하면 하한을 비활성화합니다.
- 이미 더 높다면 OpenClaw 는 변경하지 않습니다.

이유: 컴팩션이 불가피해지기 전에 메모리 쓰기 같은 다중 턴 “하우스키핑”을 위한 충분한 여유를 남기기 위함입니다.

구현: `src/agents/pi-settings.ts` 의 `ensurePiCompactionReserveTokens()`
(`src/agents/pi-embedded-runner.ts` 에서 호출됨).

---

## 사용자에게 보이는 표면

다음을 통해 컴팩션과 세션 상태를 관찰할 수 있습니다:

- `/status` (어떤 채팅 세션에서도)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- 상세 모드: `🧹 Auto-compaction complete` + 컴팩션 카운트

---

## 무음 하우스키핑 (`NO_REPLY`)

OpenClaw 는 사용자에게 중간 출력이 보이지 않아야 하는 백그라운드 작업을 위한 “무음” 턴을 지원합니다.

관례:

- 어시스턴트는 출력 시작을 `NO_REPLY` 로 하여 “사용자에게 답변을 전달하지 않음”을 표시합니다.
- OpenClaw 는 전달 계층에서 이를 제거/억제합니다.

`2026.1.10` 부터는, 부분 청크가 `NO_REPLY` 로 시작할 때 **초안/타이핑 스트리밍**도 억제하여, 무음 작업이 턴 중간에 부분 출력으로 새지 않도록 합니다.

---

## 사전 컴팩션 “메모리 플러시” (구현됨)

목표: 자동 컴팩션이 발생하기 전에, 영속 상태를 디스크에 기록하는 무음 에이전트 턴을 실행하여(예: 에이전트 워크스페이스의 `memory/YYYY-MM-DD.md`), 컴팩션이 중요한 컨텍스트를 지우지 못하게 합니다.

OpenClaw 는 **사전 임계값 플러시** 접근을 사용합니다:

1. 세션 컨텍스트 사용량을 모니터링합니다.
2. “소프트 임계값”(Pi 의 컴팩션 임계값보다 낮음)을 넘으면, 에이전트에 무음
   “지금 메모리 쓰기” 지시를 실행합니다.
3. `NO_REPLY` 를 사용하여 사용자에게 아무것도 보이지 않게 합니다.

구성 (`agents.defaults.compaction.memoryFlush`):

- `enabled` (기본값: `true`)
- `softThresholdTokens` (기본값: `4000`)
- `prompt` (플러시 턴을 위한 사용자 메시지)
- `systemPrompt` (플러시 턴에 추가되는 시스템 프롬프트)

참고:

- 기본 프롬프트/시스템 프롬프트에는 전달을 억제하기 위한 `NO_REPLY` 힌트가 포함됩니다.
- 플러시는 컴팩션 사이클당 한 번 실행됩니다(`sessions.json` 에서 추적).
- 플러시는 임베디드 Pi 세션에서만 실행됩니다(CLI 백엔드는 건너뜁니다).
- 세션 워크스페이스가 읽기 전용인 경우(`workspaceAccess: "ro"` 또는 `"none"`) 플러시는 건너뜁니다.
- 워크스페이스 파일 레이아웃과 쓰기 패턴은 [Memory](/concepts/memory) 를 참고하십시오.

Pi 는 확장 API 에서 `session_before_compact` 훅도 노출하지만, OpenClaw 의
플러시 로직은 현재 Gateway 측에 있습니다.

---

## 문제 해결 체크리스트

- 세션 키가 잘못되었습니까? [/concepts/session](/concepts/session) 부터 시작하여 `/status` 의 `sessionKey` 를 확인하십시오.
- 스토어 vs 트랜스크립트 불일치입니까? Gateway 호스트와 `openclaw status` 에서 스토어 경로를 확인하십시오.
- 컴팩션이 과도합니까? 다음을 확인하십시오:
  - 모델 컨텍스트 윈도우(너무 작음)
  - 컴팩션 설정(모델 윈도우에 비해 `reserveTokens` 가 너무 높으면 더 이른 컴팩션을 유발할 수 있음)
  - tool-result 팽창: 세션 프루닝을 활성화/조정하십시오
- 무음 턴이 새고 있습니까? 응답이 `NO_REPLY` (정확한 토큰)로 시작하는지, 그리고 스트리밍 억제 수정이 포함된 빌드인지 확인하십시오.
