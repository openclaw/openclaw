---
read_when:
    - 音声通話プラグインを使用していて CLI のエントリーポイントを知りたい場合
    - '`voicecall call|continue|status|tail|expose` の簡単な使用例を知りたい場合'
summary: '`openclaw voicecall`（音声通話プラグインのコマンド）の CLI リファレンス'
title: voicecall
x-i18n:
    generated_at: "2026-04-02T07:36:09Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 2c99e7a3d256e1c74a0f07faba9675cc5a88b1eb2fc6e22993caf3874d4f340a
    source_path: cli/voicecall.md
    workflow: 15
---

# `openclaw voicecall`

`voicecall` はプラグイン提供のコマンドです。音声通話プラグインがインストールされ有効になっている場合にのみ表示されます。

主要ドキュメント:

- 音声通話プラグイン: [Voice Call](/plugins/voice-call)

## よく使うコマンド

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

セキュリティに関する注意: webhook エンドポイントは信頼できるネットワークにのみ公開してください。可能な場合は Tailscale Funnel よりも Tailscale Serve を優先してください。
