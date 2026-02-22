---
summary: "`openclaw cron` CLI 참조 (백그라운드 작업을 일정에 맞게 실행)"
read_when:
  - 예약된 작업과 웨이크업이 필요한 경우
  - 크론 실행 및 로그 디버깅 중인 경우
title: "cron"
---

# `openclaw cron`

게이트웨이 스케줄러를 위한 크론 작업 관리.

관련 항목:

- Cron jobs: [Cron jobs](/ko-KR/automation/cron-jobs)

Tip: 전체 명령어 표면을 확인하려면 `openclaw cron --help`를 실행하세요.

Note: 단독 `cron add` 작업은 기본적으로 `--announce` 전달을 사용합니다. 출력을 내부에 유지하려면 `--no-deliver`를 사용하세요. `--deliver`는 `--announce`의 더 이상 사용되지 않는 별칭으로 남아 있습니다.

Note: 일회성 (`--at`) 작업은 기본적으로 성공 후 삭제됩니다. 유지하려면 `--keep-after-run`을 사용하세요.

Note: 반복 작업은 이제 연속적인 오류 후 지수 백오프를 사용하여 재시도합니다(30초 → 1분 → 5분 → 15분 → 60분). 다음 성공적인 실행 후 정상 일정으로 돌아갑니다.

## Common edits

메시지를 변경하지 않고 전달 설정을 업데이트:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

단독 작업에 대한 전달 비활성화:

```bash
openclaw cron edit <job-id> --no-deliver
```

특정 채널에 발표:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```