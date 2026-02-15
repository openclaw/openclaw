---
summary: "直接執行 `openclaw agent` CLI（可選擇傳送）"
read_when:
  - 新增或修改智慧代理 CLI 進入點時
title: "智慧代理傳送"
---

# `openclaw agent` (直接執行智慧代理)

`openclaw agent` 會在不需要傳入聊天訊息的情況下執行單次智慧代理輪次。
預設情況下，它會通過 Gateway；加入 `--local` 可強制在當前機器上使用內嵌的執行環境。

## 行為

- 必填：`--message <文字>`
- 工作階段選擇：
  - `--to <目標>` 會衍生出工作階段鍵名（群組/頻道目標會保持隔離；直接對話則會合併到 `main`），**或**
  - `--session-id <ID>` 根據 ID 重用現有的工作階段，**或**
  - `--agent <ID>` 直接指定一個已設定的智慧代理（使用該智慧代理的 `main` 工作階段鍵名）
- 執行與一般傳入回覆相同的內嵌智慧代理執行環境。
- Thinking/verbose 旗標會持久化到工作階段儲存中。
- 輸出：
  - 預設：列印回覆文字（加上 `MEDIA:<url>` 行）
  - `--json`：列印結構化的負載 (payload) 與元數據 (metadata)
- 可選：透過 `--deliver` + `--channel` 將回覆傳回頻道（目標格式與 `openclaw message --target` 相同）。
- 使用 `--reply-channel`/`--reply-to`/`--reply-account` 來覆蓋傳送設定而不更改工作階段。

如果無法連線至 Gateway，CLI 會**回退 (fall back)** 到內嵌的本地執行。

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

- `--local`：在本地執行（需要在您的 shell 中提供模型供應商的 API 金鑰）
- `--deliver`：將回覆傳送到所選頻道
- `--channel`：傳送頻道 (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`，預設：`whatsapp`)
- `--reply-to`：覆蓋傳送目標
- `--reply-channel`：覆蓋傳送頻道
- `--reply-account`：覆蓋傳送帳號 ID
- `--thinking <off|minimal|low|medium|high|xhigh>`：持久化思考等級（僅限 GPT-5.2 + Codex 模型）
- `--verbose <on|full|off>`：持久化詳細程度等級
- `--timeout <秒數>`：覆蓋智慧代理逾時時間
- `--json`：輸出結構化 JSON
