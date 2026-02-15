---
summary: "openclaw voicecall 的 CLI 參考 (語音通話外掛指令介面)"
read_when:
  - 當您使用語音通話外掛並需要 CLI 進入點時
  - 當您需要 voicecall call|continue|status|tail|expose 的快速範例時
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` 是一個外掛提供的指令。它只會在語音通話外掛已安裝並啟用時才會出現。

主要文件：

- 語音通話外掛：[語音通話](/plugins/voice-call)

## 常見指令

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 暴露 webhooks (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

安全注意事項：僅將 webhook 端點暴露給您信任的網路。如果可能，請優先選擇 Tailscale Serve 而非 Funnel。
