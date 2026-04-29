---
name: 1password
description: Set up and use 1Password CLI for sign-in, desktop integration, and reading or injecting secrets.
homepage: https://developer.1password.com/docs/cli/get-started/
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "requires": { "bins": ["op"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "1password-cli",
              "bins": ["op"],
              "label": "Install 1Password CLI (brew)",
            },
          ],
      },
  }
---

# 1Password CLI

按照官方 CLI 入门步骤操作。不要猜测安装命令。

## 参考资料

- `references/get-started.md`（安装 + 应用集成 + 登录流程）
- `references/cli-examples.md`（真实的 `op` 示例）

## 工作流程

1. 检查 OS + shell。
2. 验证 CLI 存在：`op --version`。
3. 确认桌面应用集成已启用（按入门指南）且应用已解锁。
4. **必需**：为所有 `op` 命令创建一个新的 tmux 会话（不要在 tmux 外直接调用 `op`）。
5. 在 tmux 内登录/授权：`op signin`（期待应用提示）。
6. 在 tmux 内验证访问：`op whoami`（在任何密钥读取之前必须成功）。
7. 如果有多个账户：使用 `--account` 或 `OP_ACCOUNT`。

## **必需的 tmux 会话（T-Max）**

shell 工具每个命令使用一个新的 TTY。为避免重复提示和失败，始终在专用 tmux 会话中运行 `op`，并使用新的 socket/session 名称。

示例（有关 socket 约定请参阅 `tmux` skill，不要重用旧会话名称）：

```bash
SOCKET_DIR="${OPENCLAW_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/openclaw-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/openclaw-op.sock"
SESSION="op-auth-$(date +%Y%m%d-%H%M%S)"

tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op signin --account my.1password.com" Enter
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op whoami" Enter
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op vault list" Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200
tmux -S "$SOCKET" kill-session -t "$SESSION"
```

## 护栏

- 永远不要将密钥粘贴到日志、聊天或代码中。
- 优先使用 `op run` / `op inject`，而不是将密钥写入磁盘。
- 如果需要不带应用集成的登录，使用 `op account add`。
- 如果命令返回"account is not signed in"，在 tmux 内重新运行 `op signin` 并在应用中授权。
- 不要在 tmux 外运行 `op`；如果 tmux 不可用，停止并询问。
