---
summary: "백그라운드 작업을 예약하고 실행하기 위한 CLI 참조"
read_when:
  - 예약된 작업과 웨이크업을 원할 때
  - cron 실행을 디버깅하고 로그를 남길 때
title: "cron"
---

# `openclaw cron`

Gateway 스케줄러에 대한 cron 작업을 관리합니다.

관련 사항:

- Cron 작업: [Cron jobs](/automation/cron-jobs)

팁: 전체 명령 표면을 보려면 `openclaw cron --help` 를 실행합니다.

참고: 격리된 `cron add` 작업은 기본적으로 `--announce` 배달로 설정됩니다. 출력을 내부에 유지하려면 `--no-deliver` 를 사용합니다. `--deliver` 는 여전히 `--announce` 에 대한 지원되지 않는 별칭으로 유지됩니다.

참고: 일회성 (`--at`) 작업은 기본적으로 성공 후 삭제됩니다. 실행 후 유지하려면 `--keep-after-run` 을 사용합니다.

참고: 반복 작업은 이제 연속 오류 (30초 → 1분 → 5분 → 15분 → 60분) 후에 지수 재시도 백오프를 사용한 다음 다음 성공한 실행 후 정상 일정으로 돌아갑니다.

참고: 보존/정리는 구성에서 제어됩니다:

- `cron.sessionRetention` (기본값 `24h`) 는 완료된 격리된 실행 세션을 정리합니다.
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` 는 `~/.openclaw/cron/runs/<jobId>.jsonl` 을 정리합니다.

## 일반적인 편집

메시지를 변경하지 않고 배달 설정을 업데이트:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

격리된 작업의 배달을 비활성화합니다:

```bash
openclaw cron edit <job-id> --no-deliver
```

특정 채널로 발표:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/cron.md
workflow: 15
