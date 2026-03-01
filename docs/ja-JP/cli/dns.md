---
summary: "`openclaw dns` のCLIリファレンス（広域ディスカバリーヘルパー）"
read_when:
  - Tailscale + CoreDNSによる広域ディスカバリー（DNS-SD）を使いたい場合
  - カスタムディスカバリードメイン（例：openclaw.internal）のスプリットDNSをセットアップしている場合
title: "dns"
---

# `openclaw dns`

広域ディスカバリー（Tailscale + CoreDNS）のDNSヘルパーです。現在はmacOS + Homebrew CoreDNSに焦点を当てています。

関連：

- Gatewayディスカバリー：[Discovery](/gateway/discovery)
- 広域ディスカバリー設定：[Configuration](/gateway/configuration)

## セットアップ

```bash
openclaw dns setup
openclaw dns setup --apply
```
