---
summary: "終端使用者介面 (TUI)：從任何機器連接到 Gateway"
read_when:
  - 您想要一份 TUI 的新手友善指南
  - 您需要一份完整的 TUI 功能、指令和快捷鍵列表
title: "TUI"
---

# TUI (終端使用者介面)

## 快速開始

1. 啟動 Gateway。

```bash
openclaw gateway
```

2. 開啟 TUI。

```bash
openclaw tui
```

3. 輸入一則訊息並按下 Enter。

遠端 Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

如果您的 Gateway 使用密碼驗證，請使用 `--password`。

## 您所看到的

- 標頭：連接 URL、目前的智慧代理、目前的工作階段。
- 聊天紀錄：使用者訊息、助理回覆、系統通知、工具卡片。
- 狀態列：連接/執行狀態（連接中、執行中、串流中、閒置、錯誤）。
- 頁腳：連接狀態 + 智慧代理 + 工作階段 + 模型 + 思考/詳細/推論 + 權杖計數 + 遞送。
- 輸入：具備自動完成功能的文字編輯器。

## 心智模型：智慧代理 + 工作階段

- 智慧代理是唯一的 slug（例如 `main`、`research`）。Gateway 會公開此列表。
- 工作階段屬於目前的智慧代理。
- 工作階段鍵名儲存為 `agent:<agentId>:<sessionKey>`。
  - 如果您輸入 `/session main`，TUI 會將其展開為 `agent:<currentAgent>:main`。
  - 如果您輸入 `/session agent:other:main`，您會明確切換到該智慧代理工作階段。
- 工作階段範圍：
  - `per-sender` (預設)：每個智慧代理擁有多個工作階段。
  - `global`：TUI 總是使用 `global` 工作階段（選擇器可能為空）。
- 目前的智慧代理 + 工作階段始終顯示在頁腳。

## 傳送 + 遞送

- 訊息會傳送至 Gateway；預設情況下，遞送至供應商的功能已關閉。
- 開啟遞送功能：
  - `/deliver on`
  - 或設定面板
  - 或使用 `openclaw tui --deliver` 啟動

## 選擇器 + 疊加層

- 模型選擇器：列出可用的模型並設定工作階段覆寫。
- 智慧代理選擇器：選擇不同的智慧代理。
- 工作階段選擇器：僅顯示目前智慧代理的工作階段。
- 設定：切換遞送、工具輸出展開和思考可見性。

## 鍵盤快捷鍵

- Enter：傳送訊息
- Esc：中止正在執行的操作
- Ctrl+C：清除輸入（按兩次退出）
- Ctrl+D：退出
- Ctrl+L：模型選擇器
- Ctrl+G：智慧代理選擇器
- Ctrl+P：工作階段選擇器
- Ctrl+O：切換工具輸出展開
- Ctrl+T：切換思考可見性（重新載入歷史紀錄）

## 斜線指令

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
- `/abort` (中止正在執行的操作)
- `/settings`
- `/exit`

其他 Gateway 斜線指令（例如 `/context`）會轉發至 Gateway 並顯示為系統輸出。請參閱 [斜線指令](/tools/slash-commands)。

## 本機殼層指令

- 在行首加上 `!` 即可在 TUI 主機上執行本機殼層指令。
- TUI 會在每個工作階段提示一次以允許本機執行；拒絕則會使 `!` 在該工作階段中保持禁用。
- 指令會在 TUI 工作目錄中以一個全新的、非互動式的殼層執行（沒有持久的 `cd`/環境變數）。
- 單獨的 `!` 會作為普通訊息傳送；開頭的空格不會觸發本機執行。

## 工具輸出

- 工具呼叫會以卡片形式顯示，包含參數 + 結果。
- Ctrl+O 可切換折疊/展開視圖。
- 當工具執行時，部分更新會串流至同一張卡片中。

## 歷史紀錄 + 串流

- 連接時，TUI 會載入最新的歷史紀錄（預設 200 則訊息）。
- 串流回應會就地更新，直到完成。
- TUI 也會監聽智慧代理工具事件，以提供更豐富的工具卡片。

## 連接詳細資訊

- TUI 會以 `mode: "tui"` 向 Gateway 註冊。
- 重新連接會顯示系統訊息；事件間隙會在日誌中顯示。

## 選項

- `--url <url>`：Gateway WebSocket URL（預設為設定或 `ws://127.0.0.1:<port>`）
- `--token <token>`：Gateway 訪問令牌（如果需要）
- `--password <password>`：Gateway 密碼（如果需要）
- `--session <key>`：工作階段鍵名（預設為 `main`，或當範圍為 `global` 時為 `global`）
- `--deliver`：將助理回覆遞送給供應商（預設關閉）
- `--thinking <level>`：覆寫傳送時的思考等級
- `--timeout-ms <ms>`：智慧代理逾時時間（毫秒）（預設為 `agents.defaults.timeoutSeconds`）

注意：當您設定 `--url` 時，TUI 不會回退到設定或環境憑證。
明確傳遞 `--token` 或 `--password`。缺少明確的憑證會導致錯誤。

## 疑難排解

傳送訊息後沒有輸出：

- 在 TUI 中執行 `/status` 以確認 Gateway 已連接且閒置/忙碌中。
- 檢查 Gateway 日誌：`openclaw logs --follow`。
- 確認智慧代理可以運行：`openclaw status` 和 `openclaw models status`。
- 如果您預期聊天頻道中有訊息，請啟用遞送（`/deliver on` 或 `--deliver`）。
- `--history-limit <n>`：要載入的歷史紀錄條目（預設 200）

## 連線疑難排解

- `disconnected`：確保 Gateway 正在運行，並且您的 `--url/--token/--password` 正確。
- 選擇器中沒有智慧代理：檢查 `openclaw agents list` 和您的路由設定。
- 空的工作階段選擇器：您可能處於全域範圍或尚未有任何工作階段。
