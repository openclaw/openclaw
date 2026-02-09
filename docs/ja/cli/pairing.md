---
summary: "「openclaw pairing」の CLI リファレンス（ペアリング要求の承認／一覧表示）"
read_when:
  - ペアリングモードの DM を使用しており、送信者を承認する必要がある場合
title: "ペアリング"
---

# `openclaw pairing`

DM のペアリング要求を承認または確認します（ペアリングをサポートするチャンネル向け）。

関連:

- ペアリングのフロー: [ペアリング](/channels/pairing)

## コマンド

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
