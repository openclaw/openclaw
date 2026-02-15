---
summary: "CLI reference for `openclaw reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
x-i18n:
  source_hash: 08afed5830f892e07d6e2e167f09aaf2d79fd5b2ba2a26a65dca857ebdbf873c
---

# `openclaw reset`

로컬 구성/상태를 재설정합니다(CLI 설치 유지).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
