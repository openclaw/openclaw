---
summary: "`openclaw voicecall` の CLI リファレンス（音声通話プラグインコマンドサーフェス）"
read_when:
  - 音声通話プラグインを使用していて CLI のエントリポイントが必要な場合
  - `voicecall call|continue|status|tail|expose` の簡単な例が必要な場合
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` はプラグインが提供するコマンドです。音声通話プラグインがインストールされ、有効になっている場合にのみ表示されます。

主要なドキュメント:

- 音声通話プラグイン: [Voice Call](/plugins/voice-call)

## 一般的なコマンド

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Webhook の公開（Tailscale）

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall expose --mode off
```

セキュリティに関する注意: Webhook エンドポイントは信頼できるネットワークにのみ公開してください。可能な限り Tailscale Funnel よりも Tailscale Serve を推奨します。
