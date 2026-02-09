---
summary: "CLI 참조: `openclaw logs` (RPC 를 통해 Gateway(게이트웨이) 로그를 테일링)"
read_when:
  - SSH 없이 원격으로 Gateway(게이트웨이) 로그를 테일링해야 할 때
  - 도구 연동을 위해 JSON 로그 라인이 필요할 때
title: "로그"
---

# `openclaw logs`

RPC 를 통해 Gateway(게이트웨이) 파일 로그를 테일링합니다 (원격 모드에서 작동).

관련 항목:

- 로깅 개요: [로깅](/logging)

## 예제

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
