---
summary: "`openclaw dns`（広域ディスカバリーヘルパー）のCLIリファレンス"
read_when:
  - Tailscale + CoreDNS を使用した広域ディスカバリー（DNS-SD）を行いたい場合
  - カスタムディスカバリードメイン用のスプリットDNSを設定する場合（例：openclaw.internal）
title: "dns"
---

# `openclaw dns`

広域ディスカバリー（Tailscale + CoreDNS）用のDNSヘルパーです。現在はmacOS + Homebrew CoreDNSに焦点を当てています。

関連情報：

- ゲートウェイディスカバリー：[ディスカバリー](/gateway/discovery)
- 広域ディスカバリーの設定：[設定](/gateway/configuration)

## セットアップ

```bash
openclaw dns setup
openclaw dns setup --apply
```
