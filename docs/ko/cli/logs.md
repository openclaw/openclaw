---
read_when:
    - SSH 없이 원격으로 게이트웨이 로그를 추적해야 합니다.
    - 도구 사용을 위한 JSON 로그 줄이 필요합니다.
summary: '`openclaw logs`에 대한 CLI 참조(RPC를 통한 Tail 게이트웨이 로그)'
title: 로그
x-i18n:
    generated_at: "2026-02-08T15:50:55Z"
    model: gtx
    provider: google-translate
    source_hash: 911a57f0f3b78412c26312f7bf87a5a26418ab7b74e5e2eb40f16edefb6c6b8e
    source_path: cli/logs.md
    workflow: 15
---

# `openclaw logs`

RPC를 통한 Tail 게이트웨이 파일 로그(원격 모드에서 작동)

관련된:

- 로깅 개요: [벌채 반출](/logging)

## 예

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
