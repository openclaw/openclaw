---
x-i18n:
  source_path: "docs/cli/dns.md"
  workflow: 15
summary: "`openclaw dns`（広域ディスカバリーヘルパー）のCLIリファレンス"
read_when:
  - Tailscale + CoreDNSを使った広域ディスカバリー（DNS-SD）が必要な場合
  - カスタムディスカバリードメインのスプリットDNSを設定する場合（例：openclaw.internal）
title: "dns"
---

# `openclaw dns`

広域ディスカバリー（Tailscale + CoreDNS）のためのDNSヘルパーです。現在はmacOS + Homebrew CoreDNSに特化しています。

関連情報：

- ゲートウェイディスカバリー：[ディスカバリー](/gateway/discovery)
- 広域ディスカバリー設定：[設定](/gateway/configuration)

## セットアップ

```bash
openclaw dns setup
openclaw dns setup --apply
```
