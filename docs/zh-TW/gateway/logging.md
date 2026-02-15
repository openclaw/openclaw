---
summary: "紀錄介面、檔案紀錄、WS 紀錄樣式以及主控台格式化"
read_when:
  - 更改紀錄輸出或格式
  - 除錯 CLI 或 gateway 輸出
title: "紀錄"
---

# 紀錄

關於使用者面向的總覽（CLI + 控制 UI + 設定），請參閱 [/logging](/logging)。

OpenClaw 有兩個紀錄「介面」（surfaces）：

- **主控台輸出**（你在終端機 / 除錯 UI 中看到的內容）。
- **檔案紀錄**（JSON lines），由 gateway 紀錄器寫入。

## 以檔案為基礎的紀錄器

- 預設的滾動紀錄檔位於 `/tmp/openclaw/`（每天一個檔案）：`openclaw-YYYY-MM-DD.log`
  - 日期使用 gateway 主機的本地時區。
- 紀錄檔路徑和等級可以透過 `~/.openclaw/openclaw.json` 進行設定：
  - `logging.file`
  - `logging.level`

檔案格式為每行一個 JSON 物件。

控制 UI 的「紀錄」標籤頁透過 gateway (`logs.tail`) 即時追蹤此檔案。
CLI 也可以執行相同操作：

```bash
openclaw logs --follow
```

**詳細模式 vs. 紀錄等級**

- **檔案紀錄**僅受 `logging.level` 控制。
- `--verbose` 僅影響**主控台詳細程度**（以及 WS 紀錄樣式）；它**不會**提升檔案紀錄等級。
- 若要在檔案紀錄中擷取僅限詳細模式的細節，請將 `logging.level` 設定為 `debug` 或 `trace`。

## 主控台擷取

CLI 會擷取 `console.log/info/warn/error/debug/trace` 並將其寫入檔案紀錄，同時仍會輸出到 stdout/stderr。

你可以透過以下方式獨立調整主控台詳細程度：

- `logging.consoleLevel`（預設為 `info`）
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## 工具摘要隱藏

詳細的工具摘要（例如 `🛠️ Exec: ...`）可以在進入主控台串流之前遮蓋敏感權杖（tokens）。這**僅限於工具**，不會更改檔案紀錄。

- `logging.redactSensitive`: `off` | `tools`（預設：`tools`）
- `logging.redactPatterns`: regex 字串陣列（覆蓋預設值）
  - 使用原始 regex 字串（自動套用 `gi`），或在需要自訂旗標時使用 `/pattern/flags`。
  - 符合項目的遮蓋方式為保留前 6 個和後 4 個字元（長度 >= 18），否則顯示為 `***`。
  - 預設值涵蓋常見的金鑰分配、CLI 旗標、JSON 欄位、bearer 標頭、PEM 區塊和熱門權杖前綴。

## Gateway WebSocket 紀錄

Gateway 以兩種模式輸出 WebSocket 協定紀錄：

- **一般模式（無 `--verbose`）**：僅輸出「有趣」的 RPC 結果：
  - 錯誤 (`ok=false`)
  - 慢速呼叫（預設門檻：`>= 50ms`）
  - 剖析錯誤
- **詳細模式 (`--verbose`)**：輸出所有 WS 請求/回應流量。

### WS 紀錄樣式

`openclaw gateway` 支援個別 gateway 的樣式切換：

- `--ws-log auto`（預設）：一般模式會進行最佳化；詳細模式使用精簡輸出
- `--ws-log compact`：詳細模式時使用精簡輸出（成對的請求/回應）
- `--ws-log full`：詳細模式時使用完整每幀（per-frame）輸出
- `--compact`：`--ws-log compact` 的別名

範例：

```bash
# 最佳化（僅限錯誤/慢速呼叫）
openclaw gateway

# 顯示所有 WS 流量（成對）
openclaw gateway --verbose --ws-log compact

# 顯示所有 WS 流量（完整元數據）
openclaw gateway --verbose --ws-log full
```

## 主控台格式化（子系統紀錄）

主控台格式化器具備 **TTY 感知能力**，並輸出一致的、帶有前綴的行。
子系統紀錄器保持輸出分組且易於掃描。

行為：

- 每行都有**子系統前綴**（例如 `[gateway]`、`[canvas]`、`[tailscale]`）
- **子系統顏色**（每個子系統固定）以及等級著色
- **當輸出為 TTY 或環境看起來像進階終端機時顯示顏色** (`TERM`/`COLORTERM`/`TERM_PROGRAM`)，並遵守 `NO_COLOR`
- **縮短子系統前綴**：捨棄開頭的 `gateway/` + `channels/`，保留最後 2 個區段（例如 `whatsapp/outbound`）
- **按子系統劃分的子紀錄器**（自動前綴 + 結構化欄位 `{ subsystem }`）
- **`logRaw()`** 用於 QR/UX 輸出（無前綴，無格式化）
- **主控台樣式**（例如 `pretty | compact | json`）
- **主控台紀錄等級**與檔案紀錄等級分開（當 `logging.level` 設定為 `debug`/`trace` 時，檔案會保留完整細節）
- **WhatsApp 訊息主體**以 `debug` 等級記錄（使用 `--verbose` 即可查看）

這能在保持現有檔案紀錄穩定的同時，讓互動式輸出易於掃描。
