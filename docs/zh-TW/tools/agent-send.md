---
summary: "直接執行 `openclaw agent` CLI（可選擇是否傳送）"
read_when:
  - 新增或修改 agent CLI 進入點
title: "Agent 傳送"
x-i18n:
  source_path: tools/agent-send.md
  source_hash: a84d6a304333eebe
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:23Z
---

# `openclaw agent`（直接執行 agent）

`openclaw agent` 可在不需要傳入聊天訊息的情況下，執行一次 agent 回合。
預設會**透過 Gateway 閘道器**；加入 `--local` 可強制在目前機器上使用內嵌
runtime。

## 行為

- 必要項目：`--message <text>`
- 工作階段選擇：
  - `--to <dest>` 會推導工作階段金鑰（群組／頻道目標會保留隔離；私聊會合併為 `main`），**或**
  - `--session-id <id>` 依 id 重用既有工作階段，**或**
  - `--agent <id>` 直接指定已設定的 agent（使用該 agent 的 `main` 工作階段金鑰）
- 執行與一般入站回覆相同的內嵌 agent runtime。
- Thinking／verbose 旗標會持續寫入工作階段儲存。
- 輸出：
  - 預設：列印回覆文字（外加 `MEDIA:<url>` 行）
  - `--json`：列印結構化酬載與中繼資料
- 可使用 `--deliver` + `--channel` 將結果回傳至頻道（目標格式與 `openclaw message --target` 相同）。
- 使用 `--reply-channel`/`--reply-to`/`--reply-account` 可在不變更工作階段的情況下覆寫傳送設定。

若 Gateway 閘道器 無法連線，CLI 會**回退**為內嵌的本機執行。

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

- `--local`：於本機執行（需要在 shell 中設定模型提供者 API 金鑰）
- `--deliver`：將回覆傳送到所選頻道
- `--channel`：傳送頻道（`whatsapp|telegram|discord|googlechat|slack|signal|imessage`，預設：`whatsapp`）
- `--reply-to`：傳送目標覆寫
- `--reply-channel`：傳送頻道覆寫
- `--reply-account`：傳送帳號 id 覆寫
- `--thinking <off|minimal|low|medium|high|xhigh>`：持久化 thinking 等級（僅限 GPT-5.2 + Codex 模型）
- `--verbose <on|full|off>`：持久化 verbose 等級
- `--timeout <seconds>`：覆寫 agent 逾時
- `--json`：輸出結構化 JSON
