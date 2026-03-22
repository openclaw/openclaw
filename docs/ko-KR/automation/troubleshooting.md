---
summary: "cron 및 하트비트 스케줄링과 전달 문제 해결"
read_when:
  - cron 이 실행되지 않을 때
  - cron 이 실행되었지만 메시지가 전달되지 않을 때
  - 하트비트가 조용하거나 건너뛴 것처럼 보일 때
title: "자동화 문제 해결"
x-i18n:
  source_path: docs/automation/troubleshooting.md
---

# 자동화 문제 해결

스케줄러 및 전달 문제 (`cron` + `heartbeat`) 를 위해 이 페이지를 사용하세요.

## 명령 순서

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 자동화 확인을 실행합니다:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## cron 이 발동하지 않음

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

정상 출력:

- `cron status`가 활성화되어 있고 향후 `nextWakeAtMs`를 보고합니다.
- 작업이 활성화되어 있고 유효한 스케줄/시간대를 가지고 있습니다.
- `cron runs`가 `ok` 또는 명시적 건너뛰기 이유를 표시합니다.

일반적인 시그니처:

- `cron: scheduler disabled; jobs will not run automatically` → 설정/환경에서 cron 비활성화됨.
- `cron: timer tick failed` → 스케줄러 틱이 충돌함; 주변 스택/로그 컨텍스트를 검사하세요.
- 실행 출력에서 `reason: not-due` → `--force` 없이 수동 실행이 호출되었고 작업이 아직 예정되지 않음.

## cron 이 발동했지만 전달 없음

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

정상 출력:

- 실행 상태가 `ok`.
- 격리된 작업에 전달 모드/대상이 설정됨.
- 채널 프로브가 대상 채널 연결을 보고함.

일반적인 시그니처:

- 실행은 성공했지만 전달 모드가 `none` → 외부 메시지가 예상되지 않음.
- 전달 대상 누락/유효하지 않음 (`channel`/`to`) → 실행이 내부적으로 성공할 수 있지만 아웃바운드를 건너뜀.
- 채널 인증 오류 (`unauthorized`, `missing_scope`, `Forbidden`) → 채널 자격 증명/권한에 의해 전달이 차단됨.

## 하트비트 억제 또는 건너뜀

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

정상 출력:

- 하트비트가 0 이 아닌 간격으로 활성화됨.
- 마지막 하트비트 결과가 `ran` (또는 건너뛰기 이유가 이해됨).

일반적인 시그니처:

- `reason=quiet-hours`와 함께 `heartbeat skipped` → `activeHours` 외부.
- `requests-in-flight` → 메인 레인 사용 중; 하트비트 지연됨.
- `empty-heartbeat-file` → `HEARTBEAT.md`에 실행 가능한 콘텐츠가 없고 태그된 cron 이벤트가 대기열에 없어서 간격 하트비트가 건너뜀.
- `alerts-disabled` → 가시성 설정이 아웃바운드 하트비트 메시지를 억제함.

## 시간대 및 activeHours 주의 사항

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

빠른 규칙:

- `Config path not found: agents.defaults.userTimezone`은 키가 설정되지 않았음을 의미합니다; 하트비트는 호스트 시간대 (또는 설정된 경우 `activeHours.timezone`) 로 폴백합니다.
- `--tz` 없는 cron 은 Gateway 호스트 시간대를 사용합니다.
- 하트비트 `activeHours`는 구성된 시간대 해결 (`user`, `local`, 또는 명시적 IANA tz) 을 사용합니다.
- 시간대 없는 ISO 타임스탬프는 cron `at` 스케줄에서 UTC 로 처리됩니다.

일반적인 시그니처:

- 호스트 시간대 변경 후 작업이 잘못된 벽시계 시간에 실행됨.
- `activeHours.timezone`이 잘못되어 낮 시간 동안 하트비트가 항상 건너뜀.

관련:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
