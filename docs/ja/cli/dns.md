---
summary: "「openclaw dns」の CLI リファレンス（広域ディスカバリー向けヘルパー）"
read_when:
  - Tailscale + CoreDNS による広域ディスカバリー（DNS-SD）を利用したい場合
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

ワイドエリアディスカバリ(Tailscale + CoreDNS)のためのDNSヘルパー。 広域ディスカバリー向けの DNS ヘルパー（Tailscale + CoreDNS）です。現在は macOS + Homebrew CoreDNS に重点を置いています。

関連項目:

- Gateway ディスカバリー: [Discovery](/gateway/discovery)
- 広域ディスカバリーの設定: [Configuration](/gateway/configuration)

## セットアップ

```bash
openclaw dns setup
openclaw dns setup --apply
```
