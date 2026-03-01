---
summary: "`openclaw pairing` の CLI リファレンス（ペアリングリクエストの承認/一覧）"
read_when:
  - ペアリングモード DM を使用していて送信者の承認が必要な場合
title: "pairing"
---

# `openclaw pairing`

DM ペアリングリクエストの承認または確認を行います（ペアリングをサポートするチャンネル向け）。

関連:

- ペアリングフロー: [ペアリング](/channels/pairing)

## コマンド

```bash
openclaw pairing list telegram
openclaw pairing list --channel telegram --account work
openclaw pairing list telegram --json

openclaw pairing approve telegram <code>
openclaw pairing approve --channel telegram --account work <code> --notify
```

## 注意事項

- チャンネルの入力: 位置指定（`pairing list telegram`）または `--channel <channel>` で渡します。
- `pairing list` はマルチアカウントチャンネル用に `--account <accountId>` をサポートしています。
- `pairing approve` は `--account <accountId>` と `--notify` をサポートしています。
- ペアリング対応チャンネルが1つだけ設定されている場合、`pairing approve <code>` が使用できます。
