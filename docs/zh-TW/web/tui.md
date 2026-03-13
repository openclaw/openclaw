---
summary: "Terminal UI (TUI): connect to the Gateway from any machine"
read_when:
  - You want a beginner-friendly walkthrough of the TUI
  - "You need the complete list of TUI features, commands, and shortcuts"
title: TUI
---

# TUI（終端機介面）

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

遠端 Gateway：

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

如果你的 Gateway 使用密碼驗證，請使用 `--password`。

## 你會看到什麼

- 標頭：連線 URL、目前代理人、目前會話。
- 聊天記錄：使用者訊息、助理回覆、系統通知、工具卡片。
- 狀態列：連線/執行狀態（連線中、執行中、串流中、閒置、錯誤）。
- 頁尾：連線狀態 + 代理人 + 會話 + 模型 + 思考/快速/詳細/推理 + token 計數 + 傳送。
- 輸入區：具自動完成功能的文字編輯器。

## 心智模型：代理人 + 會話

- 代理人是唯一的標識符（例如 `main`、`research`）。Gateway 會提供清單。
- 會話屬於目前的代理人。
- 會話金鑰儲存為 `agent:<agentId>:<sessionKey>`。
  - 如果你輸入 `/session main`，TUI 會展開成 `agent:<currentAgent>:main`。
  - 如果你輸入 `/session agent:other:main`，你會明確切換到該代理人會話。
- 會話範圍：
  - `per-sender`（預設）：每個代理人有多個會話。
  - `global`：TUI 永遠使用 `global` 會話（選擇器可能是空的）。
- 目前的代理人 + 會話會一直顯示在頁尾。

## 傳送 + 傳遞

- 訊息會傳送到 Gateway；預設不會送達提供者。
- 開啟送達功能：
  - `/deliver on`
  - 或在設定面板中
  - 或從 `openclaw tui --deliver` 開始

## 選擇器 + 覆蓋層

- 模型選擇器：列出可用模型並設定會話覆寫。
- 代理選擇器：選擇不同的代理。
- 會話選擇器：只顯示目前代理的會話。
- 設定：切換送達、工具輸出展開與思考可見性。

## 鍵盤快速鍵

- Enter：送出訊息
- Esc：中止執行中的任務
- Ctrl+C：清除輸入（連按兩次退出）
- Ctrl+D：退出
- Ctrl+L：模型選擇器
- Ctrl+G：代理選擇器
- Ctrl+P：會話選擇器
- Ctrl+O：切換工具輸出展開
- Ctrl+T：切換思考可見性（重新載入歷史）

## 斜線指令

核心：

- `/help`
- `/status`
- `/agent <id>`（或 `/agents`）
- `/session <key>`（或 `/sessions`）
- `/model <provider/model>`（或 `/models`）

會話控制：

- `/think <off|minimal|low|medium|high>`
- `/fast <status|on|off>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>`（別名：`/elev`）
- `/activation <mention|always>`
- `/deliver <on|off>`

會話生命週期：

- `/new` 或 `/reset`（重置會話）
- `/abort`（中止執行中的任務）
- `/settings`
- `/exit`

其他 Gateway 斜線指令（例如 `/context`）會轉發至 Gateway 並以系統輸出顯示。詳見 [斜線指令](/tools/slash-commands)。

## 本地 shell 指令

- 在行首加上 `!` 以在 TUI 主機上執行本地 shell 指令。
- TUI 每個會話會提示一次是否允許本地執行；拒絕後該會話內 `!` 會保持停用。
- 指令在新的非互動式 shell 中執行，工作目錄為 TUI 目錄（無持續的 `cd`/環境）。
- 本地 shell 指令會在環境中接收 `OPENCLAW_SHELL=tui-local`。
- 單獨的 `!` 會當作一般訊息送出；前置空白不會觸發本地執行。

- 工具呼叫以卡片形式顯示，包含參數與結果。
- Ctrl+O 可切換卡片的摺疊/展開視圖。
- 工具執行時，部分更新會持續串流至同一張卡片。

## 終端機顏色

- TUI 將助理主體文字維持在終端機預設的前景色，讓深色與淺色終端機皆易於閱讀。
- 若您的終端機使用淺色背景且自動偵測錯誤，請在啟動 `openclaw tui` 前設定 `OPENCLAW_THEME=light`。
- 若要強制使用原本的深色調色盤，請設定 `OPENCLAW_THEME=dark`。

## 歷史紀錄與串流

- 連線時，TUI 會載入最新的歷史紀錄（預設為 200 則訊息）。
- 串流回應會在原位更新直到完成。
- TUI 也會監聽代理工具事件，以呈現更豐富的工具卡片。

## 連線細節

- TUI 以 `mode: "tui"` 身份向 Gateway 註冊。
- 重新連線時會顯示系統訊息；事件中斷會在日誌中呈現。

## 選項

- `--url <url>`：Gateway WebSocket URL（預設為設定檔或 `ws://127.0.0.1:<port>`）
- `--token <token>`：Gateway token（如有需要）
- `--password <password>`：Gateway 密碼（如有需要）
- `--session <key>`：會話金鑰（預設為 `main`，全域範圍時為 `global`）
- `--deliver`：將助理回覆傳送給提供者（預設關閉）
- `--thinking <level>`：覆寫發送時的思考層級
- `--timeout-ms <ms>`：代理逾時時間（毫秒，預設為 `agents.defaults.timeoutSeconds`）

注意：當您設定 `--url` 時，TUI 不會回退使用設定檔或環境憑證。
請明確傳入 `--token` 或 `--password`。缺少明確憑證會導致錯誤。

## 疑難排解

發送訊息後無輸出：

- 在 TUI 執行 `/status` 以確認 Gateway 是否已連線且閒置/忙碌中。
- 檢查 Gateway 日誌：`openclaw logs --follow`。
- 確認代理能正常執行：`openclaw status` 與 `openclaw models status`。
- 若預期在聊天頻道收到訊息，請啟用傳送功能（`/deliver on` 或 `--deliver`）。
- `--history-limit <n>`：要載入的歷史紀錄條目數（預設 200）

## 連線疑難排解

- `disconnected`：確保 Gateway 正在執行，且您的 `--url/--token/--password` 是正確的。
- 選擇器中沒有代理：請檢查 `openclaw agents list` 以及您的路由設定。
- 選擇器為空：您可能處於全域範圍，或尚未有任何會話。
