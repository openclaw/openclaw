---
summary: "CLI reference for `openclaw cron` (schedule and run background jobs)"
read_when:
  - You want scheduled jobs and wakeups
  - You’re debugging cron execution and logs
title: "cron"
x-i18n:
  source_hash: 09982d6dd1036a560886daaf8be568ac9dbe4fc296a5ca34e2737e16107659b1
---

# `openclaw cron`

게이트웨이 스케줄러에 대한 크론 작업을 관리합니다.

관련 항목:

- 크론 작업: [크론 작업](/automation/cron-jobs)

팁: 전체 명령 표면에 대해 `openclaw cron --help`를 실행하세요.

참고: 격리된 `cron add` 작업은 기본적으로 `--announce` 전달로 설정됩니다. 유지하려면 `--no-deliver`를 사용하세요.
내부 출력. `--deliver`는 `--announce`에 대해 더 이상 사용되지 않는 별칭으로 남아 있습니다.

참고: 일회성(`--at`) 작업은 기본적으로 성공 후 삭제됩니다. 보관하려면 `--keep-after-run`를 사용하세요.

참고: 이제 반복 작업은 연속 오류(30초 → 1분 → 5분 → 15분 → 60분) 후 지수 재시도 백오프를 사용하고, 다음 번 성공적인 실행 후 일반 일정으로 돌아갑니다.

## 일반적인 편집

메시지를 변경하지 않고 전송 설정을 업데이트합니다.

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

격리된 작업에 대한 전달을 비활성화합니다.

```bash
openclaw cron edit <job-id> --no-deliver
```

특정 채널에 공지:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
