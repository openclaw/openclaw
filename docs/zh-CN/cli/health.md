---
read_when:
  - 你想快速检查运行中的 Gateway 网关健康状态
summary: "`openclaw health` 的 CLI 参考（通过 RPC 获取 Gateway 网关健康端点）"
title: health
x-i18n:
  generated_at: "2026-02-03T07:44:55Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 82a78a5a97123f7a5736699ae8d793592a736f336c5caced9eba06d14d973fd7
  source_path: cli/health.md
  workflow: 15
---

# `openclaw health`

从运行中的 Gateway 网关获取健康状态。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注意：

- `--verbose` 运行实时探测，并在配置了多个账户时打印每个账户的耗时。
- 当配置了多个智能体时，输出包括每个智能体的会话存储。
