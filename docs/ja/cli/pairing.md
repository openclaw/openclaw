---
summary: "「openclaw pairing」の CLI リファレンス（ペアリング要求の承認／一覧表示）"
read_when:
  - ペアリングモードの DM を使用しており、送信者を承認する必要がある場合
title: "ペアリング"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:12Z
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
