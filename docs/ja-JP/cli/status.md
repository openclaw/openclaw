---
summary: "`openclaw status` の CLI リファレンス（診断、プローブ、使用量スナップショット）"
read_when:
  - チャンネルの健全性 + 最近のセッション受信者のクイック診断
  - デバッグ用にペースト可能な「all」ステータスの取得
title: "status"
---

# `openclaw status`

チャンネル + セッションの診断を行います。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

注意事項:

- `--deep` はライブプローブを実行します（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
- 概要には Gateway + ノードホストサービスのインストール/ランタイムステータスが含まれます（利用可能な場合）。
- 概要にはアップデートチャンネル + git SHA（ソースチェックアウトの場合）が含まれます。
- アップデート情報は概要に表示されます。アップデートが利用可能な場合、`openclaw update` を実行するヒントが表示されます（[アップデート](/install/updating) を参照）。
