---
read_when:
    - 세션 ID, 스크립트 JSONL 또는 session.json 필드를 디버그해야 합니다.
    - 자동 압축 동작을 변경하거나 "사전 압축" 관리를 추가하는 중입니다.
    - 메모리 플러시 또는 자동 시스템 전환을 구현하려는 경우
summary: '심층 분석: 세션 저장소 + 기록, 수명 주기 및 (자동)압축 내부'
title: 세션 관리 심층 분석
x-i18n:
    generated_at: "2026-02-08T16:03:48Z"
    model: gtx
    provider: google-translate
    source_hash: 6344a9eaf8797eb4e6250b0b7933f553b01e09044e19fb438453e9716e6c698a
    source_path: reference/session-management-compaction.md
    workflow: 15
---

# 세션 관리 및 압축(심층 분석)

이 문서에서는 OpenClaw가 세션을 처음부터 끝까지 관리하는 방법을 설명합니다.

- **세션 라우팅** (인바운드 메시지가 `sessionKey`)
- **세션 저장소** (`sessions.json`) 및 추적 내용
- **성적 지속성** (`*.jsonl`) 및 그 구조
- **성적표 위생** (실행 전 공급자별 수정)
- **컨텍스트 제한** (컨텍스트 창 대 추적된 토큰)
- **압축** (수동 + 자동 다짐) 및 사전 다짐 작업을 연결할 위치
- **조용한 하우스키핑** (예: 사용자가 볼 수 있는 출력을 생성해서는 안 되는 메모리 쓰기)

더 높은 수준의 개요를 먼저 보려면 다음으로 시작하세요.

- [/개념/세션](/concepts/session)
- [/개념/압축](/concepts/compaction)
- [/개념/세션 가지치기](/concepts/session-pruning)
- [/참조/기록-위생](/reference/transcript-hygiene)

---

## 진실의 근원: 게이트웨이

OpenClaw는 단일을 중심으로 설계되었습니다. **게이트웨이 프로세스** 세션 상태를 소유하는 것입니다.

- UI(macOS 앱, 웹 제어 UI, TUI)는 게이트웨이에 세션 목록 및 토큰 수를 쿼리해야 합니다.
- 원격 모드에서는 세션 파일이 원격 호스트에 있습니다. "로컬 Mac 파일 확인"은 게이트웨이가 사용하는 내용을 반영하지 않습니다.

---

## 두 개의 지속성 레이어

OpenClaw는 두 가지 계층에서 세션을 유지합니다.

1. **세션 저장소(`sessions.json`)**
   - 키/값 맵: `sessionKey -> SessionEntry`
   - 작고 변경 가능하며 편집(또는 항목 삭제)하기에 안전합니다.
   - 세션 메타데이터(현재 세션 ID, 마지막 활동, 토글, 토큰 카운터 등)를 추적합니다.

2. **성적 증명서(`<sessionId>.jsonl`)**
   - 트리 구조의 추가 전용 성적표(항목에는 `id` + `parentId`)
   - 실제 대화 + 도구 호출 + 압축 요약을 저장합니다.
   - 향후 차례를 위해 모델 컨텍스트를 재구성하는 데 사용됩니다.

---

## 디스크상의 위치

게이트웨이 호스트에서 에이전트별로 다음을 수행합니다.

- 가게: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- 성적표: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - 텔레그램 주제 세션: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw는 이러한 문제를 다음을 통해 해결합니다. `src/config/sessions.ts`.

---

## 세션 키(`sessionKey`)

에이 `sessionKey` 식별하다 _어떤 대화 버킷_ 당신은 (라우팅 + 격리) 상태입니다.

일반적인 패턴:

- 기본/직접 채팅(상담원별): `agent:<agentId>:<mainKey>` (기본 `main`)
- 그룹: `agent:<agentId>:<channel>:group:<id>`
- 룸/채널(Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` 또는 `...:room:<id>`
- 크론: `cron:<job.id>`
- 웹훅: `hook:<uuid>` (재정의되지 않는 한)

정식 규칙은 다음에 문서화되어 있습니다. [/개념/세션](/concepts/session).

---

## 세션 ID(`sessionId`)

각 `sessionKey` 현재의 점 `sessionId` (대화를 계속하는 녹취록 파일)

경험 법칙:

- **다시 놓기** (`/new`, `/reset`) 새로운 생성 `sessionId` 그것을 위해 `sessionKey`.
- **일일 재설정** (게이트웨이 호스트의 현지 시간으로 기본 오전 4시) 새 생성 `sessionId` 경계 재설정 후 다음 메시지에서.
- **유휴 만료** (`session.reset.idleMinutes` 또는 유산 `session.idleMinutes`) 새로운 생성 `sessionId` 유휴 기간 이후에 메시지가 도착할 때. 일일 + 유휴가 모두 구성된 경우 먼저 만료되는 것이 승리합니다.

구현 세부 사항: 결정은 다음에서 발생합니다. `initSessionState()` ~에 `src/auto-reply/reply/session.ts`.

---

## 세션 저장소 스키마(`sessions.json`)

상점의 값 유형은 다음과 같습니다. `SessionEntry` ~에 `src/config/sessions.ts`.

주요 필드(완전하지는 않음):

- `sessionId`: 현재 성적표 ID(파일 이름은 다음을 제외하면 여기에서 파생됩니다.) `sessionFile` 설정되어 있습니다)
- `updatedAt`: 마지막 활동 타임스탬프
- `sessionFile`: 선택적 명시적 기록 경로 재정의
- `chatType`: `direct | group | room` (UI 및 정책 전송에 도움)
- `provider`, `subject`, `room`, `space`, `displayName`: 그룹/채널 라벨링을 위한 메타데이터
- 토글:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (세션별 재정의)
- 모델 선택:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- 토큰 카운터(최선의 노력/공급자에 따라 다름):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: 이 세션 키에 대해 자동 압축이 완료된 빈도
- `memoryFlushAt`: 마지막 사전 압축 메모리 플러시에 대한 타임스탬프
- `memoryFlushCompactionCount`: 마지막 플러시 실행 시 압축 횟수

저장소는 편집해도 안전하지만 게이트웨이가 권한을 가집니다. 세션이 실행될 때 항목을 다시 쓰거나 다시 수화할 수 있습니다.

---

## 성적 증명서 구조(`*.jsonl`)

성적 증명서는 다음에 의해 관리됩니다. `@mariozechner/pi-coding-agent`'에스 `SessionManager`.

파일은 JSONL입니다.

- 첫 번째 줄: 세션 헤더(`type: "session"`, 포함 `id`, `cwd`, `timestamp`, 선택사항 `parentSession`)
- 그런 다음: 세션 항목 `id` + `parentId` (나무)

주목할만한 항목 유형:

- `message`: 사용자/도우미/도구결과 메시지
- `custom_message`: 확장 프로그램이 삽입된 메시지 _하다_ 모델 컨텍스트 입력(UI에서 숨길 수 있음)
- `custom`: 확장 상태 _~ 아니다_ 모델 컨텍스트 입력
- `compaction`: 지속적인 압축 요약 `firstKeptEntryId` 그리고 `tokensBefore`
- `branch_summary`: 트리 분기를 탐색할 때 지속되는 요약

OpenClaw는 의도적으로 **~ 아니다** "수정" 성적표; 게이트웨이가 사용하는 `SessionManager` 읽기/쓰기.

---

## 컨텍스트 창과 추적된 토큰

두 가지 다른 개념이 중요합니다.

1. **모델 컨텍스트 창**: 모델당 하드 캡(모델에 표시되는 토큰)
2. **세션 저장소 카운터**: 롤링 통계가 기록됩니다. `sessions.json` (/status 및 대시보드에 사용됨)

한도를 조정하는 경우:

- 컨텍스트 창은 모델 카탈로그에서 제공되며 구성을 통해 재정의될 수 있습니다.
- `contextTokens` 저장소에는 런타임 추정/보고 값이 있습니다. 이를 엄격한 보증으로 취급하지 마십시오.

자세한 내용은 다음을 참조하세요. [/토큰 사용](/reference/token-use).

---

## 압축 : 그것이 무엇인지

압축은 오래된 대화를 지속적인 대화로 요약합니다. `compaction` 기록에 항목을 입력하고 최근 메시지를 그대로 유지합니다.

압축 후 향후 차례는 다음을 참조하세요.

- 압축 요약
- 이후 메시지 `firstKeptEntryId`

압축은 **지속성 있는** (세션 가지치기와 다름) 보다 [/개념/세션 가지치기](/concepts/session-pruning).

---

## 자동 압축이 발생하는 경우(Pi 런타임)

내장된 Pi 에이전트에서 자동 압축은 두 가지 경우에 트리거됩니다.

1. **오버플로 복구**: 모델이 컨텍스트 오버플로 오류 → 압축 → 재시도를 반환합니다.
2. **임계값 유지 관리**: 차례가 성공적으로 끝난 후, 다음과 같은 경우:

`contextTokens > contextWindow - reserveTokens`

어디:

- `contextWindow` 모델의 컨텍스트 창입니다.
- `reserveTokens` 프롬프트 + 다음 모델 출력을 위해 예약된 헤드룸입니다.

이는 Pi 런타임 의미 체계입니다(OpenClaw는 이벤트를 소비하지만 Pi는 압축 시기를 결정합니다).

---

## 압축 설정(`reserveTokens`, `keepRecentTokens`)

Pi의 압축 설정은 Pi 설정에 있습니다.

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw는 또한 임베디드 실행에 대한 안전 바닥을 시행합니다.

- 만약에 `compaction.reserveTokens < reserveTokensFloor`, OpenClaw가 충돌합니다.
- 기본 층은 `20000` 토큰.
- 세트 `agents.defaults.compaction.reserveTokensFloor: 0` 바닥을 비활성화합니다.
- 이미 더 높은 경우 OpenClaw는 이를 그대로 둡니다.

이유: 압축이 불가피해지기 전에 다중 회전 "관리"(메모리 쓰기와 같은)를 위한 충분한 헤드룸을 남겨두십시오.

구현: `ensurePiCompactionReserveTokens()` ~에 `src/agents/pi-settings.ts`
(다음에서 전화함 `src/agents/pi-embedded-runner.ts`).

---

## 사용자가 볼 수 있는 표면

다음을 통해 압축 및 세션 상태를 관찰할 수 있습니다.

- `/status` (모든 채팅 세션에서)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- 상세 모드: `🧹 Auto-compaction complete` + 압축 횟수

---

## 조용한 살림 (`NO_REPLY`)

OpenClaw는 사용자가 중간 출력을 볼 수 없는 백그라운드 작업에 대해 "자동" 회전을 지원합니다.

협약:

- 어시스턴트는 다음으로 출력을 시작합니다. `NO_REPLY` "사용자에게 답변을 전달하지 않음"을 나타냅니다.
- OpenClaw는 전달 계층에서 이를 제거/억제합니다.

현재 `2026.1.10`, OpenClaw는 또한 **초안/타이핑 스트리밍** 부분 청크가 다음으로 시작될 때 `NO_REPLY`, 자동 작동으로 인해 회전 중에 부분 출력이 누출되지 않습니다.

---

## 사전 압축 "메모리 플러시"(구현됨)

목표: 자동 압축이 발생하기 전에 내구성을 작성하는 자동 에이전트 턴을 실행합니다.
상태를 디스크로(예: `memory/YYYY-MM-DD.md` 에이전트 작업 영역에서) 압축할 수 없습니다.
중요한 컨텍스트를 삭제합니다.

OpenClaw는 다음을 사용합니다. **임계값 이전 플러시** 접근하다:

1. 세션 컨텍스트 사용량을 모니터링합니다.
2. "소프트 임계값"(Pi의 압축 임계값 아래)을 넘으면 자동 실행
   에이전트에 "지금 메모리 쓰기" 지시문을 보냅니다.
3. 사용 `NO_REPLY` 그래서 사용자는 아무것도 볼 수 없습니다.

구성(`agents.defaults.compaction.memoryFlush`):

- `enabled` (기본: `true`)
- `softThresholdTokens` (기본: `4000`)
- `prompt` (플러시 턴에 대한 사용자 메시지)
- `systemPrompt` (평면 회전을 위해 추가 시스템 프롬프트가 추가됨)

참고:

- 기본 프롬프트/시스템 프롬프트에는 다음이 포함됩니다. `NO_REPLY` 배달을 억제하라는 힌트입니다.
- 플러시는 압축 주기당 한 번 실행됩니다(추적됨). `sessions.json`).
- 플러시는 내장된 Pi 세션에 대해서만 실행됩니다(CLI 백엔드는 건너뜁니다).
- 세션 작업공간이 읽기 전용인 경우 플러시를 건너뜁니다(`workspaceAccess: "ro"` 또는 `"none"`).
- 보다 [메모리](/concepts/memory) 작업 공간 파일 레이아웃 및 쓰기 패턴을 위해.

Pi는 또한 `session_before_compact` 확장 API를 연결하지만 OpenClaw는
플러시 논리는 오늘날 게이트웨이 측에 존재합니다.

---

## 문제 해결 체크리스트

- 세션 키가 잘못되었나요? 다음으로 시작 [/개념/세션](/concepts/session) 그리고 확인 `sessionKey` ~에 `/status`.
- 저장소와 성적표가 일치하지 않습니까? 게이트웨이 호스트와 저장소 경로를 확인하세요. `openclaw status`.
- 압축 스팸? 확인하다:
  - 모델 컨텍스트 창(너무 작음)
  - 압축 설정(`reserveTokens` 모델 창에 비해 너무 높으면 더 일찍 압축될 수 있습니다)
  - 도구 결과 팽창: 세션 정리 활성화/조정
- 조용한 회전이 새고 있습니까? 다음으로 시작하는 답장을 확인하세요. `NO_REPLY` (정확한 토큰) 스트리밍 억제 수정 사항이 포함된 빌드를 사용하고 있습니다.
