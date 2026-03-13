---
summary: "Logging surfaces, file logs, WS log styles, and console formatting"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
title: Logging
---

# Logging

對於用戶界面的概述（CLI + 控制介面 + 設定），請參見 [/logging](/logging)。

OpenClaw 有兩個日誌“表面”：

- **控制台輸出**（您在終端機 / 除錯 UI 中看到的內容）。
- **檔案日誌**（JSON 行）由網關記錄器寫入。

## 檔案基礎的日誌記錄器

- 預設的滾動日誌檔案位於 `/tmp/openclaw/`（每天一個檔案）：`openclaw-YYYY-MM-DD.log`
  - 日期使用閘道主機的當地時區。
- 日誌檔案的路徑和級別可以透過 `~/.openclaw/openclaw.json` 進行設定：
  - `logging.file`
  - `logging.level`

檔案格式為每行一個 JSON 物件。

控制 UI 日誌標籤透過網關 (`logs.tail`) 尾隨此檔案。CLI 也可以做到相同的事情：

```bash
openclaw logs --follow
```

**詳細模式與日誌等級**

- **檔案日誌**僅由 `logging.level` 控制。
- `--verbose` 只影響 **控制台詳細程度**（以及 WS 日誌樣式）；它並不會
  提高檔案日誌的級別。
- 若要在檔案日誌中捕捉僅詳細的資訊，請將 `logging.level` 設定為 `debug` 或
  `trace`。

## Console capture

CLI 捕捉 `console.log/info/warn/error/debug/trace` 並將其寫入檔案日誌，同時仍然輸出到 stdout/stderr。

您可以透過以下方式獨立調整控制台的詳細程度：

- `logging.consoleLevel` (預設 `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Tool summary redaction

冗長的工具摘要（例如 `🛠️ Exec: ...`）可以在敏感 token 到達控制台流之前進行遮蔽。這是**僅限工具**的功能，並不會改變檔案日誌。

- `logging.redactSensitive`: `off` | `tools` (預設: `tools`)
- `logging.redactPatterns`: 正則表達式字串陣列（覆蓋預設值）
  - 使用原始正則表達式字串（自動 `gi`），或 `/pattern/flags` 如果您需要自訂標誌。
  - 匹配項會通過保留前 6 個 + 後 4 個字元來進行遮蔽（長度 >= 18），否則 `***`。
  - 預設值涵蓋常見的金鑰指派、CLI 標誌、JSON 欄位、承載標頭、PEM 區塊和流行的 token 前綴。

## Gateway WebSocket 日誌

網關以兩種模式列印 WebSocket 協議日誌：

- **正常模式 (無 `--verbose`)**：僅列印「有趣的」RPC 結果：
  - 錯誤 (`ok=false`)
  - 慢速呼叫 (預設閾值：`>= 50ms`)
  - 解析錯誤
- **詳細模式 (`--verbose`)**：列印所有 WS 請求/回應流量。

### WS 日誌風格

`openclaw gateway` 支援每個閘道的樣式切換：

- `--ws-log auto` (預設): 正常模式已優化；詳細模式使用緊湊輸出
- `--ws-log compact`: 詳細模式下的緊湊輸出（配對請求/回應）
- `--ws-log full`: 詳細模式下的每幀完整輸出
- `--compact`: `--ws-log compact` 的別名

範例：

bash

# 優化過的（僅錯誤/緩慢）

openclaw gateway

# 顯示所有 WS 流量（配對）

openclaw gateway --verbose --ws-log compact

# 顯示所有 WS 流量（完整元數據）

openclaw gateway --verbose --ws-log full

## Console formatting (subsystem logging)

控制台格式器是 **TTY-aware**，並且印出一致的、帶前綴的行。子系統記錄器保持輸出分組且易於掃描。

[[BLOCK_1]]

- **子系統前綴** 每行都有 (例如 `[gateway]`, `[canvas]`, `[tailscale]`)
- **子系統顏色** (每個子系統穩定) 以及等級顏色
- **當輸出為 TTY 或環境看起來像豐富終端時的顏色** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), 尊重 `NO_COLOR`
- **縮短的子系統前綴**: 刪除前導 `gateway/` + `channels/`, 保留最後 2 個段落 (例如 `whatsapp/outbound`)
- **按子系統的子日誌記錄器** (自動前綴 + 結構化欄位 `{ subsystem }`)
- **`logRaw()`** 用於 QR/UX 輸出 (無前綴，無格式)
- **控制台樣式** (例如 `pretty | compact | json`)
- **控制台日誌等級** 與文件日誌等級分開 (當 `logging.level` 設定為 `debug`/`trace` 時，文件保留完整細節)
- **WhatsApp 訊息內容** 在 `debug` 記錄 (使用 `--verbose` 來查看它們)

這樣可以保持現有的檔案日誌穩定，同時使互動輸出更易於掃描。
