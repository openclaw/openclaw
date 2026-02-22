---
summary: "심층 분석: 세션 저장소 + 전사, 라이프사이클, (자동)압축 내부"
read_when:
  - 세션 ID, 전사 JSONL 또는 sessions.json 필드를 디버그해야 할 때
  - 자동 압축 동작을 변경하거나 "사전 압축" 하우스키핑을 추가할 때
  - 메모리 플러시 또는 조용한 시스템 전환을 구현하려 할 때
title: "세션 관리 심층 분석"
---

# 세션 관리 & 압축 (심층 분석)

이 문서는 OpenClaw가 세션을 처음부터 끝까지 관리하는 방법을 설명합니다:

- **세션 라우팅** (유입 메시지가 `sessionKey`에 어떻게 매핑되는지)
- **세션 저장소** (`sessions.json`) 및 추적 내용
- **전사 지속성** (`*.jsonl`) 및 구조
- **전사 위생** (프로바이더별 수정)
- **컨텍스트 제한** (컨텍스트 윈도우 vs 추적된 토큰)
- **압축** (수동 + 자동 압축) 및 사전 압축 작업 훅 위치
- **조용한 하우스키핑** (예: 사용자에게 보이지 않는 메모리 쓰기)

보다 상위 개요가 필요하다면, 다음을 먼저 시작하세요:

- [/concepts/session](/ko-KR/concepts/session)
- [/concepts/compaction](/ko-KR/concepts/compaction)
- [/concepts/session-pruning](/ko-KR/concepts/session-pruning)
- [/reference/transcript-hygiene](/ko-KR/reference/transcript-hygiene)

---

## 진실의 원천: 게이트웨이

OpenClaw는 세션 상태를 소유하는 단일 **게이트웨이 프로세스**를 중심으로 설계되었습니다.

- UI(macOS 앱, 웹 제어 UI, TUI)는 게이트웨이에서 세션 목록과 토큰 수를 쿼리해야 합니다.
- 원격 모드에서는 세션 파일이 원격 호스트에 저장되며, "로컬 Mac 파일 확인"은 게이트웨이에서 사용 중인 내용을 반영하지 않습니다.

---

## 두 개의 지속성 계층

OpenClaw는 다음 두 계층에 세션을 지속합니다:

1. **세션 저장소 (`sessions.json`)**
   - 키/값 맵: `sessionKey -> SessionEntry`
   - 작고 변경 가능하며 편집(또는 항목 삭제)에 안전
   - 세션 메타데이터(현재 세션 ID, 마지막 활동, 토글, 토큰 카운터 등) 추적

2. **전사 (`<sessionId>.jsonl`)**
   - 트리 구조의 첨부 전용 전사 (항목은 `id` + `parentId`를 가짐)
   - 실제 대화 + 도구 호출 + 압축 요약 저장
   - 향후 턴을 위해 모델 컨텍스트 재구축에 사용

---

## 디스크 상의 위치

에이전트별로 게이트웨이 호스트에 저장:

- 저장소: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- 전사: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram 주제 세션: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw는 `src/config/sessions.ts`를 통해 이를 해결합니다.

---

## 세션 키 (`sessionKey`)

`sessionKey`는 _어떤 대화 버킷_에 있는지를 식별합니다 (라우팅 + 격리).

일반적인 패턴:

- 메인/직접 채팅 (에이전트별): `agent:<agentId>:<mainKey>` (기본값 `main`)
- 그룹: `agent:<agentId>:<channel>:group:<id>`
- 방/채널 (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` 또는 `...:room:<id>`
- Cron: `cron:<job.id>`
- 웹훅: `hook:<uuid>` (재정의되지 않는 한)

기본 규칙은 [/concepts/session](/ko-KR/concepts/session)에 문서화되어 있습니다.

---

## 세션 IDs (`sessionId`)

각 `sessionKey`는 현재 대화를 계속하는 `sessionId` (전사 파일)를 가리킵니다.

기본 규칙:

- **재설정** (`/new`, `/reset`)은 해당 `sessionKey`에 새 `sessionId`를 만듭니다.
- **일일 재설정** (기본값 게이트웨이 호스트 현지 시간 4:00 AM)은 재설정 경계 이후 첫 메시지에서 새 `sessionId`를 만듭니다.
- **유휴 만료** (`session.reset.idleMinutes` 또는 레거시 `session.idleMinutes`)는 유휴 창 이후 메시지가 도착하면 새 `sessionId`를 만듭니다. 일일 + 유휴가 모두 설정된 경우 먼저 만료되는 것이 이깁니다.

구현 세부사항: 결정은 `src/auto-reply/reply/session.ts`의 `initSessionState()`에서 발생합니다.

---

## 세션 저장소 스키마 (`sessions.json`)

저장소의 값 유형은 `src/config/sessions.ts`의 `SessionEntry`입니다.

주요 필드 (포괄적이지 않음):

- `sessionId`: 현재 전사 ID (이것에서 파일명이 파생됨, `sessionFile`이 설정되지 않은 경우)
- `updatedAt`: 마지막 활동 타임스탬프
- `sessionFile`: 선택적 명시적 전사 경로 재정의
- `chatType`: `direct | group | room` (UI 및 전송 정책에 도움)
- `provider`, `subject`, `room`, `space`, `displayName`: 그룹/채널 레이블링 메타데이터
- 토글:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (세션별 재정의)
- 모델 선택:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- 토큰 카운터 (최선의 노력 / 프로바이더 종속):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: 이 세션 키에 대해 자동 압축이 완료된 횟수
- `memoryFlushAt`: 마지막 사전 압축 메모리 플러시 타임스탬프
- `memoryFlushCompactionCount`: 마지막 플러시가 실행된 시점의 압축 횟수

저장소는 수정이 안전하지만, 게이트웨이가 권한을 가집니다: 세션 실행 중에 항목을 다시 작성하거나 복구할 수 있습니다.

---

## 전사 구조 (`*.jsonl`)

전사는 `@mariozechner/pi-coding-agent`의 `SessionManager`에 의해 관리됩니다.

파일은 JSONL로 이루어져 있습니다:

- 첫 번째 줄: 세션 헤더 (`type: "session"`, `id`, `cwd`, `timestamp`, 선택적 `parentSession` 포함)
- 그 다음: `id` + `parentId`가 있는 세션 항목 (트리 구조)

주목할 만한 항목 유형:

- `message`: 사용자/조수/toolResult 메시지
- `custom_message`: 모델 컨텍스트에 _포함되는_ 확장 주입 메시지 (UI에서 숨겨질 수 있음)
- `custom`: 모델 컨텍스트에 _포함되지 않는_ 확장 상태
- `compaction`: `firstKeptEntryId` 및 `tokensBefore`를 포함한 지속된 압축 요약
- `branch_summary`: 트리 분기 탐색 시 지속된 요약

OpenClaw는 의도적으로 전사를 "수정하지 않습니다"; 게이트웨이는 `SessionManager`를 사용하여 이를 읽고 씁니다.

---

## 컨텍스트 윈도우 vs 추적된 토큰

두 가지 다른 개념이 중요합니다:

1. **모델 컨텍스트 윈도우**: 모델당 하드 캡 (모델에 보이는 토큰 수)
2. **세션 저장소 카운터**: `sessions.json`에 기록된 롤링 통계 (/status 및 대시보드에 사용)

제한을 조정하는 경우:

- 컨텍스트 윈도우는 모델 카탈로그에서 가져오며 (설정을 통해 재정의 가능).
- 저장소의 `contextTokens`는 런타임 추정/보고 값입니다. 엄격한 보증으로 간주하지 마세요.

자세한 내용은 [/token-use](/ko-KR/reference/token-use)를 참조하세요.

---

## 압축: 이것이 무엇인가

압축은 오래된 대화를 전사에 지속된 `compaction` 항목으로 요약하고 최근 메시지를 그대로 유지합니다.

압축 후, 향후 턴에서 보게 되는 것:

- 압축 요약
- `firstKeptEntryId` 이후 메시지

압축은 **지속적**입니다 (세션 가지치기와 다르게). [/concepts/session-pruning](/ko-KR/concepts/session-pruning)을 참조하세요.

---

## Pi 런타임에서 자동 압축 시점

내장된 Pi 에이전트에서, 자동 압축은 두 가지 경우에 트리거됩니다:

1. **오버플로우 복구**: 모델이 컨텍스트 오버플로우 오류를 반환하면 → 압축 → 재시도.
2. **임계값 유지**: 성공적인 턴 이후, 다음을 만족할 때:

`contextTokens > contextWindow - reserveTokens`

여기서:

- `contextWindow`는 모델의 컨텍스트 윈도우
- `reserveTokens`는 프롬프트 및 다음 모델 출력을 위해 예약된 여유 공간

이것들은 Pi 런타임 의미론(오픈클로우는 이벤트를 소모하지만, Pi는 언제 압축할지를 결정합니다).

---

## 압축 설정 (`reserveTokens`, `keepRecentTokens`)

Pi의 압축 설정은 Pi 설정에 포함됩니다:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw는 내장 실행에 대한 안전 바닥도 강제합니다:

- 만약 `compaction.reserveTokens < reserveTokensFloor`이면, OpenClaw가 이를 증가시킵니다.
- 기본 바닥은 `20000` 토큰입니다.
- `agents.defaults.compaction.reserveTokensFloor: 0`으로 설정하여 바닥을 비활성화할 수 있습니다.
- 이미 더 높은 상태라면, OpenClaw는 그대로 둡니다.

이유: 압축이 불가피해지기 전에 다중 턴 "하우스키핑" (예: 메모리 쓰기)을 위한 충분한 여유 공간을 남겨두기 위해.

구현: `src/agents/pi-settings.ts`의 `ensurePiCompactionReserveTokens()` ( `src/agents/pi-embedded-runner.ts`에서 호출).

---

## 사용자에게 보이는 표면

압축 및 세션 상태는 다음을 통해 관찰할 수 있습니다:

- `/status` (모든 채팅 세션에서)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- 자세한 모드: `🧹 Auto-compaction complete` + 압축 횟수

---

## 조용한 하우스키핑 (`NO_REPLY`)

OpenClaw는 중간 출력이 사용자에게 표시되지 않아야 하는 백그라운드 작업을 위한 "조용한" 턴을 지원합니다.

관례:

- 조수가 출력을 `NO_REPLY`로 시작하여 "사용자에게 회신을 전달하지 않는다"고 표시합니다.
- OpenClaw는 전달 계층에서 이를 제거/억제합니다.

`2026.1.10` 이후, OpenClaw는 **초안/타이핑 스트리밍**도 억제하며, 부분 청크가 `NO_REPLY`로 시작할 때, 조용한 작업이 턴 도중 부분 출력을 유출하지 않도록 합니다.

---

## 사전 압축 "메모리 플러시" (구현됨)

목표: 자동 압축이 발생하기 전에, 지속적인 상태를 디스크에 쓰는 조용한 에이전트 턴을 실행 (예: 에이전트 작업 영역의 `memory/YYYY-MM-DD.md`)하여 압축이 중요한 컨텍스트를 지울 수 없도록 합니다.

OpenClaw는 **사전 임계값 플러시** 접근 방식을 사용합니다:

1. 세션 컨텍스트 사용을 모니터링합니다.
2. Pi의 압축 임계값 아래의 "소프트 임계값"을 넘을 때, 에이전트에 조용한 "지금 메모리 쓰기" 지시를 실행합니다.
3. `NO_REPLY`를 사용하여 사용자가 아무것도 보지 않도록 합니다.

구성 (`agents.defaults.compaction.memoryFlush`):

- `enabled` (기본값: `true`)
- `softThresholdTokens` (기본값: `4000`)
- `prompt` (플러시 턴을 위한 사용자 메시지)
- `systemPrompt` (플러시 턴을 위해 추가되는 시스템 프롬프트)

노트:

- 기본 프롬프트/시스템 프롬프트에는 전송 억제를 위한 `NO_REPLY` 힌트가 포함되어 있습니다.
- 플러시는 압축 주기당 한 번 실행됩니다 (`sessions.json`에 추적).
- 플러시는 내장 Pi 세션에서만 작동 (CLI 백엔드는 건너뜁니다).
- 플러시는 세션 작업 영역이 읽기 전용일 때 건너뜁니다 (`workspaceAccess: "ro"` 또는 `"none"`).
- 작업 영역 파일 레이아웃 및 쓰기 패턴에 대한 자세한 내용은 [Memory](/ko-KR/concepts/memory)을 참조하세요.

Pi는 확장 API에서 `session_before_compact` 훅을 노출하지만, OpenClaw의 플러시 로직은 오늘날 게이트웨이 측에 존재합니다.

---

## 문제 해결 체크리스트

- 세션 키가 잘못되었나요? [/concepts/session](/ko-KR/concepts/session)를 시작하고 `/status`에서 `sessionKey`를 확인하세요.
- 저장소와 전사 불일치? `openclaw status`에서 게이트웨이 호스트와 저장소 경로를 확인하세요.
- 압축 스팸? 다음을 확인하세요:
  - 모델 컨텍스트 윈도우 (너무 작음)
  - 압축 설정 (`reserveTokens`가 모델 윈도우에 비해 너무 높으면 조기 압축을 유발할 수 있음)
  - 도구 결과 방해물: 세션 가지치기를 활성화/조정
- 조용한 턴 누출? 회신이 `NO_REPLY` (정확한 토큰)로 시작하고 스트리밍 억제 수정이 포함된 빌드에 있는지 확인하세요.