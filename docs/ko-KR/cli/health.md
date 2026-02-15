---
summary: "CLI reference for `openclaw health` (gateway health endpoint via RPC)"
read_when:
  - You want to quickly check the running Gateway’s health
title: "health"
x-i18n:
  source_hash: 82a78a5a97123f7a5736699ae8d793592a736f336c5caced9eba06d14d973fd7
---

# `openclaw health`

실행 중인 게이트웨이에서 상태를 가져옵니다.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

참고:

- `--verbose`는 라이브 프로브를 실행하고 여러 계정이 구성된 경우 계정별 타이밍을 인쇄합니다.
- 여러 에이전트가 구성된 경우 출력에는 에이전트별 세션 저장소가 포함됩니다.
