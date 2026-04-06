---
read_when:
    - ペアリングモードのダイレクトメッセージを使用しており、送信者を承認する必要がある場合
summary: '`openclaw pairing`（ペアリングリクエストの承認/一覧表示）のCLIリファレンス'
title: pairing
x-i18n:
    generated_at: "2026-04-02T07:34:34Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 266732af69e57b8849ddc9963426902f60e81daed6e5a80ef4ed5b7923ffa9e2
    source_path: cli/pairing.md
    workflow: 15
---

# `openclaw pairing`

ダイレクトメッセージのペアリングリクエストを承認または確認します（ペアリングに対応するチャネル用）。

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

- チャネル入力: 位置引数で渡す（`pairing list telegram`）か、`--channel <channel>` で指定します。
- `pairing list` はマルチアカウントチャネル向けに `--account <accountId>` をサポートしています。
- `pairing approve` は `--account <accountId>` と `--notify` をサポートしています。
- ペアリング対応チャネルが1つだけ設定されている場合、`pairing approve <code>` が許可されます。
