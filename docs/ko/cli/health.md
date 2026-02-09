---
summary: "RPC 를 통해 실행 중인 Gateway(게이트웨이) 의 상태를 확인하는 `openclaw health` CLI 참조"
read_when:
  - 실행 중인 Gateway(게이트웨이) 의 상태를 빠르게 확인하려는 경우
title: "health"
---

# `openclaw health`

실행 중인 게이트웨이에서 상태를 가져옵니다.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

참고 사항:

- `--verbose` 는 라이브 프로브를 실행하며, 여러 계정이 구성된 경우 계정별 타이밍을 출력합니다.
- 출력에는 여러 에이전트가 구성된 경우 에이전트별 세션 스토어가 포함됩니다.
