---
summary: Direct `openclaw agent` CLI runs (with optional delivery)
read_when:
  - Adding or modifying the agent CLI entrypoint
title: Agent Send
---

# `openclaw agent`（直接代理執行）

`openclaw agent` 執行單一代理回合，無需接收進來的聊天訊息。
預設會 **透過 Gateway**；加入 `--local` 可強制使用當前機器上的內嵌執行環境。

## 行為

- 必填：`--message <text>`
- 會話選擇：
  - `--to <dest>` 推導會話金鑰（群組/頻道目標保持隔離；直接聊天會合併為 `main`），**或**
  - `--session-id <id>` 透過 ID 重用現有會話，**或**
  - `--agent <id>` 直接指定已設定的代理（使用該代理的 `main` 會話金鑰）
- 執行與一般進來回覆相同的內嵌代理執行環境。
- 思考/詳細標誌會持續保存在會話存儲中。
- 輸出：
  - 預設：列印回覆文字（加上 `MEDIA:<url>` 行）
  - `--json`：列印結構化負載與元資料
- 可選擇使用 `--deliver` + `--channel` 回傳至頻道（目標格式與 `openclaw message --target` 相符）。
- 使用 `--reply-channel`/`--reply-to`/`--reply-account` 可覆寫傳送設定而不改變會話。

若 Gateway 無法連線，CLI 會 **回退** 至內嵌本地執行。

## 範例

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 參數旗標

- `--local`：本地執行（需在 shell 中設定模型提供者 API 金鑰）
- `--deliver`：將回覆送至指定頻道
- `--channel`：傳送頻道（`whatsapp|telegram|discord|googlechat|slack|signal|imessage`，預設：`whatsapp`）
- `--reply-to`：覆寫傳送目標
- `--reply-channel`：覆寫傳送頻道
- `--reply-account`：覆寫傳送帳號 ID
- `--thinking <off|minimal|low|medium|high|xhigh>`：持續保存思考層級（僅限 GPT-5.2 + Codex 模型）
- `--verbose <on|full|off>`：持續保存詳細層級
- `--timeout <seconds>`：覆寫代理逾時時間
- `--json`：輸出結構化 JSON
