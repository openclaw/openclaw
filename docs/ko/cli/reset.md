---
summary: "로컬 상태/구성을 재설정하기 위한 `openclaw reset` CLI 참조"
read_when:
  - CLI 를 설치된 상태로 유지한 채 로컬 상태를 초기화하려는 경우
  - 제거될 항목의 드라이 런을 원함
title: "재설정"
---

# `openclaw reset`

로컬 구성/상태를 재설정합니다 (CLI 는 설치된 상태로 유지됩니다).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
