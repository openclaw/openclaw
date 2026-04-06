---
read_when:
    - Tailscale + CoreDNSによる広域ディスカバリー（DNS-SD）を使用したい
    - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
summary: '`openclaw dns`（広域ディスカバリーヘルパー）のCLIリファレンス'
title: dns
x-i18n:
    generated_at: "2026-04-02T07:33:22Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d2011e41982ffb4b71ab98211574529bc1c8b7769ab1838abddd593f42b12380
    source_path: cli/dns.md
    workflow: 15
---

# `openclaw dns`

広域ディスカバリー（Tailscale + CoreDNS）のためのDNSヘルパーです。現在はmacOS + Homebrew CoreDNSに焦点を当てています。

関連:

- Gateway ゲートウェイのディスカバリー: [ディスカバリー](/gateway/discovery)
- 広域ディスカバリー設定: [設定](/gateway/configuration)

## セットアップ

```bash
openclaw dns setup
openclaw dns setup --apply
```
