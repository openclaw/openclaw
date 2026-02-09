---
summary: "/think + /verbose 的指令語法，以及它們如何影響模型推理"
read_when:
  - 調整 thinking 或 verbose 指令的解析或預設值時
title: "思考層級"
---

# 思考層級（/think 指令）

## What it does

- 可在任何傳入訊息本文中使用的內嵌指令：`/t <level>`、`/think:<level>` 或 `/thinking <level>`。
- 層級（別名）：`off | minimal | low | medium | high | xhigh`（僅限 GPT-5.2 + Codex 模型）
  - minimal → 「think」
  - low → 「think hard」
  - medium → 「think harder」
  - high → 「ultrathink」（最大配額）
  - xhigh → 「ultrathink+」（僅限 GPT-5.2 + Codex 模型）
  - `x-high`、`x_high`、`extra-high`、`extra high` 與 `extra_high` 會對應到 `xhigh`。
  - `highest`、`max` 會對應到 `high`。
- 提供者注意事項：
  - Z.AI（`zai/*`）僅支援二元 thinking（`on`/`off`）。任何非 `off` 的層級都會被視為 `on`（對應到 `low`）。 Any non-`off` level is treated as `on` (mapped to `low`).

## Resolution order

1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. 全域預設值（設定中的 `agents.defaults.thinkingDefault`）。
4. 後備值：具備推理能力的模型為 low；否則為 off。

## Setting a session default

- 傳送一則**僅包含指令**的訊息（允許空白），例如 `/think:medium` 或 `/t high`。
- That sticks for the current session (per-sender by default); cleared by `/think:off` or session idle reset.
- 會送出確認回覆（`Thinking level set to high.` / `Thinking disabled.`）。若層級無效（例如 `/thinking big`），指令會被拒絕並提供提示，且工作階段狀態維持不變。 If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.
- 傳送 `/think`（或 `/think:`）且不帶參數，可查看目前的思考層級。

## 代理程式套用方式

- **Embedded Pi**：解析後的層級會傳遞給行程內的 Pi 代理程式執行階段。

## 詳細輸出指令（/verbose 或 /v）

- 層級：`on`（minimal） | `full` | `off`（預設）。
- 僅含指令的訊息會切換工作階段的 verbose，並回覆 `Verbose logging enabled.` / `Verbose logging disabled.`；無效層級會回傳提示且不變更狀態。
- `/verbose off` 會儲存明確的工作階段覆寫；可在 Sessions UI 中選擇 `inherit` 以清除。
- 內嵌指令僅影響該則訊息；否則會套用工作階段／全域預設值。
- 傳送 `/verbose`（或 `/verbose:`）且不帶參數，可查看目前的 verbose 層級。
- 當 verbose 開啟時，會輸出結構化工具結果的代理程式（Pi、其他 JSON 代理程式）會將每次工具呼叫各自回傳為僅含中繼資料的訊息；可用時會以前綴 `<emoji> <tool-name>: <arg>`（路徑／指令）標示。這些工具摘要會在每個工具開始時立即送出（獨立泡泡），而非串流增量。 These tool summaries are sent as soon as each tool starts (separate bubbles), not as streaming deltas.
- 當 verbose 為 `full` 時，工具完成後也會轉送其輸出（獨立泡泡，截斷至安全長度）。若在執行中切換 `/verbose on|full|off`，後續的工具泡泡會遵循新的設定。 If you toggle `/verbose on|full|off` while a run is in-flight, subsequent tool bubbles honor the new setting.

## 推理可見性（/reasoning）

- 層級：`on|off|stream`。
- 僅含指令的訊息可切換是否在回覆中顯示 thinking 區塊。
- 啟用時，推理會以**獨立訊息**送出，並以前綴 `Reasoning:` 標示。
- `stream`（僅 Telegram）：在回覆生成期間，將推理串流至 Telegram 草稿泡泡，完成後僅送出不含推理的最終答案。
- 別名：`/reason`。
- 傳送 `/reasoning`（或 `/reasoning:`）且不帶參數，可查看目前的推理層級。

## Related

- 提升模式文件位於 [Elevated mode](/tools/elevated)。

## 心跳

- 心跳探測的本文為已設定的心跳提示（預設：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。心跳訊息中的內嵌指令會照常套用（但請避免由心跳變更工作階段預設）。 Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).
- 心跳傳遞預設只在最終負載時送出。 心跳傳送預設僅送出最終負載。若要同時送出獨立的 `Reasoning:` 訊息（可用時），請設定 `agents.defaults.heartbeat.includeReasoning: true` 或每個代理程式的 `agents.list[].heartbeat.includeReasoning: true`。

## Web 聊天 UI

- Web 聊天的 thinking 選擇器在頁面載入時，會鏡像自傳入工作階段儲存／設定中的已儲存層級。
- 選擇其他層級僅套用於下一則訊息（`thinkingOnce`）；送出後，選擇器會回復到已儲存的工作階段層級。
- To change the session default, send a `/think:<level>` directive (as before); the selector will reflect it after the next reload.
