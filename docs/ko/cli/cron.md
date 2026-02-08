---
read_when:
    - 예약된 작업과 깨우기를 원합니다.
    - 크론 실행 및 로그를 디버깅하고 있습니다.
summary: '`openclaw cron`에 대한 CLI 참조(백그라운드 작업 예약 및 실행)'
title: 크론
x-i18n:
    generated_at: "2026-02-08T15:50:09Z"
    model: gtx
    provider: google-translate
    source_hash: 09982d6dd1036a560886daaf8be568ac9dbe4fc296a5ca34e2737e16107659b1
    source_path: cli/cron.md
    workflow: 15
---

# `openclaw cron`

게이트웨이 스케줄러에 대한 크론 작업을 관리합니다.

관련된:

- 크론 작업: [크론 작업](/automation/cron-jobs)

팁: 달리다 `openclaw cron --help` 전체 명령 표면의 경우.

참고: 격리됨 `cron add` 작업의 기본값은 `--announce` 배달. 사용 `--no-deliver` 유지하다
내부 출력. `--deliver` 더 이상 사용되지 않는 별칭으로 남아 있습니다. `--announce`.

참고: 원샷(`--at`) 작업은 기본적으로 성공 후 삭제됩니다. 사용 `--keep-after-run` 그들을 지키기 위해.

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
