---
summary: "Cron jobs + wakeups for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring automation that should run with or alongside heartbeats
  - Deciding between heartbeat and cron for scheduled tasks
title: "Cron Jobs"
x-i18n:
  source_hash: d2f7bd6c542034b19e237d55994eefdfa1e80cc0e0b1a3c3b5cce65d4e69801f
---

# 크론 작업(게이트웨이 스케줄러)

> **Cron 대 하트비트?** 각각을 언제 사용해야 하는지에 대한 지침은 [Cron 대 Heartbeat](/automation/cron-vs-heartbeat)를 참조하세요.

Cron은 게이트웨이에 내장된 스케줄러입니다. 작업을 유지하고 에이전트를 깨웁니다.
적시에 선택적으로 출력을 다시 채팅으로 전달할 수 있습니다.

*“매일 아침에 실행”*하거나 *“20분 안에 에이전트 찌르기”*를 원한다면,
cron은 메커니즘입니다.

문제 해결: [/자동화/문제 해결](/automation/troubleshooting)

## 요약;DR

- Cron은 **게이트웨이 내부**(모델 내부가 아님)에서 실행됩니다.
- 작업은 `~/.openclaw/cron/`에서 지속되므로 다시 시작해도 일정이 손실되지 않습니다.
- 두 가지 실행 스타일:
  - **기본 세션**: 시스템 이벤트를 대기열에 넣은 후 다음 하트비트에서 실행됩니다.
  - **격리됨**: `cron:<jobId>`에서 전용 에이전트 턴을 실행하고 전달합니다(기본적으로 알림 또는 없음).
- 깨우기는 최고 수준입니다. 작업은 "지금 깨우기" 또는 "다음 하트비트"를 요청할 수 있습니다.

## 빠른 시작(실행 가능)

일회성 알림을 만들고 존재하는지 확인한 후 즉시 실행합니다.

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

배달을 통해 반복되는 격리 작업을 예약합니다.

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

## 도구 호출에 해당하는 항목(Gateway cron 도구)

표준 JSON 모양 및 예제는 [도구 호출을 위한 JSON 스키마](/automation/cron-jobs#json-schema-for-tool-calls)를 참조하세요.

## 크론 작업이 저장되는 위치

Cron 작업은 기본적으로 `~/.openclaw/cron/jobs.json`의 게이트웨이 호스트에 유지됩니다.
게이트웨이는 파일을 메모리에 로드하고 변경 사항이 있을 때 다시 기록하므로 수동으로 편집합니다.
게이트웨이가 중지된 경우에만 안전합니다. `openclaw cron add/edit` 또는 cron을 선호합니다.
변경을 위한 도구 호출 API.

## 초보자를 위한 개요

크론 작업을 **실행할 시기** + **무엇을** 수행할지 생각해 보세요.

1. **일정 선택**
   - 일회성 알림 → `schedule.kind = "at"` (CLI: `--at`)
   - 반복 작업 → `schedule.kind = "every"` 또는 `schedule.kind = "cron"`
   - ISO 타임스탬프에 시간대가 누락된 경우 **UTC**로 처리됩니다.

2. **실행 위치 선택**
   - `sessionTarget: "main"` → 기본 컨텍스트를 사용하여 다음 하트비트 동안 실행됩니다.
   - `sessionTarget: "isolated"` → `cron:<jobId>`에서 전담 에이전트 턴을 실행합니다.

3. **페이로드 선택**
   - 메인 세션 → `payload.kind = "systemEvent"`
   - 격리된 세션 → `payload.kind = "agentTurn"`

선택사항: 일회성 작업(`schedule.kind = "at"`)은 기본적으로 성공 후 삭제됩니다. 세트
`deleteAfterRun: false` 유지합니다(성공 후 비활성화됩니다).

## 개념

### 채용 정보

크론 작업은 다음과 같은 저장된 기록입니다.

- **일정**(실행해야 하는 시기),
- **페이로드**(무엇을 해야 하는지),
- 선택사항 **전달 모드**(알림 또는 없음).
- 선택적 **에이전트 바인딩** (`agentId`): 특정 에이전트에서 작업을 실행합니다. 만약에
  누락되었거나 알 수 없는 경우 게이트웨이는 기본 에이전트로 대체됩니다.

작업은 안정적인 `jobId`(CLI/Gateway API에서 사용)로 식별됩니다.
에이전트 도구 호출에서 `jobId`는 표준입니다. 레거시 `id`는 호환성을 위해 허용됩니다.
일회성 작업은 기본적으로 성공 후 자동 삭제됩니다. 유지하려면 `deleteAfterRun: false`를 설정하세요.

### 일정

Cron은 세 가지 일정 종류를 지원합니다.

- `at`: `schedule.at`를 통한 일회성 타임스탬프(ISO 8601).
- `every`: 고정 간격(ms)입니다.
- `cron`: 선택적인 IANA 시간대가 포함된 5필드 크론 표현식입니다.

Cron 표현식은 `croner`를 사용합니다. 시간대가 생략되면 게이트웨이 호스트의
현지 시간대가 사용됩니다.

### 기본 실행과 격리된 실행

#### 기본 세션 작업(시스템 이벤트)

기본 작업은 시스템 이벤트를 대기열에 추가하고 선택적으로 하트비트 실행기를 깨웁니다.
`payload.kind = "systemEvent"`를 사용해야 합니다.

- `wakeMode: "now"`(기본값): 이벤트가 즉시 하트비트 실행을 트리거합니다.
- `wakeMode: "next-heartbeat"`: 이벤트는 다음 예정된 하트비트를 기다립니다.

이는 일반적인 하트비트 프롬프트 + 기본 세션 컨텍스트를 원할 때 가장 적합합니다.
[하트비트](/gateway/heartbeat)를 참조하세요.

#### 격리된 작업(전용 크론 세션)

격리된 작업은 `cron:<jobId>` 세션에서 전용 에이전트 차례를 실행합니다.

주요 행동:

- 추적성을 위해 프롬프트 앞에 `[cron:<jobId> <job name>]`가 붙습니다.
- 각 실행은 **새로운 세션 ID**를 시작합니다(이전 대화가 이어지지 않음).
- 기본 동작: `delivery`가 생략되면 격리된 작업은 요약(`delivery.mode = "announce"`)을 알립니다.
- `delivery.mode` (격리 전용) 무슨 일이 일어날지 선택합니다:
  - `announce`: 대상 채널에 요약을 전달하고 기본 세션에 간략한 요약을 게시합니다.
  - `none`: 내부 전용(전달 없음, 기본 세션 요약 없음).
- `wakeMode`는 메인 세션 요약 게시 시기를 제어합니다.
  - `now`: 즉각적인 심장 박동.
  - `next-heartbeat`: 다음 예정된 하트비트를 기다립니다.

시끄럽고 자주 발생하는 "백그라운드 작업"에는 스팸으로 처리해서는 안 되는 격리된 작업을 사용하세요.
주요 채팅 기록.

### 페이로드 형태(실행되는 것)

두 가지 페이로드 종류가 지원됩니다.

- `systemEvent`: 메인 세션 전용, 하트비트 프롬프트를 통해 라우팅됩니다.
- `agentTurn`: 격리 세션 전용, 전용 에이전트 차례를 실행합니다.

공통 `agentTurn` 필드:

- `message`: 필수 텍스트 프롬프트입니다.
- `model` / `thinking`: 선택적 재정의(아래 참조).
- `timeoutSeconds`: 선택적 시간 초과 재정의.

배달 구성(격리된 작업만 해당):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` 또는 특정 채널.
- `delivery.to`: 채널별 대상(전화/채팅/채널 ID).
- `delivery.bestEffort`: 공지 전달이 실패할 경우 작업 실패를 방지합니다.

전달 알림은 메시징 도구 전송을 억제합니다. `delivery.channel`/`delivery.to` 사용
대신 채팅을 타겟팅하세요. `delivery.mode = "none"`일 때, 메인 세션에 요약이 게시되지 않습니다.

격리된 작업에 대해 `delivery`가 생략된 경우 OpenClaw의 기본값은 `announce`입니다.

#### 배송 흐름 공지

`delivery.mode = "announce"`인 경우 cron은 아웃바운드 채널 어댑터를 통해 직접 전달합니다.
메시지를 작성하거나 전달하기 위해 기본 에이전트가 가동되지 않습니다.

행동 세부정보:

- 콘텐츠: 전달은 일반 청킹 및 격리된 실행의 아웃바운드 페이로드(텍스트/미디어)를 사용합니다.
  채널 포맷.
- 하트비트 전용 응답(실제 내용이 없는 `HEARTBEAT_OK`)은 전달되지 않습니다.
- 격리된 실행이 이미 메시지 도구를 통해 동일한 대상으로 메시지를 보낸 경우 전달은
  중복을 피하기 위해 건너뛰었습니다.
- 누락되거나 유효하지 않은 전달 대상은 `delivery.bestEffort = true`이 아닌 이상 작업이 실패합니다.
- `delivery.mode = "announce"`일 때만 간략한 요약이 메인 세션에 게시됩니다.
- 기본 세션 요약은 `wakeMode`를 준수합니다. `now`는 즉각적인 하트비트를 트리거하고
  `next-heartbeat`는 다음 예정된 하트비트를 기다립니다.

### 모델과 사고가 우선시됩니다.

고립된 작업(`agentTurn`)은 모델과 사고 수준을 재정의할 수 있습니다.

- `model`: 공급자/모델 문자열(예: `anthropic/claude-sonnet-4-20250514`) 또는 별칭(예: `opus`)
- `thinking`: 사고 수준 (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex 모델에만 해당)

참고: 기본 세션 작업에서도 `model`를 설정할 수 있지만 공유 기본 작업이 변경됩니다.
세션 모델. 방지하려면 격리된 작업에 대해서만 모델 재정의를 권장합니다.
예상치 못한 상황 변화.

해결 우선순위:

1. 작업 페이로드 재정의(가장 높음)
2. 후크별 기본값(예: `hooks.gmail.model`)
3. 에이전트 구성 기본값

### 전달(채널 + 대상)

격리된 작업은 최상위 `delivery` 구성을 통해 채널에 출력을 전달할 수 있습니다.

- `delivery.mode`: `announce` (요약 전달) 또는 `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (플러그인) / `signal` / `imessage` / `last`.
- `delivery.to` : 채널별 수신 대상입니다.

전달 구성은 격리된 작업(`sessionTarget: "isolated"`)에만 유효합니다.

`delivery.channel` 또는 `delivery.to`가 생략되면 cron은 기본 세션의 세션으로 돌아갈 수 있습니다.
'마지막 경로'(에이전트가 마지막으로 응답한 장소)

대상 형식 알림:

- Slack/Discord/Mattermost(플러그인) 대상은 모호성을 피하기 위해 명시적인 접두사(예: `channel:<id>`, `user:<id>`)를 사용해야 합니다.
- 텔레그램 주제는 `:topic:` 형식을 사용해야 합니다(아래 참조).

#### 텔레그램 전달 대상(주제/포럼 스레드)

텔레그램은 `message_thread_id`를 통해 포럼 주제를 지원합니다. cron 전달의 경우 인코딩할 수 있습니다.
주제/스레드를 `to` 필드에 추가합니다.

- `-1001234567890` (채팅 ID만)
- `-1001234567890:topic:123` (선호: 명시적인 주제 마커)
- `-1001234567890:123` (약칭: 숫자 접미사)

`telegram:...` / `telegram:group:...`와 같은 접두사가 붙은 대상도 허용됩니다.

- `telegram:group:-1001234567890:topic:123`

## 도구 호출을 위한 JSON 스키마

게이트웨이 `cron.*` 도구를 직접 호출할 때(에이전트 도구 호출 또는 RPC) 이 모양을 사용하십시오.
CLI 플래그는 `20m`와 같은 휴먼 기간을 허용하지만 도구 호출은 ISO 8601 문자열을 사용해야 합니다.
`schedule.at`의 경우, `schedule.everyMs`의 경우 밀리초입니다.

### cron.추가 매개변수

일회성 기본 세션 작업(시스템 이벤트):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

배달이 포함된 반복적이고 격리된 작업:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

참고:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`) 또는 `cron` (`expr`, 선택 사항 `tz`).
- `schedule.at`는 ISO 8601을 허용합니다(시간대는 선택 사항이며 생략 시 UTC로 처리됨).
- `everyMs`는 밀리초입니다.
- `sessionTarget`는 `"main"` 또는 `"isolated"`여야 하며 `payload.kind`와 일치해야 합니다.
- 선택 필드: `agentId`, `description`, `enabled`, `deleteAfterRun` (`at`의 경우 기본값은 true),
  `delivery`.
- `wakeMode` 생략 시 기본값은 `"now"`입니다.

### cron.update 매개변수

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

참고:

- `jobId`는 표준입니다. `id`는 호환성을 위해 허용됩니다.
- 패치에서 `agentId: null`를 사용하여 에이전트 바인딩을 해제합니다.

### cron.run 및 cron.remove 매개변수

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 저장 및 기록

- 작업 저장소: `~/.openclaw/cron/jobs.json` (게이트웨이 관리형 JSON).
- 실행 기록: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, 자동 정리).
- 구성에서 저장소 경로 재정의: `cron.store`

## 구성

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

cron을 완전히 비활성화합니다.

- `cron.enabled: false` (구성)
- `OPENCLAW_SKIP_CRON=1` (환경)

## CLI 빠른 시작

일회성 알림(UTC ISO, 성공 후 자동 삭제):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

일회성 알림(기본 세션, 즉시 깨우기):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

반복되는 격리된 작업(WhatsApp에 알림):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

반복되는 격리 작업(Telegram 주제로 전달):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

모델과 사고가 무시되는 격리된 작업:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

에이전트 선택(다중 에이전트 설정):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

수동 실행(기본값은 강제입니다. 예정된 경우에만 실행하려면 `--due`을 사용하세요):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

기존 작업 편집(패치 필드):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

실행 기록:

```bash
openclaw cron runs --id <jobId> --limit 50
```

작업을 생성하지 않고 즉시 시스템 이벤트:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## 게이트웨이 API 표면

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (강제 또는 기한), `cron.runs`
  작업이 없는 즉각적인 시스템 이벤트의 경우 [`openclaw system event`](/cli/system)를 사용합니다.

## 문제 해결

### “아무것도 실행되지 않습니다”

- 크론이 활성화되어 있는지 확인하세요: `cron.enabled` 및 `OPENCLAW_SKIP_CRON`.
- 게이트웨이가 지속적으로 실행되고 있는지 확인합니다(크론은 게이트웨이 프로세스 내부에서 실행됩니다).
- `cron` 일정의 경우: 시간대(`--tz`)와 호스트 시간대를 확인합니다.

### 반복 작업이 실패 후 계속 지연됩니다.

- OpenClaw는 연속 오류 이후 반복 작업에 대해 지수 재시도 백오프를 적용합니다.
  재시도 간격은 30초, 1분, 5분, 15분, 그 후 60분입니다.
- 백오프는 다음 실행 성공 후 자동으로 재설정됩니다.
- 일회성(`at`) 작업은 터미널 실행(`ok`, `error` 또는 `skipped`) 후에 비활성화되고 재시도하지 않습니다.

### 텔레그램이 잘못된 곳으로 전달됩니다.

- 포럼 주제의 경우 `-100…:topic:<id>`를 사용하여 명확하고 모호하지 않게 작성하세요.
- 로그 또는 저장된 "마지막 경로" 대상에 `telegram:...` 접두사가 표시되는 경우 이는 정상입니다.
  cron 전달은 이를 수락하고 여전히 주제 ID를 올바르게 구문 분석합니다.
