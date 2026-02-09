---
summary: "為 IDE 整合執行 ACP 橋接"
read_when:
  - 設定基於 ACP 的 IDE 整合
  - 除錯 ACP 工作階段路由至 Gateway 閘道器
title: "acp"
---

# acp

執行與 OpenClaw Gateway 閘道器 通訊的 ACP（Agent Client Protocol）橋接。

此指令透過 stdio 為 IDE 使用 ACP，並透過 WebSocket 將提示轉送至 Gateway 閘道器。它會將 ACP 工作階段對應到 Gateway 閘道器 的工作階段金鑰。 It keeps ACP sessions mapped to Gateway session keys.

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP client（除錯）

使用內建的 ACP 用戶端，在沒有 IDE 的情況下對橋接進行基本檢查。
它會啟動 ACP 橋接，並讓你以互動方式輸入提示。
It spawns the ACP bridge and lets you type prompts interactively.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

當 IDE（或其他用戶端）使用 Agent Client Protocol，且你希望它驅動 OpenClaw Gateway 閘道器 的工作階段時，請使用 ACP。

1. 確保 Gateway 閘道器 正在執行（本機或遠端）。
2. 設定 Gateway 閘道器 目標（設定或旗標）。
3. 指定你的 IDE 透過 stdio 執行 `openclaw acp`。

範例設定（持久化）：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

直接執行範例（不寫入設定）：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACP does not pick agents directly. It routes by the Gateway session key.

Use agent-scoped session keys to target a specific agent:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Each ACP session maps to a single Gateway session key. One agent can have many
sessions; ACP defaults to an isolated `acp:<uuid>` session unless you override
the key or label.

## Zed editor setup

在 `~/.config/zed/settings.json` 中新增自訂 ACP 代理程式（或使用 Zed 的設定 UI）：

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

要鎖定特定 Gateway 閘道器 或代理程式：

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

在 Zed 中，開啟 Agent 面板並選取「OpenClaw ACP」以啟動一個執行緒。

## Session mapping

By default, ACP sessions get an isolated Gateway session key with an `acp:` prefix.
To reuse a known session, pass a session key or label:

- `--session <key>`：使用特定的 Gateway 閘道器 工作階段金鑰。
- `--session-label <label>`：依標籤解析既有工作階段。
- `--reset-session`：為該金鑰產生新的工作階段 ID（相同金鑰，新逐字稿）。

If your ACP client supports metadata, you can override per session:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Learn more about session keys at [/concepts/session](/concepts/session).

## Options

- `--url <url>`：Gateway 閘道器 WebSocket URL（已設定時，預設為 gateway.remote.url）。
- `--token <token>`：Gateway 閘道器 身分驗證權杖。
- `--password <password>`：Gateway 閘道器 身分驗證密碼。
- `--session <key>`：預設工作階段金鑰。
- `--session-label <label>`：要解析的預設工作階段標籤。
- `--require-existing`: fail if the session key/label does not exist.
- `--reset-session`：在首次使用前重設工作階段金鑰。
- `--no-prefix-cwd`：不要以前置工作目錄作為提示前綴。
- `--verbose, -v`：將詳細記錄輸出至 stderr。

### `acp client` options

- `--cwd <dir>`：ACP 工作階段的工作目錄。
- `--server <command>`：ACP 伺服器指令（預設：`openclaw`）。
- `--server-args <args...>`：傳遞給 ACP 伺服器的額外引數。
- `--server-verbose`：在 ACP 伺服器上啟用詳細記錄。
- `--verbose, -v`：詳細的用戶端記錄。
