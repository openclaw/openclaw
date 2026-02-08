---
summary: "「openclaw dns」の CLI リファレンス（広域ディスカバリー向けヘルパー）"
read_when:
  - Tailscale + CoreDNS による広域ディスカバリー（DNS-SD）を利用したい場合
  - カスタムのディスカバリードメイン（例: openclaw.internal）向けにスプリット DNS を設定する場合
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:07Z
---

# `openclaw dns`

広域ディスカバリー向けの DNS ヘルパー（Tailscale + CoreDNS）です。現在は macOS + Homebrew CoreDNS に重点を置いています。

関連情報:

- Gateway ディスカバリー: [Discovery](/gateway/discovery)
- 広域ディスカバリーの設定: [Configuration](/gateway/configuration)

## セットアップ

```bash
openclaw dns setup
openclaw dns setup --apply
```
