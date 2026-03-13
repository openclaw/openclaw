---
summary: Run the ACP bridge for IDE integrations
read_when:
  - Setting up ACP-based IDE integrations
  - Debugging ACP session routing to the Gateway
title: acp
---

# acp

執行與 OpenClaw Gateway 通訊的 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 橋接。

此命令透過標準輸入輸出 (stdio) 為 IDE 說明 ACP，並通過 WebSocket 將提示轉發到 Gateway。它將 ACP 會話映射到 Gateway 會話金鑰。

`openclaw acp` 是一個由 Gateway 支援的 ACP 橋接，而不是完整的 ACP 原生編輯器執行環境。它專注於會話路由、提示傳遞和基本的串流更新。

## 相容性矩陣

| ACP 區域                                                       | 狀態     | 備註                                                                                                                                                                   |
| -------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`, `newSession`, `prompt`, `cancel`                 | 已實作   | 核心橋接流程透過 stdio 連接到 Gateway 的聊天/發送 + 中止功能。                                                                                                         |
| `listSessions`, 斜線指令                                       | 已實作   | 會話列表能夠對應 Gateway 的會話狀態；指令透過 `available_commands_update` 進行廣告宣傳。                                                                               |
| `loadSession`                                                  | 部分實作 | 將 ACP 會話重新綁定到 Gateway 會話金鑰並重播儲存的使用者/助手文本歷史。工具/系統歷史尚未重建。                                                                         |
| 提示內容 (`text`, 嵌入式 `resource`, 圖片)                     | 部分實作 | 文本/資源被扁平化為聊天輸入；圖片成為 Gateway 附件。                                                                                                                   |
| 會話模式                                                       | 部分實作 | `session/set_mode` 被支援，橋接提供初始的 Gateway 支援會話控制，包括思考層級、工具詳細程度、推理、使用細節和提升的行動。更廣泛的 ACP 原生模式/設定介面仍然不在範圍內。 |
| 會話資訊和使用更新                                             | 部分實作 | 橋接發出 `session_info_update` 和最佳努力的 `usage_update` 通知，來自快取的 Gateway 會話快照。使用量是近似的，僅在 Gateway token 總數被標記為新鮮時發送。              |
| 工具串流                                                       | 部分實作 | `tool_call` / `tool_call_update` 事件包括原始 I/O、文本內容，以及當 Gateway 工具參數/結果暴露時的最佳努力檔案位置。嵌入式終端和更豐富的差異原生輸出尚未被暴露。        |
| 每會話 MCP 伺服器 (`mcpServers`)                               | 不支援   | 橋接模式拒絕每會話的 MCP 伺服器請求。請在 OpenClaw 網關或代理上設定 MCP。                                                                                              |
| 用戶端檔案系統方法 (`fs/read_text_file`, `fs/write_text_file`) | 不支援   | 橋接不會調用 ACP 用戶端檔案系統方法。                                                                                                                                  |
| 用戶端終端方法 (`terminal/*`)                                  | 不支援   | 橋接不會創建 ACP 用戶端終端或透過工具調用串流終端 ID。                                                                                                                 |
| 會話計畫 / 思考串流                                            | 不支援   | 橋接目前僅發出輸出文本和工具狀態，而不更新 ACP 計畫或思考。                                                                                                            |

## 已知限制事項

- `loadSession` 會重播儲存的使用者和助手文本歷史，但不會重建歷史工具呼叫、系統通知或更豐富的 ACP 原生事件類型。
- 如果多個 ACP 用戶端共享相同的 Gateway 會話金鑰，事件和取消路由將是最佳努力，而不是每個用戶端嚴格隔離。當您需要乾淨的編輯器本地回合時，請優先使用預設的隔離 `acp:<uuid>` 會話。
- Gateway 停止狀態被轉換為 ACP 停止原因，但該映射的表達能力不如完全的 ACP 原生執行時。
- 初始會話控制目前顯示了一組專注的 Gateway 控制項：思考層級、工具詳細程度、推理、使用細節和提升的行動。模型選擇和執行主機控制尚未作為 ACP 設定選項公開。
- `session_info_update` 和 `usage_update` 是從 Gateway 會話快照衍生的，而不是即時的 ACP 原生執行時記錄。使用量是近似的，沒有成本數據，並且僅在 Gateway 標記總token數據為新鮮時發出。
- 工具跟隨數據是最佳努力。橋接可以顯示出現在已知工具參數/結果中的檔案路徑，但尚未發出 ACP 終端或結構化的檔案差異。

## 使用方式

bash
openclaw acp

# 遠端閘道

openclaw acp --url wss://gateway-host:18789 --token <token>

# 遠端閘道 (從檔案取得 token)

openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 附加到現有的會話金鑰

openclaw acp --session agent:main:main

# 依標籤附加（必須已存在）

openclaw acp --session-label "support inbox"

# 在第一次提示之前重置會話金鑰

openclaw acp --session agent:main:main --reset-session

## ACP 用戶端 (除錯)

使用內建的 ACP 用戶端來進行橋接的基本檢查，而不需要 IDE。它會啟動 ACP 橋接，並讓你互動式地輸入提示。

bash
openclaw acp client

# 將生成的橋接指向遠端網關

openclaw acp client --server-args --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 覆蓋伺服器命令（預設值：openclaw）

openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001

Permission model (client debug mode):

- 自動批准是基於允許清單的，僅適用於受信任的核心工具 ID。
- `read` 自動批准的範圍限於當前工作目錄 (`--cwd` 當設定時)。
- 不明/非核心工具名稱、超出範圍的讀取和危險工具始終需要明確的提示批准。
- 伺服器提供的 `toolCall.kind` 被視為不受信任的元資料（不是授權來源）。

## 如何使用這個

當一個 IDE（或其他用戶端）使用代理用戶端協議（Agent Client Protocol, ACP）時，您可以使用 ACP 來驅動 OpenClaw Gateway 會話。

1. 確保 Gateway 正在執行（本地或遠端）。
2. 設定 Gateway 目標（設定或標誌）。
3. 指定您的 IDE 以透過 stdio 執行 `openclaw acp`。

範例設定（持久化）：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

範例直接執行（不寫入設定）：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
# preferred for local process safety
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
```

## 選擇代理人

ACP 不會直接選擇代理。它是通過 Gateway 會話金鑰進行路由的。

使用代理範圍的會話金鑰來針對特定代理：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

每個 ACP 會話對應到一個單一的 Gateway 會話金鑰。單一代理可以有多個會話；ACP 預設為一個獨立的 `acp:<uuid>` 會話，除非您覆蓋金鑰或標籤。

每個會話的 `mcpServers` 在橋接模式下不被支援。如果 ACP 用戶端在 `newSession` 或 `loadSession` 期間發送它們，橋接將返回明確的錯誤，而不是靜默地忽略它們。

## 從 `acpx` 使用 (Codex, Claude, 其他 ACP 用戶端)

如果您想讓像 Codex 或 Claude Code 這樣的編碼代理通過 ACP 與您的 OpenClaw 機器人進行對話，請使用 `acpx` 及其內建的 `openclaw` 目標。

典型流程：

1. 啟動 Gateway，並確保 ACP bridge 可以連接到它。
2. 將 `acpx openclaw` 指向 `openclaw acp`。
3. 目標是您希望編碼代理使用的 OpenClaw 會話金鑰。

[[BLOCK_1]]  
Examples:  
[[INLINE_1]]

bash

# 一次性請求到您的預設 OpenClaw ACP 會話

acpx openclaw exec "總結當前的 OpenClaw 會話狀態。"

# 持久命名會話以便後續回合

acpx openclaw sessions ensure --name codex-bridge
acpx openclaw -s codex-bridge --cwd /path/to/repo \
 "詢問我的 OpenClaw 工作代理有關此倉庫的最新相關上下文。"

如果您希望 `acpx openclaw` 每次都針對特定的 Gateway 和會話金鑰，請在 `~/.acpx/config.json` 中覆寫 `openclaw` 代理命令：

```json
{
  "agents": {
    "openclaw": {
      "command": "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"
    }
  }
}
```

對於 repo-local 的 OpenClaw 檢出，請使用直接的 CLI 入口點，而不是開發執行器，以保持 ACP 流的乾淨。例如：

```bash
env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node openclaw.mjs acp ...
```

這是讓 Codex、Claude Code 或其他支援 ACP 的用戶端從 OpenClaw 代理提取上下文資訊的最簡單方法，而無需抓取終端。

## Zed 編輯器設定

在 `~/.config/zed/settings.json` 中新增自訂的 ACP 代理（或使用 Zed 的設定 UI）：

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

要針對特定的 Gateway 或代理：

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

在 Zed 中，打開代理面板並選擇「OpenClaw ACP」以開始一個執行緒。

## Session mapping

預設情況下，ACP 會話會獲得一個帶有 `acp:` 前綴的獨立 Gateway 會話金鑰。要重用已知的會話，請傳遞會話金鑰或標籤：

- `--session <key>`: 使用特定的 Gateway 會話金鑰。
- `--session-label <label>`: 根據標籤解析現有的會話。
- `--reset-session`: 為該金鑰鑄造一個新的會話 ID（相同金鑰，新的記錄）。

如果您的 ACP 用戶端支援元資料，您可以針對每個會話進行覆寫：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

了解有關會話金鑰的更多資訊，請參閱 [/concepts/session](/concepts/session)。

## Options

- `--url <url>`: Gateway WebSocket URL（當設定時預設為 gateway.remote.url）。
- `--token <token>`: Gateway 認證 token。
- `--token-file <path>`: 從檔案讀取 Gateway 認證 token。
- `--password <password>`: Gateway 認證密碼。
- `--password-file <path>`: 從檔案讀取 Gateway 認證密碼。
- `--session <key>`: 預設會話金鑰。
- `--session-label <label>`: 預設會話標籤以進行解析。
- `--require-existing`: 如果會話金鑰/標籤不存在則失敗。
- `--reset-session`: 在首次使用前重置會話金鑰。
- `--no-prefix-cwd`: 不要在提示前加上工作目錄。
- `--verbose, -v`: 將詳細日誌記錄到 stderr。

安全注意事項：

- `--token` 和 `--password` 在某些系統的本地進程列表中是可見的。
- 優先使用 `--token-file`/`--password-file` 或環境變數 (`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`)。
- Gateway 認證解析遵循其他 Gateway 用戶端使用的共享合約：
  - 本地模式：env (`OPENCLAW_GATEWAY_*`) -> `gateway.auth.*` -> `gateway.remote.*` 僅在 `gateway.auth.*` 未設置時回退（設定但未解析的本地 SecretRefs 會失敗並關閉）
  - 遠端模式：`gateway.remote.*` 依據遠端優先規則使用 env/config 回退
  - `--url` 是安全的覆蓋，並且不重用隱式的設定/環境憑證；請傳遞明確的 `--token`/`--password`（或檔案變體）
- ACP 執行時後端子進程接收 `OPENCLAW_SHELL=acp`，可用於上下文特定的 shell/profile 規則。
- `openclaw acp client` 在生成的橋接進程上設置 `OPENCLAW_SHELL=acp-client`。

### `acp client` 選項

- `--cwd <dir>`: ACP 會話的工作目錄。
- `--server <command>`: ACP 伺服器命令（預設值：`openclaw`）。
- `--server-args <args...>`: 傳遞給 ACP 伺服器的額外參數。
- `--server-verbose`: 在 ACP 伺服器上啟用詳細日誌記錄。
- `--verbose, -v`: 詳細的用戶端日誌記錄。
