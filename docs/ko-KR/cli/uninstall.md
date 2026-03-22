---
summary: "`openclaw uninstall` CLI 레퍼런스 (Gateway 서비스 + 로컬 데이터 제거)"
read_when:
  - Gateway 서비스 및/또는 로컬 상태를 제거하고 싶을 때
  - 먼저 드라이런을 실행하고 싶을 때
title: "uninstall"
x-i18n:
  source_path: "docs/cli/uninstall.md"
---

# `openclaw uninstall`

Gateway 서비스 + 로컬 데이터를 제거합니다 (CLI는 유지됩니다).

```bash
openclaw backup create
openclaw uninstall
openclaw uninstall --all --yes
openclaw uninstall --dry-run
```

상태나 워크스페이스를 제거하기 전에 복원 가능한 스냅샷을 원한다면 먼저 `openclaw backup create`를 실행하세요.
