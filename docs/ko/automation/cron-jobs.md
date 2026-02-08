---
read_when:
    - 백그라운드 작업 또는 웨이크업 예약
    - 하트비트와 함께 또는 심장박동과 함께 실행되어야 하는 배선 자동화
    - 예약된 작업에 대해 하트비트와 크론 중에서 결정
summary: 크론 작업 + 게이트웨이 스케줄러의 웨이크업
title: 크론 작업
x-i18n:
    generated_at: "2026-02-08T15:47:41Z"
    model: gtx
    provider: google-translate
    source_hash: d2f7bd6c542034b19e237d55994eefdfa1e80cc0e0b1a3c3b5cce65d4e69801f
    source_path: automation/cron-jobs.md
    workflow: 15
---

# 크론 작업(게이트웨이 스케줄러)

> **크론 대 하트비트?** 보다 [크론 대 하트비트](/automation/cron-vs-heartbeat) 각각을 언제 사용해야 하는지에 대한 지침을 확인하세요.

Cron은 게이트웨이에 내장된 스케줄러입니다. 작업을 유지하고 에이전트를 깨웁니다.
적시에 선택적으로 출력을 다시 채팅으로 전달할 수 있습니다.

원한다면 _“매일 아침 이걸 실행해”_ 또는 _“20분 안에 요원을 찌르세요”_,
cron은 메커니즘입니다.

문제 해결: [/자동화/문제해결](/automation/troubleshooting)

## TL;DR

- 크론 실행 **게이트웨이 내부** (모델 내부가 아님)
- 작업은 다음 기간 동안 지속됩니다. `~/.openclaw/cron/` 다시 시작해도 일정이 손실되지 않습니다.
- 두 가지 실행 스타일:
  - **메인 세션**: 시스템 이벤트를 대기열에 넣은 후 다음 하트비트에서 실행됩니다.
  - **외딴**: 전담 에이전트 턴인 실행 `cron:<jobId>`, 전달 포함(기본적으로 공지하거나 없음).
- Wakeup은 최고 수준입니다. 작업은 "지금 깨우기" 또는 "다음 하트비트"를 요청할 수 있습니다.

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

표준 JSON 셰이프 및 예는 다음을 참조하세요. [도구 호출을 위한 JSON 스키마](/automation/cron-jobs#json-schema-for-tool-calls).

## 크론 작업이 저장되는 위치

Cron 작업은 게이트웨이 호스트에서 지속됩니다. `~/.openclaw/cron/jobs.json` 기본적으로.
게이트웨이는 파일을 메모리에 로드하고 변경 사항이 있을 때 다시 기록하므로 수동으로 편집합니다.
게이트웨이가 중지된 경우에만 안전합니다. 선호하다 `openclaw cron add/edit` 아니면 크론
변경을 위한 도구 호출 API.

## 초보자 친화적인 개요

크론 작업을 다음과 같이 생각하십시오. **언제** 달리다 + **무엇** 할.

1. **일정을 선택하세요**
   - 일회성 알림 → `schedule.kind = "at"` (CLI: `--at`)
   - 반복 작업 → `schedule.kind = "every"` 또는 `schedule.kind = "cron"`
   - ISO 타임스탬프에 시간대가 누락된 경우 다음과 같이 처리됩니다. **UTC**.

2. **실행 위치를 선택하세요.**
   - `sessionTarget: "main"` → 기본 컨텍스트를 사용하여 다음 하트비트 동안 실행됩니다.
   - `sessionTarget: "isolated"` → 전담 에이전트 턴인 실행 `cron:<jobId>`.

3. **페이로드를 선택하세요**
   - 메인 세션 → `payload.kind = "systemEvent"`
   - 격리된 세션 → `payload.kind = "agentTurn"`

선택사항: 일회성 작업(`schedule.kind = "at"`) 기본적으로 성공 후 삭제됩니다. 세트
`deleteAfterRun: false` 유지합니다(성공 후에는 비활성화됩니다).

## 개념

### 채용정보

크론 작업은 다음과 같은 저장된 기록입니다.

- 에이 **일정** (실행해야 할 때),
- 에이 **유효 탑재량** (무엇을 해야 하는지),
- 선택 과목 **배달 모드** (발표 또는 없음).
- 선택 과목 **에이전트 바인딩** (`agentId`): 특정 에이전트에서 작업을 실행합니다. 만약에
  누락되었거나 알 수 없는 경우 게이트웨이는 기본 에이전트로 대체됩니다.

일자리는 마구간으로 식별됩니다. `jobId` (CLI/게이트웨이 API에서 사용됨)
에이전트 도구 통화에서는 `jobId` 정식입니다. 유산 `id` 호환성을 위해 허용됩니다.
일회성 작업은 기본적으로 성공 후 자동 삭제됩니다. 세트 `deleteAfterRun: false` 그들을 지키기 위해.

### 일정

Cron은 세 가지 일정 종류를 지원합니다.

- `at`: 원샷 타임스탬프 `schedule.at` (ISO 8601).
- `every`: 고정 간격(ms).
- `cron`: 선택적인 IANA 시간대가 포함된 5필드 cron 표현식입니다.

크론 표현식 사용 `croner`. 시간대가 생략되면 게이트웨이 호스트의
현지 시간대가 사용됩니다.

### 기본 실행과 격리된 실행

#### 기본 세션 작업(시스템 이벤트)

기본 작업은 시스템 이벤트를 대기열에 추가하고 선택적으로 하트비트 실행기를 깨웁니다.
그들은 사용해야 합니다 `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (기본값): 이벤트가 즉시 하트비트 실행을 트리거합니다.
- `wakeMode: "next-heartbeat"`: 이벤트는 다음 예정된 하트비트를 기다립니다.

이는 일반적인 하트비트 프롬프트 + 기본 세션 컨텍스트를 원할 때 가장 적합합니다.
보다 [하트비트](/gateway/heartbeat).

#### 격리된 작업(전용 크론 세션)

격리된 작업은 세션에서 전용 에이전트 차례를 실행합니다. `cron:<jobId>`.

주요 행동:

- 프롬프트 앞에는 `[cron:<jobId> <job name>]` 추적성을 위해.
- 각 실행은 **새로운 세션 ID** (이전 대화는 이어지지 않습니다).
- 기본 동작: if `delivery` 생략된 경우 격리된 작업은 요약(`delivery.mode = "announce"`).
- `delivery.mode` (격리된 경우에만) 무슨 일이 일어날지 선택합니다.
  - `announce`: 대상 채널에 요약을 전달하고 기본 세션에 간략한 요약을 게시합니다.
  - `none`: 내부 전용(전송 없음, 기본 세션 요약 없음)
- `wakeMode` 기본 세션 요약 게시 시기를 제어합니다.
  - `now`: 즉각적인 심장 박동.
  - `next-heartbeat`: 다음 예정된 하트비트를 기다립니다.

시끄럽고 자주 발생하는 "백그라운드 작업"에는 스팸으로 처리해서는 안 되는 격리된 작업을 사용하세요.
주요 채팅 기록.

### 페이로드 형태(실행되는 것)

두 가지 페이로드 종류가 지원됩니다.

- `systemEvent`: 메인 세션에만 해당되며 하트비트 프롬프트를 통해 라우팅됩니다.
- `agentTurn`: 격리 세션에만 해당되며 전용 에이전트 차례를 실행합니다.

흔한 `agentTurn` 전지:

- `message`: 필수 텍스트 프롬프트입니다.
- `model` / `thinking`: 선택적 재정의(아래 참조).
- `timeoutSeconds`: 선택적 시간 초과 재정의.

배달 구성(격리된 작업만 해당):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` 또는 특정 채널.
- `delivery.to`: 채널별 대상(전화/채팅/채널 ID)입니다.
- `delivery.bestEffort`: 공지 전달이 실패하는 경우 작업 실패를 방지합니다.

전달 알림은 메시징 도구 전송을 억제합니다. 사용 `delivery.channel` / `delivery.to`
대신 채팅을 타겟팅하세요. 언제 `delivery.mode = "none"`, 기본 세션에 요약이 게시되지 않습니다.

만약에 `delivery` 격리된 작업에서는 생략되며 OpenClaw의 기본값은 다음과 같습니다. `announce`.

#### 배송 흐름 공지

언제 `delivery.mode = "announce"`, cron은 아웃바운드 채널 어댑터를 통해 직접 전달합니다.
메시지를 작성하거나 전달하기 위해 기본 에이전트가 가동되지 않습니다.

행동 세부정보:

- 콘텐츠: 전달은 일반 청킹 및 격리된 실행의 아웃바운드 페이로드(텍스트/미디어)를 사용합니다.
  채널 포맷.
- 하트비트 전용 응답(`HEARTBEAT_OK` 실제 콘텐츠가 없는 경우)는 전달되지 않습니다.
- 격리된 실행이 이미 메시지 도구를 통해 동일한 대상으로 메시지를 보낸 경우 전달은
  중복을 피하기 위해 건너뛰었습니다.
- 누락되거나 유효하지 않은 전달 대상은 다음을 제외하고 작업에 실패합니다. `delivery.bestEffort = true`.
- 짧은 요약은 다음과 같은 경우에만 기본 세션에 게시됩니다. `delivery.mode = "announce"`.
- 메인 세션 요약은 다음을 존중합니다. `wakeMode`: `now` 즉각적인 심장 박동을 유발하고
  `next-heartbeat` 다음 예정된 하트비트를 기다립니다.

### 모델과 사고가 우선시됩니다.

고립된 작업(`agentTurn`)는 모델과 사고 수준을 무시할 수 있습니다.

- `model`: 제공업체/모델 문자열(예: `anthropic/claude-sonnet-4-20250514`) 또는 별칭(예: `opus`)
- `thinking`: 사고 수준 (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex 모델만 해당)

참고: 설정할 수 있습니다. `model` 기본 세션 작업에서도 마찬가지지만 공유 기본 작업이 변경됩니다.
세션 모델. 방지하려면 격리된 작업에 대해서만 모델 재정의를 권장합니다.
예상치 못한 상황 변화.

해결 우선순위:

1. 작업 페이로드 재정의(가장 높음)
2. 후크별 기본값(예: `hooks.gmail.model`)
3. 에이전트 구성 기본값

### 전달(채널 + 타겟)

격리된 작업은 최상위 수준을 통해 채널에 출력을 전달할 수 있습니다. `delivery` 구성:

- `delivery.mode`: `announce` (요약 전달) 또는 `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (플러그인) / `signal` / `imessage` / `last`.
- `delivery.to`: 채널별 수신자 대상입니다.

배달 구성은 격리된 작업(`sessionTarget: "isolated"`).

만약에 `delivery.channel` 또는 `delivery.to` 생략되면 cron은 기본 세션의 세션으로 돌아갈 수 있습니다.
'마지막 경로'(에이전트가 마지막으로 응답한 장소)

대상 형식 알림:

- Slack/Discord/Mattermost(플러그인) 대상은 명시적인 접두사를 사용해야 합니다(예: `channel:<id>`, `user:<id>`) 모호함을 피하기 위해.
- 텔레그램 주제는 `:topic:` 양식(아래 참조).

#### 텔레그램 전달 대상(주제/포럼 스레드)

Telegram은 다음을 통해 포럼 주제를 지원합니다. `message_thread_id`. cron 전달의 경우 인코딩할 수 있습니다.
주제/스레드를 `to` 필드:

- `-1001234567890` (채팅 ID만)
- `-1001234567890:topic:123` (선호: 명시적 주제 표시자)
- `-1001234567890:123` (약어: 숫자 접미사)

다음과 같은 접두사가 붙은 대상 `telegram:...` / `telegram:group:...` 다음 항목도 허용됩니다.

- `telegram:group:-1001234567890:topic:123`

## 도구 호출을 위한 JSON 스키마

게이트웨이를 호출할 때 이 모양을 사용하세요 `cron.*` 도구를 직접 사용합니다(에이전트 도구 호출 또는 RPC).
CLI 플래그는 다음과 같은 사람의 지속 시간을 허용합니다. `20m`, 그러나 도구 호출은 ISO 8601 문자열을 사용해야 합니다.
에 대한 `schedule.at` 밀리초 `schedule.everyMs`.

### cron.매개변수 추가

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

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), 또는 `cron` (`expr`, 선택사항 `tz`).
- `schedule.at` ISO 8601을 허용합니다(시간대 선택 사항, 생략 시 UTC로 처리됨).
- `everyMs` 밀리초입니다.
- `sessionTarget` 이어야 한다 `"main"` 또는 `"isolated"` 일치해야 하며 `payload.kind`.
- 선택 필드: `agentId`, `description`, `enabled`, `deleteAfterRun` (기본값은 true입니다. `at`), 
  `delivery`.
- `wakeMode` 기본값은 `"now"` 생략시.

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

- `jobId` 정식입니다. `id` 호환성을 위해 허용됩니다.
- 사용 `agentId: null` 에이전트 바인딩을 지우려면 패치에서.

### cron.run 및 cron.remove 매개변수

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 저장 및 기록

- 직업 상점: `~/.openclaw/cron/jobs.json` (게이트웨이 관리 JSON).
- 실행 기록: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, 자동 정리)
- 저장소 경로 재정의: `cron.store` 구성에서.

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

수동 실행(기본값은 강제입니다. `--due` 기한에만 실행):

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
  작업 없이 즉각적인 시스템 이벤트의 경우 다음을 사용합니다. [`openclaw system event`](/cli/system).

## 문제 해결

### “아무것도 실행되지 않습니다”

- 크론이 활성화되어 있는지 확인하세요. `cron.enabled` 그리고 `OPENCLAW_SKIP_CRON`.
- 게이트웨이가 지속적으로 실행되고 있는지 확인하십시오(cron은 게이트웨이 프로세스 내에서 실행됨).
- 을 위한 `cron` 일정: 시간대 확인(`--tz`) 대 호스트 시간대.

### 반복 작업이 실패 후 계속 지연됩니다.

- OpenClaw는 연속 오류 이후 반복 작업에 대해 지수 재시도 백오프를 적용합니다.
  재시도 간격은 30초, 1분, 5분, 15분, 그 후 60분입니다.
- 백오프는 다음 실행 성공 후 자동으로 재설정됩니다.
- 원샷(`at`) 터미널 실행 후 작업이 비활성화됩니다(`ok`, `error`, 또는 `skipped`) 재시도하지 마세요.

### 텔레그램이 엉뚱한 곳으로 배달을 시켜요

- 포럼 주제의 경우 다음을 사용하세요. `-100…:topic:<id>` 그래서 그것은 명백하고 모호하지 않습니다.
- 당신이 본다면 `telegram:...` 로그의 접두사 또는 저장된 "마지막 경로" 대상은 정상입니다.
  cron 전달은 이를 수락하고 여전히 주제 ID를 올바르게 구문 분석합니다.
