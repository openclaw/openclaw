---
summary: "終端機介面 (TUI)：從任何機器連線到 Gateway"
read_when:
  - 您想要一份適合初學者的 TUI 導覽
  - 您需要 TUI 功能、命令與快速鍵的完整列表
title: "TUI"
---

# TUI (Terminal UI)

## 快速開始

1. 啟動 Gateway。

```bash
openclaw gateway
```

2. 開啟 TUI。

```bash
openclaw tui
```

3. 輸入訊息並按下 Enter。

遠端 Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

使用 `--password` 如果您的 Gateway 使用密碼驗證。

## 您看到的畫面

- 標頭：連線 URL、目前智慧代理、目前工作階段。
- 對話記錄：使用者訊息、助理回覆、系統通知、工具卡片。
- 狀態列：連線/執行狀態（連線中、執行中、串流傳輸中、閒置、錯誤）。
- 頁尾：連線狀態 + 智慧代理 + 工作階段 + 模型 + 思考/詳細資訊/推論 + Token 計數 + 遞送。
- 輸入框：具備自動補全功能的文字編輯器。

## 概念模型：智慧代理 + 工作階段

- 智慧代理是唯一的代稱 (slugs，例如 `main`、`research`）。Gateway 會公開此列表。
- 工作階段屬於目前的智慧代理。
- 工作階段鍵名儲存為 `agent:<agentId>:<sessionKey>`。
  - 如果您輸入 `/session main`，TUI 會將其展開為 `agent:<currentAgent>:main`。
  - 如果您輸入 `/session agent:other:main`，您將明確切換到該智慧代理的工作階段。
- 工作階段範圍：
  - `per-sender`（預設）：每個智慧代理可以有多個工作階段。
  - `global`：TUI 始終使用 `global` 工作階段（選取器可能為空）。
- 目前的智慧代理 + 工作階段始終顯示在頁尾。

## 傳送與遞送

- 訊息會傳送到 Gateway；預設情況下，遞送至供應商的功能是關閉的。
- 開啟遞送：
  - `/deliver on`
  - 或透過設定面板
  - 或在啟動時加上 `openclaw tui --deliver`

## 選取器與疊加層

- 模型選取器：列出可用模型並設定工作階段覆蓋。
- 智慧代理選取器：選擇不同的智慧代理。
- 工作階段選取器：僅顯示目前智慧代理的工作階段。
- 設定：切換遞送、工具輸出展開以及思考過程顯示。

## 鍵盤快速鍵

- Enter：傳送訊息
- Esc：中止進行中的執行
- Ctrl+C：清除輸入（按兩次退出）
- Ctrl+D：退出
- Ctrl+L：模型選取器
- Ctrl+G：智慧代理選取器
- Ctrl+P：工作階段選取器
- Ctrl+O：切換工具輸出展開
- Ctrl+T：切換思考過程顯示（會重新載入歷史記錄）

## 斜線命令 (Slash commands)

核心：

- `/help`
- `/status`
- `/agent <id>` (或 `/agents`)
- `/session <key>` (或 `/sessions`)
- `/model <provider/model>` (或 `/models`)

工作階段控制：

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (別名：`/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

工作階段生命週期：

- `/new` 或 `/reset` (重設工作階段)
- `/abort` (中止進行中的執行)
- `/settings`
- `/exit`

其他 Gateway 斜線命令（例如 `/context`）會轉發到 Gateway 並顯示為系統輸出。請參閱 [斜線命令](/tools/slash-commands)。

## 本地 Shell 命令

- 在行首加上 `!` 即可在 TUI 主機上執行本地 Shell 命令。
- TUI 每個工作階段會詢問一次是否允許本地執行；拒絕則該工作階段會停用 `!` 功能。
- 命令會在 TUI 工作目錄中以全新的非互動式 Shell 執行（不保留 `cd` 或環境變數）。
- 單獨一個 `!` 會被當作一般訊息傳送；行首空格不會觸發本地執行。

## 工具輸出

- 工具呼叫會顯示為包含參數與結果的卡片。
- Ctrl+O 可在收合/展開檢視之間切換。
- 當工具執行時，部分更新會串流傳輸到同一個卡片中。

## 歷史記錄與串流傳輸

- 連線時，TUI 會載入最新的歷史記錄（預設為 200 則訊息）。
- 串流回覆會在原地更新直到完成。
- TUI 也會監聽智慧代理工具事件，以提供更豐富的工具卡片。

## 連線詳情

- TUI 向 Gateway 註冊為 `mode: "tui"`。
- 重新連線時會顯示系統訊息；事件中斷會出現在記錄中。

## 選項

- `--url <url>`：Gateway WebSocket URL（預設為設定檔案內容或 `ws://127.0.0.1:<port>`）
- `--token <token>`：Gateway token（如果需要）
- `--password <password>`：Gateway 密碼（如果需要）
- `--session <key>`：工作階段鍵名（預設為 `main`，當範圍為 global 時則為 `global`）
- `--deliver`：將助理回覆遞送至供應商（預設為關閉）
- `--thinking <level>`：覆蓋傳送時的思考等級
- `--timeout-ms <ms>`：智慧代理逾時毫秒數（預設為 `agents.defaults.timeoutSeconds`）

注意：當您設定 `--url` 時，TUI 不會退而使用設定檔案或環境變數中的憑證。請明確提供 `--token` 或 `--password`。缺少明確憑證將導致錯誤。

## 疑難排解

傳送訊息後沒有輸出：

- 在 TUI 中執行 `/status` 以確認 Gateway 已連線且處於閒置/忙碌狀態。
- 檢查 Gateway 日誌：`openclaw logs --follow`。
- 確認智慧代理可以執行：`openclaw status` 與 `openclaw models status`。
- 如果您預期在對話頻道中看到訊息，請啟用遞送（`/deliver on` 或 `--deliver`）。
- `--history-limit <n>`：要載入的歷史記錄條目數（預設為 200）

## 連線疑難排解

- `disconnected`：確保 Gateway 正在執行，且您的 `--url/--token/--password` 正確。
- 選取器中沒有智慧代理：檢查 `openclaw agents list` 以及您的路由設定。
- 工作階段選取器為空：您可能處於 global 範圍，或尚未建立任何工作階段。
