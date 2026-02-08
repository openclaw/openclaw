---
summary: "「openclaw voicecall」的 CLI 參考（語音通話外掛的指令介面）"
read_when:
  - 當你使用語音通話外掛並需要 CLI 進入點時
  - 當你想要「voicecall call|continue|status|tail|expose」的快速範例時
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:29Z
---

# `openclaw voicecall`

`voicecall` 是由外掛提供的指令。只有在已安裝並啟用語音通話外掛時才會出現。

主要文件：

- 語音通話外掛：[Voice Call](/plugins/voice-call)

## 常用指令

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 公開 Webhook（Tailscale）

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

安全性注意事項：僅將 Webhook 端點公開給你信任的網路。可行時，優先使用 Tailscale Serve 而非 Funnel。
