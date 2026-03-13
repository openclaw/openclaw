---
summary: "Directive syntax for /think, /fast, /verbose, and reasoning visibility"
read_when:
  - "Adjusting thinking, fast-mode, or verbose directive parsing or defaults"
title: Thinking Levels
---

# 思考層級 (/think 指令)

## 功能說明

- 可在任何輸入內容中使用內嵌指令：`/t <level>`、`/think:<level>` 或 `/thinking <level>`。
- 層級（別名）：`off | minimal | low | medium | high | xhigh | adaptive`
  - minimal → 「think」
  - low → 「think hard」
  - medium → 「think harder」
  - high → 「ultrathink」（最高資源）
  - xhigh → 「ultrathink+」（僅限 GPT-5.2 + Codex 模型）
  - adaptive → 由提供者管理的自適應推理資源（支援 Anthropic Claude 4.6 模型家族）
  - `x-high`、`x_high`、`extra-high`、`extra high` 和 `extra_high` 對應到 `xhigh`。
  - `highest`、`max` 對應到 `high`。
- 提供者備註：
  - Anthropic Claude 4.6 模型若未明確設定思考層級，預設為 `adaptive`。
  - Z.AI (`zai/*`) 僅支援二元思考 (`on`/`off`)，任何非 `off` 層級皆視為 `on`（對應 `low`）。
  - Moonshot (`moonshot/*`) 將 `/think off` 映射為 `thinking: { type: "disabled" }`，任何非 `off` 層級映射為 `thinking: { type: "enabled" }`。啟用思考時，Moonshot 僅接受 `tool_choice` `auto|none`；OpenClaw 會將不相容值標準化為 `auto`。

## 解決優先順序

1. 訊息中的內嵌指令（僅適用於該訊息）。
2. 會話覆寫（由指令訊息設定）。
3. 全域預設值（設定檔中的 `agents.defaults.thinkingDefault`）。
4. 備援：Anthropic Claude 4.6 模型為 `adaptive`，其他具推理能力模型為 `low`，其餘為 `off`。

## 設定會話預設值

- 傳送僅包含指令的訊息（可含空白），例如 `/think:medium` 或 `/t high`。
- 此設定會在當前會話中生效（預設依發送者區分）；可透過 `/think:off` 或會話閒置重置清除。
- 系統會回覆確認訊息（`Thinking level set to high.` / `Thinking disabled.`）。若層級無效（例如 `/thinking big`），指令會被拒絕並提示，且會話狀態不變。
- 傳送 `/think`（或 `/think:`）且不帶參數，可查看目前思考層級。

## 代理應用

- **內嵌 Pi**：解析後的層級會傳遞給內部 Pi 代理執行環境。

## 快速模式 (/fast)

- 層級：`on|off`。
- 僅含指令的訊息可切換會話快速模式覆寫，並回覆 `Fast mode enabled.` / `Fast mode disabled.`。
- 傳送 `/fast`（或 `/fast status`）且不帶模式，可查看目前有效的快速模式狀態。
- OpenClaw 解析快速模式的優先順序：
  1. 內嵌指令/僅指令 `/fast on|off`
  2. 會話覆寫
  3. 每模型設定：`agents.defaults.models["<provider>/<model>"].params.fastMode`
  4. 備援：`off`
- 對於 `openai/*`，快速模式套用 OpenAI 快速設定：支援時為 `service_tier=priority`，並降低推理負擔與文字冗長度。
- 對於 `openai-codex/*`，快速模式在 Codex 回應上套用相同低延遲設定。OpenClaw 在兩個授權路徑間共用一個 `/fast` 切換。
- 對於直接使用 `anthropic/*` API 金鑰的請求，快速模式映射至 Anthropic 服務層級：`/fast on` 設定 `service_tier=auto`，`/fast off` 設定 `service_tier=standard_only`。
- Anthropic 快速模式僅限 API 金鑰。OpenClaw 不會在 Claude 設定金鑰 / OAuth 認證及非 Anthropic 代理基底 URL 注入 Anthropic 服務層級。

## 詳細指令 (/verbose 或 /v)

- 層級：`on`（minimal）｜`full`｜`off`（預設）。
- 僅含指令的訊息可切換會話詳細模式，並回覆 `Verbose logging enabled.` / `Verbose logging disabled.`；無效層級會提示且不改變狀態。
- `/verbose off` 儲存明確的會話覆寫；可透過會話介面選擇 `inherit` 清除。
- 內嵌指令僅影響該訊息；否則套用會話/全域預設。
- 傳送 `/verbose`（或 `/verbose:`）且不帶參數，可查看目前詳細層級。
- 詳細模式開啟時，會產生結構化工具結果的代理（Pi、其他 JSON 代理）會將每個工具呼叫以獨立的純元資料訊息回傳，前綴為 `<emoji> <tool-name>: <arg>`（路徑/指令）時會顯示。這些工具摘要會在工具啟動時即送出（獨立訊息泡泡），非串流增量。
- 工具失敗摘要在一般模式仍可見，但原始錯誤細節後綴除非詳細模式為 `on` 或 `full`，否則隱藏。
- 詳細模式為 `full` 時，工具輸出完成後也會轉發（獨立泡泡，截斷至安全長度）。若在執行中切換 `/verbose on|full|off`，後續工具泡泡會遵循新設定。

## 推理可見性 (/reasoning)

- 層級：`on|off|stream`。
- 僅含指令的訊息可切換回覆中是否顯示思考區塊。
- 啟用時，推理會以**獨立訊息**形式送出，前綴 `Reasoning:`。
- `stream`（僅限 Telegram）：在回覆生成時將推理串流至 Telegram 草稿泡泡，最後送出不含推理的答案。
- 別名：`/reason`。
- 傳送 `/reasoning`（或 `/reasoning:`）且不帶參數，可查看目前推理層級。

## 相關資訊

- 提升模式文件位於 [提升模式](/tools/elevated)。

## 心跳訊號

- 心跳探測的內容為設定的心跳提示（預設：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。心跳訊息中的內嵌指令照常生效（但避免透過心跳訊息更改會話預設設定）。
- 心跳傳送預設只包含最終有效負載。若要同時傳送獨立的 `Reasoning:` 訊息（若有），請設定 `agents.defaults.heartbeat.includeReasoning: true` 或針對特定代理設定 `agents.list[].heartbeat.includeReasoning: true`。

## 網頁聊天介面

- 網頁聊天的思考層級選擇器會在頁面載入時，反映會話儲存的層級，該層級來自入站會話儲存/設定。
- 選擇其他層級只會影響下一則訊息（`thinkingOnce`）；送出後，選擇器會自動回復到儲存的會話層級。
- 若要更改會話預設，請送出 `/think:<level>` 指令（與之前相同）；選擇器會在下一次重新載入後反映此變更。
