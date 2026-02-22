---
summary: "크론 및 하트비트 스케줄링 및 전송 문제 해결"
read_when:
  - 크론이 실행되지 않음
  - 크론이 실행되었지만 메시지가 전달되지 않음
  - 하트비트가 조용하거나 건너뛴 것 같음
title: "자동화 문제 해결"
---

# 자동화 문제 해결

이 페이지는 스케줄러 및 전송 문제 (`cron` + `heartbeat`)에 사용됩니다.

## 명령어 계층

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 자동화 검사를 실행합니다:

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

올바른 출력은 다음과 같습니다:

- `cron status`는 활성화되어 있으며 미래의 `nextWakeAtMs`가 표시됩니다.
- 작업이 활성화되어 있으며 유효한 스케줄/시간대를 가지고 있음.
- `cron runs`는 `ok` 또는 명시적인 건너뛰기 이유를 보여줌.

일반적인 시그니처:

- `cron: scheduler disabled; jobs will not run automatically` → 설정/환경에서 크론 비활성화됨.
- `cron: timer tick failed` → 스케줄러 틱 충돌됨; 주변 스택/로그 컨텍스트를 검사.
- 실행 출력에서 `reason: not-due` → `--force` 없이 수동 실행이 호출되었고, 작업이 아직 예정되지 않음.

## 크론이 실행되었지만 전송되지 않음

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

올바른 출력은 다음과 같습니다:

- 실행 상태는 `ok`입니다.
- 분리된 작업에 대해 전송 모드/대상이 설정되어 있음.
- 채널 프로브가 대상 채널이 연결됨을 보고함.

일반적인 시그니처:

- 실행은 성공했지만 전송 모드가 `none`임 → 외부 메시지가 예상되지 않음.
- 전송 대상 누락/잘못됨 (`channel`/`to`) → 실행은 내부에서 성공할 수 있지만 외부로 건너뜀.
- 채널 인증 오류 (`unauthorized`, `missing_scope`, `Forbidden`) → 채널 자격 증명/권한에 의해 전송 차단됨.

## 하트비트가 억제되거나 건너뛰어짐

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

올바른 출력은 다음과 같습니다:

- 하트비트가 0이 아닌 간격으로 활성화됨.
- 마지막 하트비트 결과는 `ran` (또는 건너뛰기 이유가 이해됨).

일반적인 시그니처:

- `heartbeat skipped` with `reason=quiet-hours` → `activeHours` 외부.
- `requests-in-flight` → 메인 레인을 사용하는 중; 하트비트 연기됨.
- `empty-heartbeat-file` → `HEARTBEAT.md`에 실행 가능한 내용이 없고 예약된 크론 이벤트가 없어 인터벌 하트비트가 건너뜀.
- `alerts-disabled` → 가시성 설정이 외부 하트비트 메시지를 억제함.

## 시간대 및 activeHours 주의사항

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

빠른 규칙:

- `Config path not found: agents.defaults.userTimezone`는 키가 설정되지 않았음을 의미; 하트비트는 호스트 시간대 (또는 설정된 경우 `activeHours.timezone`)로 돌아갑니다.
- `--tz` 없는 크론은 게이트웨이 호스트 시간대를 사용함.
- 하트비트 `activeHours`는 설정된 시간대 해상도 (`user`, `local`, 또는 명시적 IANA tz)를 사용함.
- 시간대 없는 ISO 타임스탬프는 크론 `at` 스케줄에 대해 UTC로 처리됨.

일반적인 시그니처:

- 호스트 시간대 변경 후 작업이 잘못된 시계 벽시간에 실행됨.
- `activeHours.timezone`이 잘못되어 낮 동안 하트비트가 항상 건너뛰어짐.

관련 문서:

- [/automation/cron-jobs](/ko-KR/automation/cron-jobs)
- [/gateway/heartbeat](/ko-KR/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/ko-KR/automation/cron-vs-heartbeat)
- [/concepts/timezone](/ko-KR/concepts/timezone)
