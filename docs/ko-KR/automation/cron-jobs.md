---
summary: "Gateway 스케줄러용 Cron 작업 + 웨이크업"
read_when:
  - "배경 작업 또는 웨이크업 예약"
  - "하트비트와 함께 실행되어야 하는 자동화 와이어링"
  - "예약된 작업에 대해 하트비트와 cron 중 어느 것을 사용할지 결정"
title: "Cron 작업"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/automation/cron-jobs.md
  workflow: 15
---

# Cron 작업 (Gateway 스케줄러)

> **Cron과 하트비트?** [Cron 대 하트비트](/automation/cron-vs-heartbeat)를 참조하여 각각을 언제 사용할지 알아봅니다.

Cron은 Gateway의 내장 스케줄러입니다. 작업을 지속하고, 올바른 시간에 에이전트를 웨이크업하며, 선택적으로 출력을 채팅으로 전달할 수 있습니다.

"매일 아침 이것을 실행"하거나 "20분 후 에이전트를 건드리고 싶다면"은 cron의 메커니즘입니다.

문제 해결: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron은 **Gateway 내부에서 실행**됩니다 (모델 내부 아님).
- 작업은 `~/.openclaw/cron/` 아래에 지속되므로 재시작이 일정을 잃지 않습니다.
- 두 가지 실행 스타일:
  - **메인 세션**: 시스템 이벤트를 큐에 넣은 다음 다음 하트비트에서 실행합니다.
  - **격리**: `cron:<jobId>`에서 전용 에이전트 터를 실행하며, 기본적으로 공지하거나 없음.
- 웨이크업은 우선 클래스입니다: 작업은 "지금 웨이크" 대 "다음 하트비트"를 요청할 수 있습니다.
- Webhook 게시는 `delivery.mode = "webhook"` + `delivery.to = "<url"`인 작업별입니다.
- Legacy 폴백은 `cron.webhook`이 설정될 때 `notify: true`가 있는 저장된 작업에 대해 유지되며, 해당 작업을 webhook 배달 모드로 마이그레이션합니다.

## 빠른 시작 (실행 가능)

일회성 알림을 만들고, 존재하는지 확인하며, 즉시 실행합니다:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: cron 문서 초안 확인" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

배달이 있는 반복 격리 작업 일정:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## 도구 호출 동등물 (Gateway cron 도구)

표준 JSON 형태 및 예제의 경우 [도구 호출용 JSON 스키마](/automation/cron-jobs#json-schema-for-tool-calls)를 참조하세요.

## Cron 작업이 저장되는 위치

Cron 작업은 Gateway 호스트의 `~/.openclaw/cron/jobs.json`에 지속됩니다 (기본값).
Gateway는 파일을 메모리에 로드하고 변경 시 기록하므로 수동 편집은 Gateway가 중지될 때만 안전합니다. `openclaw cron add/edit` 또는 cron 도구 호출 API를 변경에 선호합니다.

## 초보자 친화 개요

cron 작업을 생각해봅니다: **언제** 실행 + **무엇** 수행.

1. **일정 선택**
   - 일회성 알림 → `schedule.kind = "at"` (CLI: `--at`)
   - 반복 작업 → `schedule.kind = "every"` 또는 `schedule.kind = "cron"`
   - ISO 타임스탬프가 시간대를 생략하면 **UTC**로 처리됩니다.

2. **실행 위치 선택**
   - `sessionTarget: "main"` → 다음 하트비트 중 메인 컨텍스트와 함께 실행.
   - `sessionTarget: "isolated"` → `cron:<jobId>`에서 전용 에이전트 터를 실행.

3. **페이로드 선택**
   - 메인 세션 → `payload.kind = "systemEvent"`
   - 격리 세션 → `payload.kind = "agentTurn"`

선택: 일회성 작업 (`schedule.kind = "at"`)은 기본적으로 성공 후 삭제됩니다. `deleteAfterRun: false`를 설정하여 유지합니다 (성공 후 비활성화됨).

## 구성

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
    // 선택: 일회성 작업에 대한 재시도 정책 재정의
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 120000, 300000],
      retryOn: ["rate_limit", "network", "server_error"],
    },
    webhook: "https://example.invalid/legacy", // 저장된 notify:true 작업에 대한 deprecated 폴백
    webhookToken: "replace-with-dedicated-webhook-token", // webhook 모드에 대한 선택적 bearer 토큰
    sessionRetention: "24h", // 기간 문자열 또는 false
    runLog: {
      maxBytes: "2mb", // default 2_000_000 bytes
      keepLines: 2000, // default 2000
    },
  },
}
```

실행 로그 가지치기 동작:

- `cron.runLog.maxBytes`: 가지치기 전 실행 로그 파일 최대 크기.
- `cron.runLog.keepLines`: 가지치기할 때 최신 N개 라인만 유지.
- 둘 다 `cron/runs/<jobId>.jsonl` 파일에 적용됩니다.

Webhook 동작:

- 선호: `delivery.mode: "webhook"` 및 `delivery.to: "https://..."`를 작업별로 설정.
- Webhook URL은 유효한 `http://` 또는 `https://` URL이어야 합니다.
- 게시될 때 페이로드는 cron finished 이벤트 JSON입니다.
- `cron.webhookToken`이 설정되면 auth 헤더는 `Authorization: Bearer <cron.webhookToken>`입니다.
- `cron.webhookToken`이 설정되지 않으면 `Authorization` 헤더를 전송하지 않습니다.
- 저장된 legacy 작업이 `notify: true`면 `cron.webhook`이 있을 때 여전히 사용합니다.

cron을 완전히 비활성화합니다:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## 유지 보수

Cron은 두 가지 기본 제공 유지 보수 경로를 가집니다: 격리 실행 세션 보유 및 실행 로그 가지치기.

### 기본값

- `cron.sessionRetention`: `24h` (실행 세션 가지치기를 비활성화하려면 `false` 설정)
- `cron.runLog.maxBytes`: `2_000_000` 바이트
- `cron.runLog.keepLines`: `2000`

### 어떻게 작동하는가

- 격리 실행은 세션 항목 (`...:cron:<jobId>:run:<uuid>`) 및 성적증명서 파일을 생성합니다.
- 리퍼는 `cron.sessionRetention`보다 오래된 만료된 실행 세션 항목을 제거합니다.
- 제거된 실행 세션에 대해 더 이상 세션 저장소에서 참조되지 않으면 OpenClaw는 성적증명서 파일을 보관하고 같은 보유 기간에 오래된 삭제된 보관을 제거합니다.
- 각 실행 추가 후 `cron/runs/<jobId>.jsonl`은 크기 확인됩니다:
  - 파일 크기가 `runLog.maxBytes`를 초과하면 최신 `runLog.keepLines` 라인으로 트림합니다.

### 높은 볼륨 스케줄러에 대한 성능 주의

높은 빈도 cron 설정은 큰 실행 세션 및 실행 로그 발자국을 생성할 수 있습니다. 유지 보수는 기본 제공되지만 느슨한 한계는 여전히 회피 가능한 IO 및 정리 작업을 생성할 수 있습니다.

무엇을 살펴봅니다:

- 많은 격리 실행이 있는 긴 `cron.sessionRetention` 윈도우
- 큰 `runLog.maxBytes`와 결합된 높은 `cron.runLog.keepLines`
- 같은 `cron/runs/<jobId>.jsonl`에 쓰는 많은 시끄러운 반복 작업

무엇을 합니다:

- `cron.sessionRetention`을 디버깅/감시 요구 사항이 허용하는 한 짧게 유지
- 중간 `runLog.maxBytes` 및 `runLog.keepLines`로 실행 로그를 바인딩된 상태로 유지
- 격리 모드로 시끄러운 배경 작업을 이동하고 불필요한 수다를 피하는 배달 규칙 포함
- 로그가 커지기 전에 보유 기간을 조정하고 `openclaw cron runs`로 증가를 주기적으로 검토

## CLI 빠른 시작

일회성 알림 (UTC ISO, 성공 후 자동 삭제):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: 경비 보고서를 제출하세요." \
  --wake now \
  --delete-after-run
```

일회성 알림 (메인 세션, 즉시 웨이크):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "다음 하트비트: 달력을 확인하세요." \
  --wake now
```

반복 격리 작업 (WhatsApp으로 공지):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "오늘을 위해 받은편지함 + 달력을 요약하세요." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

반복 cron 작업 (명시적 30초 스태거):

```bash
openclaw cron add \
  --name "Minute watcher" \
  --cron "0 * * * * *" \
  --tz "UTC" \
  --stagger 30s \
  --session isolated \
  --message "분 보기 검사를 실행하세요." \
  --announce
```

## Gateway API 표면

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force 또는 due), `cron.runs`
  작업 없이 즉시 시스템 이벤트의 경우 [`openclaw system event`](/cli/system)를 사용합니다.

## 문제 해결

### "아무것도 실행되지 않음"

- cron이 활성화되었는지 확인: `cron.enabled` 및 `OPENCLAW_SKIP_CRON`.
- Gateway가 계속 실행 중인지 확인 (cron은 Gateway 프로세스 내부에서 실행).
- `cron` 일정: 시간대 (`--tz`) vs 호스트 시간대를 확인합니다.

### 반복 작업이 장애 후 계속 지연됨

- OpenClaw는 연속 오류 후 반복 작업에 지수 재시도 백오프를 적용합니다:
  30초, 1분, 5분, 15분, 그 다음 재시도 전 60분.
- 백오프는 다음 성공적인 실행 후 자동 리셋됩니다.
- 일회성 (`at`) 작업은 일시적 오류 (속도 제한, 네트워크, server_error)를 최대 3번 재시도합니다; 영구 오류는 즉시 비활성화됩니다. [재시도 정책](/automation/cron-jobs#retry-policy) 참조.

### Telegram이 잘못된 위치로 배달

- 포럼 주제의 경우 `-100…:topic:<id>`를 사용하므로 명시적이고 명확합니다.
- 로그나 저장된 "마지막 경로" 대상에서 `telegram:...` 접두사를 보면 정상입니다.
  cron 배달은 해당 접두사를 수락하고 여전히 주제 ID를 올바르게 구문 분석합니다.

### 서브에이전트 공지 배달 재시도

- 서브에이전트 실행이 완료되면 Gateway는 결과를 요청자 세션에 공지합니다.
- 공지 흐름이 `false`를 반환하면 (예: 요청자 세션이 바쁨), Gateway는 `announceRetryCount`를 통해 추적하여 최대 3번 재시도합니다.
- `endedAt`을 지나 5분보다 오래된 공지는 부실 항목이 무한히 루프되는 것을 방지하기 위해 강제 만료됩니다.
- 로그에서 반복되는 공지 배달을 보면 높은 `announceRetryCount` 값을 가진 항목의 서브에이전트 레지스트리를 확인합니다.
