---
summary: "`openclaw voicecall` 的 CLI 參考文件（語音通話外掛程式指令介面）"
read_when:
  - "你正在使用語音通話外掛程式並需要 CLI 進入點"
  - "你想要參考 `voicecall call|continue|status|tail|expose` 的快速範例"
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` 是由外掛程式提供的指令。僅在語音通話外掛程式已安裝且啟用的情況下才會顯示。

主要文件：

- 語音通話外掛程式：[Voice Call](/plugins/voice-call)

## 常用指令

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 公開 Webhook (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

安全性注意事項：僅向你信任的網路公開 Webhook 端點。如果可能，請優先使用 Tailscale Serve 而非 Funnel。
