---
read_when:
  - 你想快速检查正在运行的 Gateway网关的健康状态
summary: "`openclaw health` 的 CLI 参考（通过 RPC 访问 Gateway网关健康端点）"
title: health
x-i18n:
  generated_at: "2026-02-01T19:58:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 82a78a5a97123f7a5736699ae8d793592a736f336c5caced9eba06d14d973fd7
  source_path: cli/health.md
  workflow: 14
---

# `openclaw health`

从正在运行的 Gateway网关获取健康状态。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

说明：

- `--verbose` 会运行实时探测，并在配置了多个账号时打印每个账号的耗时。
- 配置了多个智能体时，输出中会包含每个智能体的会话存储信息。
