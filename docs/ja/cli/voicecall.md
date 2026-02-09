---
summary: "CLI 参照: `openclaw voicecall`（voice-call プラグインのコマンド サーフェス）"
read_when:
  - voice-call プラグインを使用しており、CLI のエントリーポイントを確認したい場合
  - "`voicecall call|continue|status|tail|expose` のクイック例を確認したい場合"
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` はプラグインが提供するコマンドです。 `voicecall` はプラグインによって提供されるコマンドです。voice-call プラグインがインストールされ、有効化されている場合にのみ表示されます。

主要ドキュメント:

- Voice-call プラグイン: [Voice Call](/plugins/voice-call)

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
openclaw voicecall unexpose
```

セキュリティ注記: Webhook エンドポイントは、信頼できるネットワークにのみ公開してください。可能な場合は、Funnel よりも Tailscale Serve を優先してください。 可能な場合は、テールスケールは、ファンネルよりもサーブを好む。
