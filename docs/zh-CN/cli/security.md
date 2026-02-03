---
read_when:
  - 想要对配置/状态进行快速安全审计
  - 想要应用安全的"修复"建议（chmod、收紧默认值）
summary: 审计和修复常见安全隐患的 `openclaw security` CLI 参考
title: security
x-i18n:
  generated_at: "2026-02-01T20:21:24Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 19705b0fff848fa6f302b4ed09b7660c64e09048dba517c7f6a833d2db40bebf
  source_path: cli/security.md
  workflow: 14
---

# `openclaw security`

安全工具（审计 + 可选修复）。

相关内容：

- 安全指南：[安全](/gateway/security)

## 审计

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

当多个私信发送者共享主会话时，审计会发出警告，并建议共享收件箱使用 `session.dmScope="per-channel-peer"`（多账户渠道则使用 `per-account-channel-peer`）。
审计还会在小模型（`<=300B`）未启用沙箱且启用了 web/browser 工具时发出警告。
