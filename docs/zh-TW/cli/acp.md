---
summary: "執行用於 IDE 整合的 ACP 橋接器"
read_when:
  - 設定基於 ACP 的 IDE 整合
  - 調試 ACP 工作階段到 Gateway 的路由
title: "acp"
---

# acp

執行與 OpenClaw Gateway 通訊的 ACP (Agent Client Protocol) 橋接器。

此命令透過 stdio 為 IDE 提供 ACP 服務，並透過 WebSocket 將提示詞轉發至 Gateway。它會將 ACP 工作階段對應到 Gateway 工作階段金鑰。

## 用法

```bash
openclaw acp

# 遠端 Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# 附加至現有的工作階段金鑰
openclaw acp --session agent:main:main

# 透過標籤附加（必須已存在）
openclaw acp --session-label "support inbox"

# 在第一個提示詞之前重設工作階段金鑰
openclaw acp --session agent:main:main --reset-session
```

## ACP 用戶端 (除錯)

使用內建的 ACP 用戶端在沒有 IDE 的情況下對橋接器進行安裝完整性檢查。它會啟動 ACP 橋接器，並讓您互動式地輸入提示詞。

```bash
openclaw acp client

# 將啟動的橋接器指向遠端 Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# 覆蓋伺服器命令（預設值：openclaw）
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## 如何使用

當 IDE（或其他用戶端）支援 Agent Client Protocol 且您希望其驅動 OpenClaw Gateway 工作階段時，請使用 ACP。

1. 確保 Gateway 正在執行（本地或遠端）。
2. 設定 Gateway 目標（透過設定或旗標）。
3. 將您的 IDE 指向透過 stdio 執行 `openclaw acp`。

範例設定（永久儲存）：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

範例直接執行（不寫入設定）：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## 選擇智慧代理

ACP 不會直接選擇智慧代理。它根據 Gateway 工作階段金鑰進行路由。

使用智慧代理範圍的工作階段金鑰來指定特定智慧代理：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

每個 ACP 工作階段都會對應到單個 Gateway 工作階段金鑰。一個智慧代理可以有多個工作階段；除非您覆蓋金鑰或標籤，否則 ACP 預設使用隔離的 `acp:<uuid>` 工作階段。

## Zed 編輯器設定

在 `~/.config/zed/settings.json` 中新增自定義 ACP 智慧代理（或使用 Zed 的設定 UI）：

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

指定特定的 Gateway 或智慧代理：

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

在 Zed 中，開啟智慧代理面板並選擇「OpenClaw ACP」來開始對話。

## 工作階段對應

預設情況下，ACP 工作階段會獲得一個帶有 `acp:` 前綴的隔離 Gateway 工作階段金鑰。要重複使用已知的工作階段，請傳遞工作階段金鑰或標籤：

- `--session <key>`：使用特定的 Gateway 工作階段金鑰。
- `--session-label <label>`：透過標籤解析現有的工作階段。
- `--reset-session`：為該金鑰產生一個新的工作階段 ID（相同的金鑰，新的對話紀錄）。

如果您的 ACP 用戶端支援中繼資料 (metadata)，您可以為每個工作階段進行覆蓋：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

在 [/concepts/session](/concepts/session) 了解更多關於工作階段金鑰的資訊。

## 選項

- `--url <url>`：Gateway WebSocket URL（設定後預設為 gateway.remote.url）。
- `--token <token>`：Gateway 認證權杖。
- `--password <password>`：Gateway 認證密碼。
- `--session <key>`：預設工作階段金鑰。
- `--session-label <label>`：要解析的預設工作階段標籤。
- `--require-existing`：如果工作階段金鑰/標籤不存在則失敗。
- `--reset-session`：在首次使用前重設工作階段金鑰。
- `--no-prefix-cwd`：不要在提示詞前加上工作目錄。
- `--verbose, -v`：輸出詳細日誌至 stderr。

### `acp client` 選項

- `--cwd <dir>`：ACP 工作階段的工作目錄。
- `--server <command>`：ACP 伺服器命令（預設值：`openclaw`）。
- `--server-args <args...>`：傳遞給 ACP 伺服器的額外參數。
- `--server-verbose`：在 ACP 伺服器上啟用詳細日誌。
- `--verbose, -v`：詳細的用戶端日誌。
