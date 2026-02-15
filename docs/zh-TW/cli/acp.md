---
summary: "為 IDE 整合執行 ACP 橋接器"
read_when:
  - 設定基於 ACP 的 IDE 整合
  - 偵錯流向 Gateway 的 ACP 工作階段路由
title: "acp"
---

# acp

執行與 OpenClaw Gateway 通訊的 ACP (Agent Client Protocol) 橋接器。

此命令透過標準輸入/輸出 (stdio) 支援 IDE 的 ACP，並透過 WebSocket 將提示轉發到 Gateway。它將 ACP 工作階段映射到 Gateway 工作階段鍵。

## 用法

```bash
openclaw acp

# 遠端 Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# 連接到現有工作階段鍵
openclaw acp --session agent:main:main

# 透過標籤連接（必須已存在）
openclaw acp --session-label "support inbox"

# 在第一個提示前重設工作階段鍵
openclaw acp --session agent:main:main --reset-session
```

## ACP 用戶端 (偵錯)

使用內建的 ACP 用戶端，無需 IDE 即可檢查橋接器是否正常。它會啟動 ACP 橋接器，讓您可以互動式地輸入提示。

```bash
openclaw acp client

# 將啟動的橋接器指向遠端 Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# 覆寫伺服器命令 (預設: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## 如何使用

當 IDE (或其他用戶端) 支援 Agent Client Protocol，並且您希望它驅動 OpenClaw Gateway 工作階段時，請使用 ACP。

1.  確保 Gateway 正在執行 (本機或遠端)。
2.  設定 Gateway 目標 (設定或旗標)。
3.  指示您的 IDE 透過 stdio 執行 `openclaw acp`。

範例設定 (持久化):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

範例直接執行 (不寫入設定):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## 選擇智慧代理

ACP 不直接選擇智慧代理。它根據 Gateway 工作階段鍵進行路由。

使用智慧代理範圍的工作階段鍵來指定特定的智慧代理：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

每個 ACP 工作階段映射到一個單一的 Gateway 工作階段鍵。一個智慧代理可以有多個工作階段；除非您覆寫鍵或標籤，否則 ACP 預設為隔離的 `acp:<uuid>` 工作階段。

## Zed 編輯器設定

在 `~/.config/zed/settings.json` 中新增一個自訂 ACP 智慧代理 (或使用 Zed 的設定使用者介面)：

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

若要指定特定的 Gateway 或智慧代理：

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

在 Zed 中，打開智慧代理面板並選擇「OpenClaw ACP」以啟動一個執行緒。

## 工作階段映射

預設情況下，ACP 工作階段會獲得一個帶有 `acp:` 前綴的隔離 Gateway 工作階段鍵。若要重複使用已知工作階段，請傳遞工作階段鍵或標籤：

-   `--session <key>`: 使用特定的 Gateway 工作階段鍵。
-   `--session-label <label>`: 透過標籤解析現有工作階段。
-   `--reset-session`: 為該鍵生成一個全新的工作階段 ID (相同的鍵，新的副本)。

如果您的 ACP 用戶端支援中繼資料，您可以依每個工作階段覆寫：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

了解更多關於工作階段鍵的資訊，請參閱 [/concepts/session](/concepts/session)。

## 選項

-   `--url <url>`: Gateway WebSocket URL (如果已設定，預設為 gateway.remote.url)。
-   `--token <token>`: Gateway 憑證。
-   `--password <password>`: Gateway 認證密碼。
-   `--session <key>`: 預設工作階段鍵。
-   `--session-label <label>`: 預設要解析的工作階段標籤。
-   `--require-existing`: 如果工作階段鍵/標籤不存在，則失敗。
-   `--reset-session`: 在首次使用前重設工作階段鍵。
-   `--no-prefix-cwd`: 不要以目前工作目錄作為提示的前綴。
-   `--verbose, -v`: 詳細記錄到標準錯誤。

### `acp client` 選項

-   `--cwd <dir>`: ACP 工作階段的工作目錄。
-   `--server <command>`: ACP 伺服器命令 (預設: `openclaw`)。
-   `--server-args <args...>`: 傳遞給 ACP 伺服器的額外引數。
-   `--server-verbose`: 在 ACP 伺服器上啟用詳細記錄。
-   `--verbose, -v`: 詳細用戶端記錄。
