---
read_when:
  - 你需要通过 Tailscale + CoreDNS 实现广域发现（DNS-SD）
  - 你正在为自定义发现域名设置分离 DNS（例如：openclaw.internal）
summary: "`openclaw dns` 的 CLI 参考（广域发现辅助工具）"
title: dns
x-i18n:
  generated_at: "2026-02-01T19:58:53Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d2011e41982ffb4b71ab98211574529bc1c8b7769ab1838abddd593f42b12380
  source_path: cli/dns.md
  workflow: 14
---

# `openclaw dns`

用于广域发现的 DNS 辅助工具（Tailscale + CoreDNS）。目前专注于 macOS + Homebrew CoreDNS。

相关内容：

- Gateway网关发现：[发现](/gateway/discovery)
- 广域发现配置：[配置](/gateway/configuration)

## 设置

```bash
openclaw dns setup
openclaw dns setup --apply
```
