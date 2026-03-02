---
summary: "RPC 를 통한 Gateway 건강 끝점을 위한 CLI 참조"
read_when:
  - 실행 중인 Gateway 의 건강을 빠르게 확인하려고 할 때
title: "health"
---

# `openclaw health`

실행 중인 Gateway 에서 건강을 가져옵니다.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

참고:

- `--verbose` 는 라이브 프로브를 실행하고 여러 계정이 구성된 경우 계정별 타이밍을 인쇄합니다.
- 출력은 여러 에이전트가 구성된 경우 에이전트별 세션 저장소를 포함합니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/health.md
workflow: 15
