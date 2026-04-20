---
summary: "`openclaw tui` 命令行参考（连接到网关的终端 UI）"
read_when:
  - 你想要网关的终端 UI（远程友好）
  - 你想从脚本传递 url/token/session
title: "tui"
---

# `openclaw tui`

打开连接到网关的终端 UI。

相关：

- TUI 指南：[TUI](/web/tui)

注意：

- `tui` 在可能的情况下解析配置的网关认证 SecretRef 用于令牌/密码认证（`env`/`file`/`exec` 提供商）。
- 当从配置的代理工作区目录内启动时，TUI 会自动选择该代理作为会话密钥默认值（除非 `--session` 明确为 `agent:<id>:...`）。

## 示例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
# 当在代理工作区内运行时，自动推断该代理
openclaw tui --session bugfix
```
