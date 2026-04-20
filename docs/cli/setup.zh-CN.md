---
summary: "`openclaw setup` 命令行参考（初始化配置和工作区）"
read_when:
  - 你正在进行首次运行设置，无需完整的 CLI 入职
  - 你想设置默认工作区路径
title: "setup"
---

# `openclaw setup`

初始化 `~/.openclaw/openclaw.json` 和代理工作区。

相关：

- 入门：[入门](/start/getting-started)
- CLI 入职：[入职（CLI）](/start/wizard)

## 示例

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
openclaw setup --wizard
openclaw setup --non-interactive --mode remote --remote-url wss://gateway-host:18789 --remote-token <token>
```

## 选项

- `--workspace <dir>`：代理工作区目录（存储为 `agents.defaults.workspace`）
- `--wizard`：运行入职
- `--non-interactive`：无提示运行入职
- `--mode <local|remote>`：入职模式
- `--remote-url <url>`：远程网关 WebSocket URL
- `--remote-token <token>`：远程网关令牌

通过 setup 运行入职：

```bash
openclaw setup --wizard
```

注意：

- 简单的 `openclaw setup` 初始化配置和工作区，无需完整的入职流程。
- 当存在任何入职标志时（`--wizard`、`--non-interactive`、`--mode`、`--remote-url`、`--remote-token`），入职会自动运行。