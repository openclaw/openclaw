```
---
summary: "直接執行 `openclaw agent` CLI (可選遞送)"
read_when:
  - 新增或修改 agent CLI 進入點
title: "智慧代理傳送"
---

# `openclaw agent` (直接執行智慧代理)

`openclaw agent` 執行單次智慧代理輪次，無需入站聊天訊息。
預設情況下，它會**透過 Gateway**；新增 `--local` 以強制在目前機器上使用內嵌的執行階段。

## 行為

- 必填：`--message <text>`
- 工作階段選取：
  - `--to <dest>` 產生工作階段鍵 (群組/頻道目標會保留隔離；直接聊天會合併到 `main`)，**或**
  - `--session-id <id>` 透過 ID 重複使用現有工作階段，**或**
  - `--agent <id>` 直接針對設定好的智慧代理 (使用該智慧代理的 `main` 工作階段鍵)
- 執行與一般入站回覆相同的內嵌智慧代理執行階段。
- 思考/詳細旗標會保留在工作階段儲存中。
- 輸出：
  - 預設：列印回覆文字 (加上 `MEDIA:<url>` 行)
  - `--json`：列印結構化酬載 + 中繼資料
- 可選的遞送功能，使用 `--deliver` + `--channel` 遞送回頻道 (目標格式與 `openclaw message --target` 相符)。
- 使用 `--reply-channel`/`--reply-to`/`--reply-account` 覆寫遞送，而無需變更工作階段。

如果 Gateway 無法連線，CLI 會**退回**到內嵌的本地執行。

## 範例

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 旗標

- `--local`：本地執行 (需要您的 shell 中有模型供應商 API 鍵)
- `--deliver`：將回覆傳送到所選頻道
- `--channel`：遞送頻道 (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`，預設：`whatsapp`)
- `--reply-to`：遞送目標覆寫
- `--reply-channel`：遞送頻道覆寫
- `--reply-account`：遞送帳戶 ID 覆寫
- `--thinking <off|minimal|low|medium|high|xhigh>`：保留思考等級 (僅限 GPT-5.2 + Codex 模型)
- `--verbose <on|full|off>`：保留詳細等級
- `--timeout <seconds>`：覆寫智慧代理逾時
- `--json`：輸出結構化 JSON
```
