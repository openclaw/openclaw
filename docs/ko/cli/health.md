---
read_when:
    - 실행 중인 게이트웨이의 상태를 빠르게 확인하고 싶은 경우
summary: '`openclaw health`에 대한 CLI 참조(RPC를 통한 게이트웨이 상태 엔드포인트)'
title: 건강
x-i18n:
    generated_at: "2026-02-08T15:50:12Z"
    model: gtx
    provider: google-translate
    source_hash: 82a78a5a97123f7a5736699ae8d793592a736f336c5caced9eba06d14d973fd7
    source_path: cli/health.md
    workflow: 15
---

# `openclaw health`

실행 중인 게이트웨이에서 상태를 가져옵니다.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

참고:

- `--verbose` 여러 계정이 구성된 경우 라이브 프로브를 실행하고 계정별 타이밍을 인쇄합니다.
- 여러 에이전트가 구성된 경우 출력에는 에이전트별 세션 저장소가 포함됩니다.
