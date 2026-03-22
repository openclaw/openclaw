---
summary: "`openclaw health` CLI 레퍼런스 (RPC를 통한 Gateway 상태 확인)"
read_when:
  - 실행 중인 Gateway의 상태를 빠르게 확인하고 싶을 때
title: "health"
x-i18n:
  source_path: "docs/cli/health.md"
---

# `openclaw health`

실행 중인 Gateway에서 상태 정보를 가져옵니다.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

참고:

- `--verbose`는 라이브 프로브를 실행하고 여러 계정이 설정된 경우 계정별 타이밍을 출력합니다.
- 여러 에이전트가 설정된 경우 에이전트별 세션 저장소가 출력에 포함됩니다.
