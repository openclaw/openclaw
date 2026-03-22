---
summary: "`openclaw reset` CLI 레퍼런스 (로컬 상태/설정 초기화)"
read_when:
  - CLI를 유지하면서 로컬 상태를 초기화하고 싶을 때
  - 제거될 항목을 미리 확인하고 싶을 때
title: "reset"
x-i18n:
  source_path: "docs/cli/reset.md"
---

# `openclaw reset`

로컬 설정/상태를 초기화합니다 (CLI는 유지됩니다).

```bash
openclaw backup create
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```

로컬 상태를 제거하기 전에 복원 가능한 스냅샷을 원한다면 먼저 `openclaw backup create`를 실행하세요.
