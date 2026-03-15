---
read_when:
  - 你想通过 Tailscale + CoreDNS 实现广域设备发现（DNS-SD）
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
summary: "`openclaw dns` 的 CLI 参考（广域设备发现辅助工具）"
title: dns
x-i18n:
  generated_at: "2026-02-03T07:44:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d2011e41982ffb4b71ab98211574529bc1c8b7769ab1838abddd593f42b12380
  source_path: cli/dns.md
  workflow: 15
---

# `openclaw dns`

用于广域设备发现（Tailscale + CoreDNS）的 DNS 辅助工具。目前专注于 macOS + Homebrew CoreDNS。

相关内容：

- Gateway 网关设备发现：[设备发现](/gateway/discovery)
- 广域设备发现配置：[配置](/gateway/configuration)

## 设置

```bash
openclaw dns setup
openclaw dns setup --apply
```
