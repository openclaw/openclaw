---
summary: "로컬 상태/구성을 재설정하기 위한 `openclaw reset` CLI 참조"
read_when:
  - CLI 를 설치된 상태로 유지한 채 로컬 상태를 초기화하려는 경우
  - 제거될 항목을 미리 확인하기 위한 드라이 런을 원하는 경우
title: "재설정"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:25Z
---

# `openclaw reset`

로컬 구성/상태를 재설정합니다 (CLI 는 설치된 상태로 유지됩니다).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
