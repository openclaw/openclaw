---
read_when:
  - 需要远程查看 Gateway网关日志（无需 SSH）
  - 需要 JSON 格式的日志行以供工具使用
summary: 通过 RPC 查看 Gateway网关日志的 `openclaw logs` CLI 参考
title: logs
x-i18n:
  generated_at: "2026-02-01T20:21:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 911a57f0f3b78412c26312f7bf87a5a26418ab7b74e5e2eb40f16edefb6c6b8e
  source_path: cli/logs.md
  workflow: 14
---

# `openclaw logs`

通过 RPC 实时查看 Gateway网关文件日志（支持远程模式）。

相关内容：

- 日志概述：[日志](/logging)

## 示例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
