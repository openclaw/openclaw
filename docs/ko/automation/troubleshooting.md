---
read_when:
    - 크론이 실행되지 않았습니다
    - Cron이 실행되었지만 메시지가 전달되지 않았습니다.
    - 심장 박동이 조용하거나 건너뛰는 것 같습니다.
summary: cron 및 하트비트 예약 및 전달 문제 해결
title: 자동화 문제 해결
x-i18n:
    generated_at: "2026-02-08T15:46:14Z"
    model: gtx
    provider: google-translate
    source_hash: 10eca4a59119910f73ea831bfe86de8a97908bce36fcdaecd19fdd539d68e30d
    source_path: automation/troubleshooting.md
    workflow: 15
---

# 자동화 문제 해결

스케줄러 및 배달 문제에 대해서는 이 페이지를 사용하십시오(`cron` + `heartbeat`).

## 명령 사다리

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 자동화 검사를 실행합니다.

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## 크론이 실행되지 않음

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

좋은 출력은 다음과 같습니다.

- `cron status` 보고서 활성화 및 미래 `nextWakeAtMs`.
- 작업이 활성화되었으며 유효한 일정/시간대가 있습니다.
- `cron runs` 쇼 `ok` 또는 명시적인 건너뛰기 이유.

일반적인 서명:

- `cron: scheduler disabled; jobs will not run automatically` → config/env에서 cron이 비활성화되었습니다.
- `cron: timer tick failed` → 스케줄러 틱이 충돌했습니다. 주변 스택/로그 컨텍스트를 검사합니다.
- `reason: not-due` 실행 출력 → 수동 실행 없이 호출됨 `--force` 아직 작업 기한이 안 됐어요.

## 크론이 실행되었지만 전달되지 않음

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

좋은 출력은 다음과 같습니다.

- 실행 상태는 `ok`.
- 격리된 작업에 대해 전달 모드/대상이 설정됩니다.
- 채널 프로브는 연결된 대상 채널을 보고합니다.

일반적인 서명:

- 실행에 성공했지만 전달 모드는 다음과 같습니다. `none` → 외부 메시지가 예상되지 않습니다.
- 게재 대상이 누락되었거나 잘못되었습니다(`channel`/`to`) → 실행이 내부적으로 성공할 수 있지만 아웃바운드는 건너뛸 수 있습니다.
- 채널 인증 오류(`unauthorized`, `missing_scope`, `Forbidden`) → 채널 자격 증명/권한에 의해 전달이 차단됩니다.

## 하트비트가 억제되거나 건너뛰었습니다.

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

좋은 출력은 다음과 같습니다.

- 0이 아닌 간격으로 하트비트가 활성화되었습니다.
- 마지막 하트비트 결과는 다음과 같습니다. `ran` (또는 건너뛰기 이유가 이해됨)

일반적인 서명:

- `heartbeat skipped` ~와 함께 `reason=quiet-hours` → 외부 `activeHours`.
- `requests-in-flight` → 메인 레인이 붐비고 있습니다. 심장박동이 연기되었습니다.
- `empty-heartbeat-file` → `HEARTBEAT.md` 존재하지만 실행 가능한 콘텐츠가 없습니다.
- `alerts-disabled` → 가시성 설정은 아웃바운드 하트비트 메시지를 억제합니다.

## 시간대 및 activeHours 문제

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

빠른 규칙:

- `Config path not found: agents.defaults.userTimezone` 키가 설정되지 않았음을 의미합니다. 하트비트는 호스트 시간대로 돌아갑니다(또는 `activeHours.timezone` 설정된 경우).
- 크론 없음 `--tz` 게이트웨이 호스트 시간대를 사용합니다.
- 하트비트 `activeHours` 구성된 시간대 해상도를 사용합니다(`user`, `local`또는 명시적인 IANA tz).
- 시간대가 없는 ISO 타임스탬프는 cron의 UTC로 처리됩니다. `at` 일정.

일반적인 서명:

- 호스트 시간대가 변경된 후 작업이 잘못된 벽시계 시간에 실행됩니다.
- 낮에는 심장 박동이 항상 건너뛰었습니다. `activeHours.timezone` 틀렸다.

관련된:

- [/자동화/크론-작업](/automation/cron-jobs)
- [/게이트웨이/하트비트](/gateway/heartbeat)
- [/자동화/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/개념/시간대](/concepts/timezone)
