---
summary: "게이트웨이 스케줄러를 위한 크론 작업 + 웨이크업"
read_when:
  - 백그라운드 작업 또는 웨이크업을 스케줄링할 때
  - 하트비트와 함께 또는 하트비트와 나란히 실행되어야 하는 자동화를 연결할 때
  - 예약 작업에 대해 하트비트와 크론 중에서 결정할 때
title: "크론 작업"
---

# 크론 작업 (게이트웨이 스케줄러)

> **Cron vs Heartbeat?** 각 사용처에 대한 지침은 [Cron vs Heartbeat](/ko-KR/automation/cron-vs-heartbeat)을 참조하세요.

크론은 게이트웨이의 내장 스케줄러입니다. 작업을 유지하며, 에이전트를 적절한 시간에 깨우고, 출력물을 채팅으로 다시 전달할 수 있습니다.

"매일 아침 실행하기" 또는 "20분 후 에이전트 호출하기"와 같은 동작을 원할 경우, 크론이 사용됩니다.

문제 해결: [/automation/troubleshooting](/ko-KR/automation/troubleshooting)

## TL;DR

- 크론은 **게이트웨이 내부**에서 실행됩니다 (모델 내부에서 실행되지 않습니다).
- 작업은 `~/.openclaw/cron/`에 저장되어 재시작 시에도 일정이 사라지지 않습니다.
- 두 가지 실행 스타일:
  - **메인 세션**: 시스템 이벤트를 대기열에 넣고, 다음 하트비트에 실행됩니다.
  - **격리형**: `cron:<jobId>`에서 전용 에이전트 턴을 실행하며, 전달 옵션이 있으며 (기본값은 announce, 또는 전달 없음).
- 웨이크업은 1급 시민입니다: 작업은 "지금 깨우기" 또는 "다음 하트비트"를 요청할 수 있습니다.
- 웹훅 포스팅은 작업별로 `delivery.mode = "webhook"` + `delivery.to = "<url>"`을 통해 수행됩니다.
- `notify: true`가 설정된 저장된 작업은 여전히 `cron.webhook`이 설정된 경우 레거시 백업으로 남아 있으며, 웹훅 전달 모드로 마이그레이션이 필요합니다.

## 빠른 시작 (실행 가능)

즉시 확인하고 실행할 수 있는 일회성 알림 생성:

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

전달이 포함된 반복 격리 작업 스케줄링:

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

## 도구 호출 동등 항목 (게이트웨이 크론 도구)

표준 JSON 형태와 예제는 [도구 호출을 위한 JSON 스키마](/ko-KR/automation/cron-jobs#json-schema-for-tool-calls)를 참조하세요.

## 크론 작업의 저장 위치

크론 작업은 기본적으로 게이트웨이 호스트의 `~/.openclaw/cron/jobs.json`에 지속적으로 저장됩니다.
게이트웨이는 파일을 메모리에 로드하고 변경 시 다시 작성하므로, 수동으로 편집하는 것은 게이트웨이가 중지된 상태에서만 안전합니다. 변경 사항을 위해 `openclaw cron add/edit` 또는 크론 도구 호출 API를 사용하는 것이 좋습니다.

## 초보자 친화적 개요

크론 작업을 **언제** 실행할지 + **무엇을** 해야 할지로 생각하십시오.

1. **일정을 선택하십시오**
   - 일회성 알림 → `schedule.kind = "at"` (CLI: `--at`)
   - 반복 작업 → `schedule.kind = "every"` 또는 `schedule.kind = "cron"`
   - ISO 타임스탬프에 시간대가 없으면 **UTC**로 간주합니다.

2. **실행 위치를 선택하십시오**
   - `sessionTarget: "main"` → 주 컨텍스트에서 다음 하트비트 중 실행.
   - `sessionTarget: "isolated"` → `cron:<jobId>`에서 전용 에이전트 턴 실행.

3. **페이로드를 선택하십시오**
   - 메인 세션 → `payload.kind = "systemEvent"`
   - 격리 세션 → `payload.kind = "agentTurn"`

선택 사항: 일회성 작업 (`schedule.kind = "at"`)은 기본적으로 성공 후 삭제됩니다. 유지하려면 `deleteAfterRun: false`를 설정하십시오 (성공 후 비활성화됩니다).

## 개념

### 작업

크론 작업은 저장된 기록이며, 다음을 포함합니다:

- **일정** (언제 실행할지),
- **페이로드** (무엇을 수행할지),
- 선택적 **전달 모드** (`announce`, `webhook`, 또는 `none`).
- 선택적 **에이전트 바인딩** (`agentId`): 특정 에이전트로 작업 실행; 누락되거나 알 수 없는 경우 게이트웨이는 기본 에이전트를 사용합니다.

작업은 안정적인 `jobId`로 식별됩니다 (CLI/게이트웨이 API에서 사용됨).
에이전트 도구 호출에서는 `jobId`가 표준이며, 호환성을 위해 레거시 `id`도 허용됩니다.
일회성 작업은 기본적으로 성공 후 자동으로 삭제됩니다. 유지하려면 `deleteAfterRun: false`를 설정하십시오.

### 일정

크론은 세 가지 일정 종류를 지원합니다:

- `at`: `schedule.at` (ISO 8601)을 통한 일회성 타임스탬프.
- `every`: 고정 간격 (ms).
- `cron`: 선택적 IANA 시간대가 있는 5 필드 크론 표현식.

크론 표현식은 `croner`를 사용합니다. 시간대를 생략하면 게이트웨이 호스트의 로컬 시간대가 사용됩니다.

여러 게이트웨이에 걸쳐 시간대 상단 부하 스파이크를 줄이기 위해, OpenClaw는
반복되는 시간대 상단 표현식(예: `0 * * * *`, `0 */2 * * *`)에 대해 최대 5분의
결정론적 작업별 스태거 윈도우를 적용합니다. `0 7 * * *`와 같은 고정 시간 표현식은
정확하게 유지됩니다.

모든 크론 스케줄에 대해 `schedule.staggerMs`로 명시적 스태거 윈도우를 설정할 수 있습니다
(`0`은 정확한 타이밍 유지). CLI 단축키:

- `--stagger 30s` (또는 `1m`, `5m`)로 명시적 스태거 윈도우 설정.
- `--exact`로 `staggerMs = 0` 강제 설정.

### 메인 vs 격리 실행

#### 메인 세션 작업 (시스템 이벤트)

메인 작업은 시스템 이벤트를 대기열에 넣고 선택적으로 하트비트 실행기를 깨웁니다.
`payload.kind = "systemEvent"`를 사용해야 합니다.

- `wakeMode: "now"` (기본값): 이벤트가 즉시 하트비트를 실행합니다.
- `wakeMode: "next-heartbeat"`: 이벤트가 다음 예정된 하트비트를 기다립니다.

일반적인 하트비트 프롬프트 + 메인 세션 컨텍스트를 원하는 경우에 가장 적합합니다.
[하트비트](/ko-KR/gateway/heartbeat)를 참조하세요.

#### 격리 작업 (전용 크론 세션)

격리 작업은 `cron:<jobId>` 세션에서 전용 에이전트 턴을 실행합니다.

주요 동작:

- 추적 가능성을 위해 프롬프트가 `[cron:<jobId> <job name>]`으로 접두사 적용.
- 각 실행은 **새로운 세션 id**로 시작됩니다 (이전 대화는 이어지지 않음).
- 기본 동작: `delivery`가 생략되면 격리 작업은 요약을 알립니다 (`delivery.mode = "announce"`).
- `delivery.mode`는 발생할 일을 선택:
  - `announce`: 타겟 채널에 요약을 전달하고 메인 세션에 짧은 요약을 게시.
  - `webhook`: 요약이 포함된 완료 이벤트 페이로드를 `delivery.to`에 POST.
  - `none`: 내부 전용 (전달 없음, 메인 세션 요약 없음).
- `wakeMode`는 메인 세션 요약 게시 시간을 제어합니다:
  - `now`: 즉시 하트비트.
  - `next-heartbeat`: 다음 예정된 하트비트를 기다립니다.

주요 챗 기록을 스팸하지 않아야 하는 시끄럽고 빈번한 또는 "백그라운드 작업"에 격리 작업을 사용하세요.

### 페이로드 형태 (실행할 작업)

두 가지 페이로드 종류가 지원됩니다:

- `systemEvent`: 메인 세션 전용, 하트비트 프롬프트를 통해 라우팅.
- `agentTurn`: 격리 세션 전용, 전용 에이전트 턴 실행.

일반적인 `agentTurn` 필드:

- `message`: 필수 텍스트 프롬프트.
- `model` / `thinking`: 선택적 재정의 (아래 참조).
- `timeoutSeconds`: 선택적 타임아웃 재정의.

전달 구성:

- `delivery.mode`: `none` | `announce` | `webhook`.
- `delivery.channel`: `last` 또는 특정 채널.
- `delivery.to`: 채널별 타겟 (announce) 또는 웹훅 URL (webhook 모드).
- `delivery.bestEffort`: 발표 배달 실패 시 작업이 실패하지 않도록 방지.

announce 전달은 실행 시 메시징 도구 전송을 억제합니다; 채팅 대신 타겟팅하려면 `delivery.channel`/`delivery.to`를 사용하십시오. `delivery.mode = "none"`인 경우 메인 세션에는 요약이 게시되지 않습니다.

격리 작업의 경우 `delivery`가 생략되면 OpenClaw는 기본적으로 `announce`로 설정됩니다.

#### Announce 전달 흐름

`delivery.mode = "announce"`일 때, 크론은 아웃바운드 채널 어댑터를 통해 직접 전달합니다.
메인 에이전트는 메시지를 작성하거나 전달하기 위해 실행되지 않습니다.

동작 세부 사항:

- 내용: 전달은 격리 실행의 아웃바운드 페이로드 (텍스트/미디어)를 사용하여 일반적인 청크로 나누고 채널 서식을 적용하여 전달합니다.
- 하트비트 전용 응답 (`HEARTBEAT_OK`로 실제 내용이 없는 경우)은 전달되지 않습니다.
- 격리 실행이 메시지 도구를 통해 이미 동일한 타겟에 메시지를 보냈다면, 중복을 피하기 위해 전달이 건너뜁니다.
- 누락되었거나 잘못된 전달 타겟은 `delivery.bestEffort = true`이 아닌 경우 작업을 실패로 처리합니다.
- 메인 세션에 짧은 요약은 `delivery.mode = "announce"`일 때만 게시됩니다.
- 메인 세션 요약은 `wakeMode`를 따릅니다: `now`는 즉시 하트비트를 실행하고 `next-heartbeat`은 다음 예정된 하트비트를 기다립니다.

#### 웹훅 전달 흐름

`delivery.mode = "webhook"`일 때, 크론은 요약이 포함된 완료 이벤트 페이로드를 `delivery.to`에 POST합니다.

동작 세부 사항:

- 엔드포인트는 유효한 HTTP(S) URL이어야 합니다.
- 웹훅 모드에서는 채널 전달이 시도되지 않습니다.
- 웹훅 모드에서는 메인 세션 요약이 게시되지 않습니다.
- `cron.webhookToken`이 설정된 경우, 인증 헤더는 `Authorization: Bearer <cron.webhookToken>`입니다.
- 레거시 백업: `notify: true`가 설정된 저장된 작업은 여전히 `cron.webhook` (설정된 경우)에 게시되며, 경고 메시지와 함께 웹훅 전달 모드로 마이그레이션할 수 있습니다.

### 모델 및 사고 수준 재정의

격리 작업 (`agentTurn`)은 모델과 사고 수준을 재정의할 수 있습니다:

- `model`: 프로바이더/모델 문자열 (예: `anthropic/claude-sonnet-4-20250514`) 또는 별칭 (예: `opus`)
- `thinking`: 사고 수준 (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + 코덱스 모델에만 해당)

참고: 메인 세션 작업에 `model`을 설정할 수도 있지만, 이는 공유 메인 세션 모델을 변경합니다. 격리 작업에만 모델 재정의를 사용하는 것이 예기치 않은 컨텍스트 전환을 방지하는 데 권장됩니다.

우선순위 결정:

1. 작업 페이로드 재정의 (가장 높은 우선순위)
2. 훅별 기본값 (예: `hooks.gmail.model`)
3. 에이전트 구성 기본값

### 전달 (채널 + 타겟)

격리 작업은 상위 수준의 `delivery` 구성을 통해 채널에 출력을 전달할 수 있습니다:

- `delivery.mode`: `announce` (채널 전달), `webhook` (HTTP POST), 또는 `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (플러그인) / `signal` / `imessage` / `last`.
- `delivery.to`: 채널별 수신 대상.

`announce` 전달은 격리 작업 (`sessionTarget: "isolated"`)에만 유효합니다.
`webhook` 전달은 메인 및 격리 작업 모두에 유효합니다.

`delivery.channel` 또는 `delivery.to`가 생략되면, 크론은 메인 세션의 "마지막 경로" (마지막으로 에이전트가 답장한 장소)로 전환할 수 있습니다.

타겟 형식 주의사항:

- Slack/Discord/Mattermost (플러그인) 타겟은 모호성을 피하기 위해 명시적 접두사를 사용해야 합니다 (예: `channel:<id>`, `user:<id>`).
- Telegram 주제는 아래와 같은 `:topic:` 형식을 사용해야 합니다.

#### Telegram 전달 타겟 (주제 / 포럼 스레드)

Telegram은 `message_thread_id`를 통해 포럼 주제를 지원합니다. 크론 전달을 위해, 주제/스레드를 `to` 필드에 인코딩할 수 있습니다:

- `-1001234567890` (채팅 id만)
- `-1001234567890:topic:123` (권장: 명시적 주제 표시)
- `-1001234567890:123` (축약형: 숫자 접미사)

`telegram:...` / `telegram:group:...`과 같이 접두사 붙은 타겟도 허용됩니다:

- `telegram:group:-1001234567890:topic:123`

## 도구 호출을 위한 JSON 스키마

게이트웨이 `cron.*` 도구를 직접 호출할 때 이 형태를 사용하십시오 (에이전트 도구 호출 또는 RPC). CLI 플래그는 `20m` 같은 인간의 지속 시간을 수용하지만, 도구 호출은 `schedule.at`의 ISO 8601 문자열과 `schedule.everyMs`의 밀리초를 사용해야 합니다.

### cron.add 매개변수

일회성, 메인 세션 작업 (시스템 이벤트):

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

전달이 포함된 반복 격리 작업:

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

노트:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), 또는 `cron` (`expr`, 선택적 `tz`).
- `schedule.at`은 ISO 8601을 받아들입니다 (시간대 선택 사항; 생략 시 UTC로 간주됨).
- `everyMs`는 밀리초입니다.
- `sessionTarget`은 `"main"` 또는 `"isolated"`이어야 하며 `payload.kind`와 일치해야 합니다.
- 선택 필드: `agentId`, `description`, `enabled`, `deleteAfterRun` (`at`에 대해 기본값은 true),
  `delivery`.
- `wakeMode`는 생략 시 기본값이 `"now"`입니다.

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

노트:

- `jobId`는 표준입니다; 호환성을 위해 `id`도 허용됩니다.
- 에이전트 바인딩을 해제하기 위해 패치에 `agentId: null`을 사용하세요.

### cron.run 및 cron.remove 매개변수

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 저장소 및 히스토리

- 작업 저장소: `~/.openclaw/cron/jobs.json` (게이트웨이 관리 JSON).
- 실행 히스토리: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, 자동 정리).
- 저장소 경로 오버라이드: 구성의 `cron.store`.

## 구성

```json5
{
  cron: {
    enabled: true, // 기본값은 true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // 기본값은 1
    webhook: "https://example.invalid/legacy", // 저장된 notify:true 작업에 대한 사용 중단된 백업
    webhookToken: "replace-with-dedicated-webhook-token", // 웹훅 모드에 대한 선택적 베어러 토큰
  },
}
```

웹훅 동작:

- 권장 사항: 작업별로 `delivery.mode: "webhook"`을 설정하고 `delivery.to: "https://..."`을 설정하세요.
- 웹훅 URL은 유효한 `http://` 또는 `https://` URL이어야 합니다.
- 포스트 시, 페이로드는 크론 완료 이벤트 JSON입니다.
- `cron.webhookToken`이 설정된 경우, 인증 헤더는 `Authorization: Bearer <cron.webhookToken>`입니다.
- `cron.webhookToken`이 설정되지 않은 경우, 인증 헤더는 전송되지 않습니다.
- 사용 중단된 백업: `notify: true`가 설정된 저장된 레거시 작업은 여전히 `cron.webhook`을 사용합니다 (존재할 경우).

크론을 완전히 비활성화하기:

- `cron.enabled: false` (구성)
- `OPENCLAW_SKIP_CRON=1` (환경 변수)

## CLI 빠른 시작

일회성 알림 (UTC ISO, 성공 후 자동 삭제):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

일회성 알림 (메인 세션, 즉시 실행):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

반복 격리 작업 (WhatsApp에 알리기):

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

명시적 30초 스태거를 사용한 반복 크론 작업:

```bash
openclaw cron add \
  --name "Minute watcher" \
  --cron "0 * * * * *" \
  --tz "UTC" \
  --stagger 30s \
  --session isolated \
  --message "Run minute watcher checks." \
  --announce
```

반복 격리 작업 (Telegram 주제에 전달):

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

모델 및 사고 수준 재정의가 포함된 격리 작업:

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

에이전트 선택 (다중 에이전트 설정):

```bash
# 작업을 에이전트 "ops"에 고정 (해당 에이전트가 없으면 기본으로 대체)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# 기존 작업의 에이전트를 전환 또는 해제
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

수동 실행 (강제 실행이 기본값임, `--due`를 사용하여 필요할 때만 실행):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

기존 작업 편집 (필드 수정):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

기존 크론 작업을 정확한 스케줄로 실행하도록 강제 (스태거 없음):

```bash
openclaw cron edit <jobId> --exact
```

실행 히스토리:

```bash
openclaw cron runs --id <jobId> --limit 50
```

작업 생성 없이 즉시 시스템 이벤트:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## 게이트웨이 API 표면

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (강제 실행 또는 예정된 실행), `cron.runs`
  작업 없는 즉시 시스템 이벤트의 경우, [`openclaw system event`](/ko-KR/cli/system)를 사용하세요.

## 문제 해결

### "아무것도 실행되지 않음"

- 크론이 활성화되어 있는지 확인: `cron.enabled` 및 `OPENCLAW_SKIP_CRON`.
- 게이트웨이가 지속적으로 실행 중인지 확인 (크론은 게이트웨이 프로세스 내에서 실행됨).
- `cron` 일정의 경우: 시간대 (`--tz`)와 호스트 시간대 확인.

### 실패 후 반복 작업이 계속 지연됨

- OpenClaw는 연속적인 오류 발생 후 반복 작업에는 지수 백오프 재시도를 적용합니다: 30초, 1분, 5분, 15분, 이후에는 60분 간격으로 재시도.
- 백오프는 다음 성공적인 실행 후 자동으로 재설정됩니다.
- 일회성 (`at`) 작업은 최종 실행 (`ok`, `error`, 또는 `skipped`) 후 비활성화되며 재시도하지 않습니다.

### Telegram이 잘못된 곳으로 전달됨

- 포럼 주제의 경우, `-100…:topic:<id>` 형식으로 명확하고 명시적으로 설정하십시오.
- 로그 또는 저장된 "마지막 경로" 타겟에 `telegram:...` 접두사가 표시되는 것은 정상이며; 크론 전달은 이를 수용하고 여전히 주제 ID를 정확히 파싱합니다.

### 하위 에이전트 발표 전달 재시도

- 하위 에이전트 실행이 완료되면, 게이트웨이는 요청처 세션에 결과를 발표합니다.
- 발표 흐름이 `false`를 반환하는 경우 (예: 요청처 세션이 바쁨), 게이트웨이는 최대 3회까지 `announceRetryCount`를 통해 추적하여 재시도합니다.
- `endedAt` 이후 5분 이상 지난 발표는 무효화되어 무기한으로 오래된 항목이 반복되지 않도록 합니다.
- 로그에 반복적인 발표 전달이 보이는 경우, 하위 에이전트 레지스트리에서 높은 `announceRetryCount` 값을 가진 항목을 확인하십시오.
