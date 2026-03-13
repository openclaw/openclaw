---
summary: CLI reference for `openclaw dns` (wide-area discovery helpers)
read_when:
  - You want wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: dns
---

# `openclaw dns`

DNS 幫助工具用於廣域發現（Tailscale + CoreDNS）。目前專注於 macOS + Homebrew CoreDNS。

[[BLOCK_1]]

- 閘道發現: [Discovery](/gateway/discovery)
- 廣域發現設定: [Configuration](/gateway/configuration)

## Setup

```bash
openclaw dns setup
openclaw dns setup --apply
```
