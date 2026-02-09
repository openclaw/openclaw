---
summary: "`openclaw cron` 에 대한 CLI 참조 (백그라운드 작업을 예약하고 실행)"
read_when:
  - 예약된 작업과 깨우기(wakeups)가 필요함
  - cron 실행 및 로그를 디버깅할 때
title: "cron"
---

# `openclaw cron`

Gateway(게이트웨이) 스케줄러의 cron 작업을 관리합니다.

관련 항목:

- Cron 작업: [Cron jobs](/automation/cron-jobs)

팁: 전체 명령 범위를 확인하려면 `openclaw cron --help` 를 실행하십시오.

참고: 격리된 `cron add` 작업은 기본적으로 `--announce` 전송을 사용합니다. 출력 내용을 내부로 유지하려면 `--no-deliver` 를 사용하십시오. `--deliver` 는 `--announce` 의 사용 중단된 별칭으로 남아 있습니다.

참고: 단발성 (`--at`) 작업은 기본적으로 성공 후 삭제됩니다. 유지하려면 `--keep-after-run` 를 사용하십시오.

참고: 반복 작업은 이제 연속 오류 발생 시 지수적 재시도 백오프 (30초 → 1분 → 5분 → 15분 → 60분)를 사용하며, 다음 성공 실행 이후 정상 스케줄로 복귀합니다.

## 일반적인 수정

메시지를 변경하지 않고 전송 설정을 업데이트합니다:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

격리된 작업의 전송을 비활성화합니다:

```bash
openclaw cron edit <job-id> --no-deliver
```

특정 채널로 공지합니다:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
