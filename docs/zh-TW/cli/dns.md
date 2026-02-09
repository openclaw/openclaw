---
summary: "「openclaw dns」的 CLI 參考（廣域探索輔助工具）"
read_when:
  - 您需要透過 Tailscale + CoreDNS 進行廣域探索（DNS-SD）
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

DNS helpers for wide-area discovery (Tailscale + CoreDNS). 用於廣域探索的 DNS 輔助工具（Tailscale + CoreDNS）。目前著重於 macOS + Homebrew CoreDNS。

Related:

- Gateway 探索：[Discovery](/gateway/discovery)
- 廣域探索設定：[Configuration](/gateway/configuration)

## Setup

```bash
openclaw dns setup
openclaw dns setup --apply
```
