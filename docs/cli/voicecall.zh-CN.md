---
summary: "`openclaw voicecall` 命令行参考（语音通话插件命令界面）"
read_when:
  - 你使用语音通话插件并需要 CLI 入口点
  - 你想要 `voicecall call|continue|status|tail|expose` 的快速示例
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` 是一个插件提供的命令。它只在语音通话插件已安装并启用时才会出现。

主要文档：

- 语音通话插件：[语音通话](/plugins/voice-call)

## 常见命令

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 暴露 webhook（Tailscale）

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall expose --mode off
```

安全注意：仅将 webhook 端点暴露给你信任的网络。尽可能优先使用 Tailscale Serve 而不是 Funnel。
