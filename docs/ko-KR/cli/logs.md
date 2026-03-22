---
summary: "`openclaw logs` CLI 레퍼런스 (RPC를 통한 Gateway 로그 테일링)"
read_when:
  - SSH 없이 원격으로 Gateway 로그를 테일링해야 할 때
  - 도구 연동을 위한 JSON 로그 라인이 필요할 때
title: "logs"
x-i18n:
  source_path: "docs/cli/logs.md"
---

# `openclaw logs`

RPC를 통해 Gateway 파일 로그를 테일링합니다 (리모트 모드에서 동작).

관련 문서:

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

`--local-time`을 사용하면 타임스탬프를 로컬 시간대로 렌더링합니다.
