---
summary: "`openclaw status` のCLIリファレンス（診断、プローブ、使用状況スナップショット）"
read_when:
  - チャネルの健全性と最近のセッション受信者を素早く診断したい場合
  - デバッグ用に貼り付け可能な「all」ステータスが欲しい場合
title: "status"
---

# `openclaw status`

チャネルとセッションの診断情報を表示します。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

注意事項：

- `--deep` はライブプローブを実行します（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
- 概要には、利用可能な場合、Gateway + ノードホストサービスのインストール/ランタイムステータスが含まれます。
- 概要には、更新チャネル + git SHA（ソースチェックアウトの場合）が含まれます。
- 更新情報は概要に表示されます。更新が利用可能な場合、status は `openclaw update` の実行を促すヒントを表示します（[アップデート](/install/updating)を参照）。
