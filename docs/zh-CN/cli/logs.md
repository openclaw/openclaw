---
read_when:
  - 你需要远程跟踪 Gateway 网关日志（无需 SSH）
  - 你需要 JSON 日志行用于工具处理
summary: "`openclaw logs` 的 CLI 参考（通过 RPC 跟踪 Gateway 网关日志）"
title: logs
x-i18n:
  generated_at: "2026-02-03T07:44:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 911a57f0f3b78412c26312f7bf87a5a26418ab7b74e5e2eb40f16edefb6c6b8e
  source_path: cli/logs.md
  workflow: 15
---

# `openclaw logs`

通过 RPC 跟踪 Gateway 网关文件日志（在远程模式下可用）。

相关内容：

- 日志概述：[日志](/logging)

## 示例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
