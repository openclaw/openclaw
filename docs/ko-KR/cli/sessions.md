---
summary: "`openclaw sessions` CLI 레퍼런스 (저장된 세션 목록 + 사용량)"
read_when:
  - 저장된 세션을 나열하고 최근 활동을 확인하고 싶을 때
title: "sessions"
x-i18n:
  source_path: "docs/cli/sessions.md"
---

# `openclaw sessions`

저장된 대화 세션을 나열합니다.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --json
```

범위 선택:

- 기본값: 설정된 기본 에이전트 저장소
- `--agent <id>`: 하나의 설정된 에이전트 저장소
- `--all-agents`: 모든 설정된 에이전트 저장소 집계
- `--store <path>`: 명시적 저장소 경로 (`--agent`나 `--all-agents`와 결합 불가)

`openclaw sessions --all-agents`는 설정된 에이전트 저장소를 읽습니다. Gateway와 ACP 세션 검색은 더 넓습니다: 기본 `agents/` 루트 또는 템플릿화된 `session.store` 루트 하위에서 발견된 디스크 전용 저장소도 포함합니다. 이러한 발견된 저장소는 에이전트 루트 내부의 일반 `sessions.json` 파일로 해석되어야 합니다. 심볼릭 링크와 루트 외부 경로는 건너뜁니다.

JSON 예시:

`openclaw sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-6" }
  ]
}
```

## 정리 유지보수

다음 쓰기 사이클을 기다리지 않고 유지보수를 즉시 실행합니다:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup`은 설정의 `session.maintenance` 설정을 사용합니다:

- 범위 참고: `openclaw sessions cleanup`은 세션 저장소/트랜스크립트만 유지보수합니다. 크론 실행 로그 (`cron/runs/<jobId>.jsonl`)는 정리하지 않으며, 이는 [Cron configuration](/automation/cron-jobs#configuration)의 `cron.runLog.maxBytes`와 `cron.runLog.keepLines`에 의해 관리되며 [Cron maintenance](/automation/cron-jobs#maintenance)에서 설명합니다.

- `--dry-run`: 쓰기 없이 정리/제한될 항목 수를 미리 봅니다.
  - 텍스트 모드에서 드라이런은 유지 대 제거 대상을 확인할 수 있도록 세션별 작업 테이블 (`Action`, `Key`, `Age`, `Model`, `Flags`)을 출력합니다.
- `--enforce`: `session.maintenance.mode`가 `warn`이어도 유지보수를 적용합니다.
- `--active-key <key>`: 특정 활성 키를 디스크 예산 퇴거로부터 보호합니다.
- `--agent <id>`: 하나의 설정된 에이전트 저장소에 대해 정리를 실행합니다.
- `--all-agents`: 모든 설정된 에이전트 저장소에 대해 정리를 실행합니다.
- `--store <path>`: 특정 `sessions.json` 파일에 대해 실행합니다.
- `--json`: JSON 요약을 출력합니다. `--all-agents`와 함께 사용하면 저장소당 하나의 요약이 포함됩니다.

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

관련 문서:

- 세션 설정: [Configuration reference](/gateway/configuration-reference#session)
