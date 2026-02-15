---
summary: "/think + /verbose 指令語法及其如何影響模型推理"
read_when:
  - 調整思考或詳細指令解析或預設值時
title: "思考等級"
---

# 思考等級（/think 指令）

## 功能

- 任何輸入內容中的內嵌指令：`/t <level>`、`/think:<level>` 或 `/thinking <level>`。
- 等級（別名）：`off | minimal | low | medium | high | xhigh`（僅限 GPT-5.2 + Codex 模型）
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink”（最大預算）
  - xhigh → “ultrathink+”（僅限 GPT-5.2 + Codex 模型）
  - `x-high`、`x_high`、`extra-high`、`extra high` 和 `extra_high` 對應 `xhigh`。
  - `highest`、`max` 對應 `high`。
- 供應商注意事項：
  - Z.AI (`zai/*`) 僅支援二元思考（`on`/`off`）。任何非 `off` 等級均視為 `on`（對應 `low`）。

## 解析順序

1. 訊息中的內嵌指令（僅適用於該訊息）。
2. 工作階段覆寫（透過傳送僅含指令的訊息設定）。
3. 全域預設值（設定中的 `agents.defaults.thinkingDefault`）。
4. 備用：對於具推理能力的模型為 low；否則為 off。

## 設定工作階段預設值

- 傳送**僅包含**指令的訊息（允許空格），例如 `/think:medium` 或 `/t high`。
- 該設定將在目前的工作階段中生效（預設為每個傳送者）；透過 `/think:off` 或工作階段閒置重設來清除。
- 傳送確認回覆（`Thinking level set to high.` / `Thinking disabled.`）。如果等級無效（例如 `/thinking big`），則指令會被拒絕並附帶提示，且工作階段狀態保持不變。
- 傳送 `/think`（或 `/think:`）不帶參數以查看目前的思考等級。

## 智慧代理應用

- **Embedded Pi**：解析後的等級會傳遞給處理中的 Pi 智慧代理執行階段。

## 詳細指令（/verbose 或 /v）

- 等級：`on` (minimal) | `full` | `off` (預設)。
- 僅含指令的訊息會切換工作階段詳細程度並回覆 `Verbose logging enabled.` / `Verbose logging disabled.`；無效的等級會回傳提示，而不改變狀態。
- `/verbose off` 會儲存一個明確的工作階段覆寫；透過選擇 `inherit` 從工作階段 UI 中清除它。
- 內嵌指令僅影響該訊息；否則套用工作階段/全域預設值。
- 傳送 `/verbose`（或 `/verbose:`）不帶參數以查看目前詳細等級。
- 當詳細程度為 on 時，發出結構化工具結果的智慧代理（Pi、其他 JSON 智慧代理）會在每個工具呼叫完成時，將其作為自己的僅含中繼資料訊息傳回，並在可用時（路徑/命令）以 `<emoji> <tool-name>: <arg>` 作為前綴。這些工具摘要在每個工具開始時立即傳送（獨立的氣泡），而不是作為串流增量。
- 當詳細程度為 `full` 時，工具輸出也會在完成後轉發（獨立氣泡，截斷為安全長度）。如果您在執行中切換 `/verbose on|full|off`，後續的工具氣泡會遵循新的設定。

## 推理可見性（/reasoning）

- 等級：`on|off|stream`。
- 僅含指令的訊息會切換是否在回覆中顯示思考區塊。
- 啟用後，推理將作為一個**單獨的訊息**傳送，前綴為 `Reasoning:`。
- `stream`（僅限 Telegram）：在產生回覆時，將推理串流到 Telegram 草稿氣泡中，然後傳送不帶推理的最終答案。
- 別名：`/reason`。
- 傳送 `/reasoning`（或 `/reasoning:`）不帶參數以查看目前的推理等級。

## 相關

- 提升模式文件位於 [Elevated mode](/tools/elevated)。

## 心跳

- 心跳探測內容是配置的心跳提示（預設：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。心跳訊息中的內嵌指令照常生效（但避免從心跳更改工作階段預設值）。
- 心跳傳送預設為僅傳送最終有效負載。要同時傳送單獨的 `Reasoning:` 訊息（可用時），請設定 `agents.defaults.heartbeat.includeReasoning: true` 或每個智慧代理 `agents.list[].heartbeat.includeReasoning: true`。

## Web 聊天 UI

- 網頁聊天思考選擇器會在頁面載入時，反映工作階段儲存的輸入工作階段儲存/設定中的等級。
- 選擇另一個等級僅適用於下一個訊息（`thinkingOnce`）；傳送後，選擇器會恢復到儲存的工作階段等級。
- 要更改工作階段預設值，請傳送 `/think:<level>` 指令（如前所述）；選擇器會在下次重新載入後反映出來。
