---
summary: "「openclaw voicecall」的 CLI 參考（語音通話外掛的指令介面）"
read_when:
  - 40. 你使用語音通話外掛程式並想要 CLI 進入點
  - 當你想要「voicecall call|continue|status|tail|expose」的快速範例時
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

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

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
