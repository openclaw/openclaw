---
summary: CLI reference for `openclaw voicecall` (voice-call plugin command surface)
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: voicecall
---

# `openclaw voicecall`

`voicecall` 是一個由插件提供的命令。只有在安裝並啟用語音通話插件的情況下，它才會出現。

[[BLOCK_1]]

- 語音通話插件: [語音通話](/plugins/voice-call)

## 常用指令

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 曝露 Webhook（Tailscale）

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall expose --mode off
```

安全提示：僅將 webhook 端點暴露給您信任的網路。盡可能優先使用 Tailscale Serve 而非 Funnel。
