---
summary: "/think + /verbose 的指令語法及其對模型推理的影響"
read_when:
  - 調整思考或詳細模式指令解析或預設值時閱讀
title: "思考等級"
---

# 思考等級 (/think 指令)

## 功能說明

- 任何傳入訊息主體中的行內指令：`/t <level>`、`/think:<level>` 或 `/thinking <level>`。
- 等級（別名）：`off | minimal | low | medium | high | xhigh`（僅限 GPT-5.2 + Codex 模型）
  - minimal → 「思考」
  - low → 「認真思考」
  - medium → 「更加認真思考」
  - high → 「極致思考」（最大預算）
  - xhigh → 「極致思考+」（僅限 GPT-5.2 + Codex 模型）
  - `x-high`、`x_high`、`extra-high`、`extra high` 及 `extra_high` 對應到 `xhigh`。
  - `highest`、`max` 對應到 `high`。
- 供應商說明：
  - Z.AI (`zai/*`) 僅支援二進位思考（`on`/`off`）。任何非 `off` 的等級皆視為 `on`（對應到 `low`）。

## 解析優先順序

1. 訊息上的行內指令（僅適用於該訊息）。
2. 工作階段覆蓋（透過發送僅包含指令的訊息來設定）。
3. 全域預設（設定中的 `agents.defaults.thinkingDefault`）。
4. 回退機制：具備推理能力的模型預設為 low；否則為 off。

## 設定工作階段預設值

- 發送一則**僅包含**指令的訊息（允許空格），例如 `/think:medium` 或 `/t high`。
- 此設定會持續應用於目前的工作階段（預設為每個發送者獨立）；可透過 `/think:off` 或工作階段閒置重設來清除。
- 會發送確認回覆（`Thinking level set to high.` / `Thinking disabled.`）。若等級無效（例如 `/thinking big`），該指令將被拒絕並提供提示，且工作階段狀態保持不變。
- 發送不帶參數的 `/think`（或 `/think:`）即可查看目前的思考等級。

## 智慧代理應用

- **Embedded Pi**：解析後的等級會傳遞給處理序內的 Pi 智慧代理執行環境。

## 詳細模式指令 (/verbose 或 /v)

- 等級：`on` (最小) | `full` | `off` (預設)。
- 僅包含指令的訊息會切換工作階段詳細模式，並回覆 `Verbose logging enabled.` / `Verbose logging disabled.`；無效的等級會返回提示而不變動狀態。
- `/verbose off` 會儲存明確的工作階段覆蓋設定；可透過 Sessions UI 選擇 `inherit` 來清除。
- 行內指令僅影響該則訊息；否則將套用工作階段/全域預設值。
- 發送不帶參數的 `/verbose`（或 `/verbose:`）即可查看目前的詳細模式等級。
- 當詳細模式開啟時，發送結構化工具結果的智慧代理（Pi、其他 JSON 智慧代理）會將每個工具呼叫作為獨立的僅限元資料訊息發送，並在可用時加上 `<emoji> <tool-name>: <arg>` 前綴（路徑/指令）。這些工具摘要會在每個工具開始時立即發送（獨立氣泡），而非作為串流差異發送。
- 當詳細模式為 `full` 時，工具輸出也會在完成後轉發（獨立氣泡，並縮減至安全長度）。若在執行期間切換 `/verbose on|full|off`，隨後的工具氣泡將遵循新設定。

## 推理能見度 (/reasoning)

- 等級：`on|off|stream`。
- 僅包含指令的訊息可切換回覆中是否顯示思考區塊。
- 啟用時，推理會作為**獨立訊息**發送，並帶有 `Reasoning:` 前綴。
- `stream` (僅限 Telegram)：在產生回覆時，將推理內容串流至 Telegram 草稿氣泡中，然後發送不含推理的最終答案。
- 別名：`/reason`。
- 發送不帶參數的 `/reasoning`（或 `/reasoning:`）即可查看目前的推理等級。

## 相關內容

- Elevated mode 文件請參閱 [Elevated mode](/tools/elevated)。

## Heartbeats

- Heartbeat 探測主體為設定好的 Heartbeat 提示詞（預設：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。Heartbeat 訊息中的行內指令會照常套用（但請避免從 Heartbeat 變更工作階段預設值）。
- Heartbeat 傳遞預設僅包含最終酬載。若要同時發送獨立的 `Reasoning:` 訊息（可用時），請設定 `agents.defaults.heartbeat.includeReasoning: true` 或針對個別智慧代理設定 `agents.list[].heartbeat.includeReasoning: true`。

## 網頁聊天介面

- 網頁聊天思考選擇器在頁面載入時，會反映來自傳入工作階段儲存區/設定中儲存的工作階段等級。
- 選擇另一個等級僅適用於下一則訊息（`thinkingOnce`）；發送後，選擇器會彈回儲存的工作階段等級。
- 若要變更工作階段預設值，請發送 `/think:<level>` 指令（如前所述）；選擇器將在下次重新載入後反映該等級。
