---
summary: "`openclaw health` 에 대한 CLI 참조 (게이트웨이 건강 상태 엔드포인트를 RPC로 확인)"
read_when:
  - 실행 중인 게이트웨이의 건강 상태를 빠르게 확인하고 싶을 때
title: "건강 상태"
---

# `openclaw health`

실행 중인 게이트웨이의 건강 상태를 가져옵니다.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

주의사항:

- `--verbose` 옵션은 라이브 프로브를 실행하며 여러 계정이 구성된 경우 계정별 시간 정보를 출력합니다.
- 여러 에이전트가 구성된 경우, 출력에는 에이전트별 세션 저장소가 포함됩니다.
