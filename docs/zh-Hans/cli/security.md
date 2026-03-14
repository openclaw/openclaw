---
read_when:
  - 你想对配置/状态运行快速安全审计
  - 你想应用安全的"修复"建议（chmod、收紧默认值）
summary: "`openclaw security` 的 CLI 参考（审计和修复常见安全隐患）"
title: security
x-i18n:
  generated_at: "2026-02-03T07:45:13Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 19705b0fff848fa6f302b4ed09b7660c64e09048dba517c7f6a833d2db40bebf
  source_path: cli/security.md
  workflow: 15
---

# `openclaw security`

安全工具（审计 + 可选修复）。

相关：

- 安全指南：[安全](/gateway/security)

## 审计

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

当多个私信发送者共享主会话时，审计会发出警告，并建议对共享收件箱使用 `session.dmScope="per-channel-peer"`（或多账户渠道使用 `per-account-channel-peer`）。
当使用小模型（`<=300B`）且未启用沙箱隔离但启用了 web/browser 工具时，它也会发出警告。
