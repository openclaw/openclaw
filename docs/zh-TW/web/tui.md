---
summary: "終端機 UI（TUI）：從任何機器連線到 Gateway 閘道器"
read_when:
  - 你想要一份適合初學者的 TUI 操作導覽
  - 你需要完整的 TUI 功能、指令與快捷鍵清單
title: "TUI"
---

# TUI（Terminal UI）

## 快速開始

1. 啟動 Gateway.

```bash
openclaw gateway
```

2. 開啟 TUI。

```bash
openclaw tui
```

3. 19. 輸入訊息並按 Enter。

遠端 Gateway 閘道器：

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

如果你的 Gateway 閘道器使用密碼驗證，請使用 `--password`。

## 你會看到的內容

- 20. 標頭：連線 URL、目前代理、目前工作階段。
- 對話記錄：使用者訊息、助理回覆、系統通知、工具卡片。
- 狀態列：連線／執行狀態（connecting、running、streaming、idle、error）。
- 頁尾：連線狀態 + 代理程式 + 工作階段 + 模型 + 思考／詳細／推理 + 權杖計數 + deliver。
- 21. 輸入區：具自動完成的文字編輯器。

## 心智模型：代理程式 + 工作階段

- Agents are unique slugs (e.g. `main`, `research`). The Gateway exposes the list.
- 24. 工作階段隸屬於目前的代理。
- 工作階段金鑰會以 `agent:<agentId>:<sessionKey>` 儲存。
  - 如果你輸入 `/session main`，TUI 會將其展開為 `agent:<currentAgent>:main`。
  - 如果你輸入 `/session agent:other:main`，你會明確切換到該代理程式的工作階段。
- 25. 工作階段範圍：
  - 26. `per-sender`（預設）：每個代理可有多個工作階段。
  - `global`：TUI 一律使用 `global` 工作階段（選擇器可能是空的）。
- 27. 目前的代理 + 工作階段會始終顯示在頁尾。

## 傳送 + 投遞

- 28. 訊息會送至 Gateway；預設不會轉送到供應商。
- 開啟投遞：
  - `/deliver on`
  - 或使用設定面板
  - 或在啟動時加入 `openclaw tui --deliver`

## 選擇器 + 覆蓋層

- Model picker: list available models and set the session override.
- Agent picker: choose a different agent.
- 31. 工作階段選擇器：僅顯示目前代理的工作階段。
- 設定：切換投遞、工具輸出展開，以及思考可見性。

## 鍵盤快捷鍵

- Enter：傳送訊息
- Esc：中止進行中的執行
- Ctrl+C：清除輸入（按兩次退出）
- Ctrl+D：退出
- Ctrl+L：模型選擇器
- Ctrl+G：代理程式選擇器
- Ctrl+P: session picker
- Ctrl+O：切換工具輸出展開
- Ctrl+T：切換思考可見性（會重新載入歷史）

## 斜線指令

核心：

- `/help`
- `/status`
- `/agent <id>`（或 `/agents`）
- `/session <key>`（或 `/sessions`）
- `/model <provider/model>`（或 `/models`）

Session controls:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>`（別名：`/elev`）
- `/activation <mention|always>`
- `/deliver <on|off>`

34. 工作階段生命週期：

- `/new` 或 `/reset`（重設工作階段）
- `/abort`（中止進行中的執行）
- `/settings`
- `/exit`

其他 Gateway 閘道器斜線指令（例如 `/context`）會轉送至 Gateway 閘道器，並以系統輸出顯示。請參閱 [Slash commands](/tools/slash-commands)。 35. 請參閱 [斜線指令](/tools/slash-commands)。

## 36. 本地 shell 指令

- 在一行前加上 `!`，即可在 TUI 主機上執行本機殼層指令。
- The TUI prompts once per session to allow local execution; declining keeps `!` disabled for the session.
- 指令會在 TUI 工作目錄中的全新、非互動式殼層執行（不會保留 `cd`/env）。
- 38. 單獨的 `!` 會作為一般訊息送出；前置空白不會觸發本地執行。

## 工具輸出

- 工具呼叫會以卡片顯示，包含引數 + 結果。
- Ctrl+O 可在收合／展開檢視之間切換。
- 工具執行期間，部分更新會串流到同一張卡片中。

## 歷史 + 串流

- 39. 連線時，TUI 會載入最新的歷史紀錄（預設 200 則訊息）。
- 串流回應會即時更新，直到完成。
- TUI 也會監聽代理程式的工具事件，以呈現更豐富的工具卡片。

## 40. 連線詳細資訊

- TUI 會以 `mode: "tui"` 的身分向 Gateway 閘道器註冊。
- 41. 重新連線會顯示系統訊息；事件間隙會在日誌中呈現。

## 選項

- `--url <url>`：Gateway 閘道器 WebSocket URL（預設取自設定或 `ws://127.0.0.1:<port>`）
- `--token <token>`：Gateway 閘道器權杖（若需要）
- `--password <password>`：Gateway 閘道器密碼（若需要）
- `--session <key>`：工作階段金鑰（預設：`main`，或在全域範圍時為 `global`）
- `--deliver`：將助理回覆投遞到提供者（預設關閉）
- `--thinking <level>`：傳送時覆寫思考層級
- `--timeout-ms <ms>`：代理程式逾時（毫秒）（預設為 `agents.defaults.timeoutSeconds`）

注意：當你設定 `--url` 時，TUI 不會回退使用設定或環境中的認證。
請明確傳入 `--token` 或 `--password`。缺少明確的認證會視為錯誤。
42. 明確傳入 `--token` 或 `--password`。 43. 缺少明確的認證會被視為錯誤。

## 44. 疑難排解

傳送訊息後沒有輸出：

- 在 TUI 中執行 `/status`，確認 Gateway 閘道器已連線且為 idle／busy。
- 檢查 Gateway 閘道器記錄：`openclaw logs --follow`。
- 確認代理程式可以執行：`openclaw status` 與 `openclaw models status`。
- 若你預期訊息會出現在聊天頻道，請啟用投遞（`/deliver on` 或 `--deliver`）。
- `--history-limit <n>`：要載入的歷史筆數（預設 200）

## 45. 連線疑難排解

- `disconnected`：確保 Gateway 閘道器正在執行，且你的 `--url/--token/--password` 正確。
- 選擇器中沒有代理程式：檢查 `openclaw agents list` 與你的路由設定。
- 46. 工作階段選擇器為空：你可能在全域範圍，或尚未有任何工作階段。
