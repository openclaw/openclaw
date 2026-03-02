---
summary: "Cron 및 하트비트 예약 및 배달 문제 해결"
read_when:
  - "Cron이 실행되지 않았을 때"
  - "Cron이 실행했지만 메시지가 배달되지 않았을 때"
  - "하트비트가 조용해 보이거나 건너뛸 때"
title: "자동화 문제 해결"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/automation/troubleshooting.md
  workflow: 15
---

# 자동화 문제 해결

스케줄러 및 배달 문제에 이 페이지를 사용합니다 (`cron` + `heartbeat`).

## 명령 사다리

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그 다음 자동화 검사를 실행합니다:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron이 발동되지 않음

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

좋은 출력은 다음과 같습니다:

- `cron status`는 활성화되었고 미래 `nextWakeAtMs`를 보고합니다.
- 작업이 활성화되어 있고 유효한 일정/시간대를 가집니다.
- `cron runs`는 `ok` 또는 명시적 건너뛰기 이유를 표시합니다.

일반적인 서명:

- `cron: scheduler disabled; jobs will not run automatically` → cron이 config/env에서 비활성화.
- `cron: timer tick failed` → 스케줄러 틱이 충돌; 주변 스택/로그 컨텍스트를 검사합니다.
- run 출력에서 `reason: not-due` → 수동 실행이 `--force` 없이 호출되었고 작업이 아직 만료되지 않았습니다.

## Cron이 발동했지만 배달 없음

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

좋은 출력은 다음과 같습니다:

- 실행 상태는 `ok`입니다.
- 배달 모드/대상은 격리 작업에 설정됩니다.
- 채널 프로브는 대상 채널이 연결되어 있다고 보고합니다.

일반적인 서명:

- 실행이 성공했지만 배달 모드는 `none` → 외부 메시지를 예상하지 않습니다.
- 배달 대상 누락/잘못됨 (`channel`/`to`) → 실행이 내부적으로 성공하지만 아웃바운드를 건너뜁니다.
- 채널 auth 오류 (`unauthorized`, `missing_scope`, `Forbidden`) → 채널 자격증명/권한으로 배달이 차단됩니다.

## 하트비트가 억제되었거나 건너뛸 때

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

좋은 출력은 다음과 같습니다:

- 하트비트는 0이 아닌 간격으로 활성화됩니다.
- 마지막 하트비트 결과는 `ran`입니다 (또는 건너뛰기 이유는 이해됨).

일반적인 서명:

- `reason=quiet-hours`로 `heartbeat skipped` → `activeHours` 외부.
- `requests-in-flight` → 메인 레인이 바쁨; 하트비트가 지연됨.
- `empty-heartbeat-file` → 간격 하트비트가 건너뛰어짐 (HEARTBEAT.md가 실행 가능한 콘텐츠가 없고 태그된 cron 이벤트가 큐에 없음).
- `alerts-disabled` → 가시성 설정이 아웃바운드 하트비트 메시지를 억제합니다.

## 시간대 및 activeHours 함정

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

빠른 규칙:

- `Config path not found: agents.defaults.userTimezone`은 키가 설정되지 않았음을 의미합니다. 하트비트는 호스트 시간대로 폴백합니다 (또는 `activeHours.timezone`이 설정되면).
- `--tz` 없는 Cron은 Gateway 호스트 시간대를 사용합니다.
- 하트비트 `activeHours`는 구성된 시간대 해석을 사용합니다 (`user`, `local`, 또는 명시적 IANA tz).
- 호스트 시간대 변경 후 작업은 잘못된 벽시계 시간에 실행됩니다.

관련:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
