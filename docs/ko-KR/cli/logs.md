---
summary: "RPC 를 통해 Gateway 로그를 테일하기 위한 CLI 참조"
read_when:
  - Gateway 로그를 원격으로 테일해야 할 때 (SSH 없음)
  - 도구를 위해 JSON 로그 라인을 원할 때
title: "logs"
---

# `openclaw logs`

RPC 를 통해 Gateway 파일 로그를 테일합니다 (원격 모드에서 작동).

관련 사항:

- 로깅 개요: [Logging](/logging)

## 예시

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

`--local-time` 를 사용하여 타임스탬프를 로컬 시간대로 렌더링합니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/logs.md
workflow: 15
