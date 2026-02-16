---
read_when:
  - 你想在保留 CLI 安装的同时清除本地状态
  - 你想预览哪些内容会被移除
summary: "`openclaw reset`（重置本地状态/配置）的 CLI 参考"
title: reset
x-i18n:
  generated_at: "2026-02-01T20:21:22Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 08afed5830f892e07d6e2e167f09aaf2d79fd5b2ba2a26a65dca857ebdbf873c
  source_path: cli/reset.md
  workflow: 14
---

# `openclaw reset`

重置本地配置/状态（保留 CLI 安装）。

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
