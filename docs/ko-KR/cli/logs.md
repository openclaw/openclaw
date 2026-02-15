---
summary: "CLI reference for `openclaw logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
x-i18n:
  source_hash: 81be02b6f8acad32ccf2d280827c7188a3c2f6bba0de5cbfa39fcc0bee3129cd
---

# `openclaw logs`

RPC를 통한 Tail 게이트웨이 파일 로그(원격 모드에서 작동)

관련 항목:

- 로깅 개요: [로깅](/logging)

## 예

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

현지 시간대로 타임스탬프를 렌더링하려면 `--local-time`를 사용하세요.
