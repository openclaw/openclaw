---
summary: "`openclaw logs`에 대한 CLI 참조 (RPC를 통해 게이트웨이 로그 tail)"
read_when:
  - SSH 없이 원격으로 게이트웨이 로그를 tail해야 할 때
  - 도구를 위해 JSON 로그 라인이 필요한 경우
title: "logs"
---

# `openclaw logs`

RPC를 통해 게이트웨이 파일 로그를 tail (원격 모드에서 작동).

관련 항목:

- 로깅 개요: [Logging](/logging)

## 예제

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

`--local-time`을 사용하여 로컬 시간대의 타임스탬프를 렌더링합니다.
