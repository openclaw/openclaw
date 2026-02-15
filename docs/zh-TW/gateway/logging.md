---
summary: "日誌介面、檔案日誌、WS 日誌樣式和主控台格式"
read_when:
  - 變更日誌輸出或格式
  - 偵錯 CLI 或 Gateway輸出
title: "日誌"
---

# 日誌

關於使用者導向的總覽 (CLI + Control UI + 設定)，請參閱 [/logging](/logging)。

OpenClaw 有兩種日誌「介面」：

- **主控台輸出** (您在終端機 / Debug UI 中看到的內容)。
- **檔案日誌** (JSON 行) 由 Gateway日誌記錄器寫入。

## 檔案型日誌記錄器

- 預設的滾動日誌檔案位於 `/tmp/openclaw/` (每天一個檔案)：`openclaw-YYYY-MM-DD.log`
  - 日期使用 Gateway主機的當地時區。
- 日誌檔案路徑和層級可透過 `~/.openclaw/openclaw.json` 設定：
  - `logging.file`
  - `logging.level`

檔案格式為每行一個 JSON 物件。

Control UI 的日誌頁籤透過 Gateway (`logs.tail`) 追蹤此檔案。CLI 也能執行相同操作：

```bash
openclaw logs --follow
```

**詳細模式與日誌層級**

- **檔案日誌**完全由 `logging.level` 控制。
- `--verbose` 僅影響**主控台詳細程度** (和 WS 日誌樣式)；它**不會**提高檔案日誌層級。
- 若要在檔案日誌中擷取僅詳細模式的詳細資訊，請將 `logging.level` 設為 `debug` 或 `trace`。

## 主控台擷取

CLI 會擷取 `console.log/info/warn/error/debug/trace` 並將其寫入檔案日誌，同時仍會列印到 stdout/stderr。

您可以透過以下方式獨立調整主控台詳細程度：

- `logging.consoleLevel` (預設 `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## 工具摘要遮蔽

詳細的工具摘要 (例如 `🛠️ Exec: ...`) 可以在敏感權杖進入主控台串流之前將其遮蔽。這**僅限工具**，不會變更檔案日誌。

- `logging.redactSensitive`：`off` | `tools` (預設：`tools`)
- `logging.redactPatterns`：正規表達式字串陣列 (覆寫預設值)
  - 使用原始正規表達式字串 (自動 `gi`)，或 `/pattern/flags` 如果您需要自訂標誌。
  - 符合項的遮蔽方式是保留前 6 個字元 + 後 4 個字元 (長度 >= 18)，否則為 `***`。
  - 預設值涵蓋常見的鍵名指派、CLI 標誌、JSON 欄位、Bearer 標頭、PEM 區塊和常見權杖前綴。

## Gateway WebSocket 日誌

Gateway以兩種模式列印 WebSocket 協定日誌：

- **一般模式 (無 `--verbose`)**：僅列印「有趣」的 RPC 結果：
  - 錯誤 (`ok=false`)
  - 慢速呼叫 (預設閾值：`>= 50ms`)
  - 解析錯誤
- **詳細模式 (`--verbose`)**：列印所有 WS 請求/回應流量。

### WS 日誌樣式

`openclaw gateway` 支援每個 Gateway的樣式切換：

- `--ws-log auto` (預設)：一般模式已最佳化；詳細模式使用精簡輸出
- `--ws-log compact`：當處於詳細模式時使用精簡輸出 (配對的請求/回應)
- `--ws-log full`：當處於詳細模式時使用完整的每幀輸出
- `--compact`：`--ws-log compact` 的別名

範例：

```bash
# 已最佳化 (僅錯誤/慢速)
openclaw gateway

# 顯示所有 WS 流量 (配對)
openclaw gateway --verbose --ws-log compact

# 顯示所有 WS 流量 (完整中繼資料)
openclaw gateway --verbose --ws-log full
```

## 主控台格式化 (子系統日誌記錄)

主控台格式器具有 **TTY 感知能力**，並列印一致且帶有前綴的行。子系統日誌記錄器保持輸出分組且易於掃描。

行為：

- **子系統前綴** 在每一行上 (例如 `[gateway]`、`[canvas]`、`[tailscale]`)
- **子系統顏色** (每個子系統穩定) 加上層級著色
- **當輸出是 TTY 或環境看起來像豐富終端機時著色** (`TERM`/`COLORTERM`/`TERM_PROGRAM`)，遵循 `NO_COLOR`
- **縮短的子系統前綴**：捨棄開頭的 `gateway/` + `channels/`，保留最後 2 個片段 (例如 `whatsapp/outbound`)
- **按子系統的子記錄器** (自動前綴 + 結構化欄位 `{ subsystem }`)
- **`logRaw()`** 用於 QR/UX 輸出 (無前綴，無格式化)
- **主控台樣式** (例如 `pretty | compact | json`)
- **主控台日誌層級** 與檔案日誌層級分開 (當 `logging.level` 設為 `debug`/`trace` 時，檔案會保留完整詳細資訊)
- **WhatsApp 訊息內文** 會以 `debug` 層級記錄 (使用 `--verbose` 才能查看)

這使得現有的檔案日誌保持穩定，同時使互動式輸出易於掃描。
