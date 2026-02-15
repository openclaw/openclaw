---
summary: "參考：特定供應商的對話紀錄清理與修復規則"
read_when:
  - 當你在偵錯與對話紀錄格式相關的供應商請求遭拒問題時
  - 當你在變更對話紀錄清理或工具呼叫修復邏輯時
  - 當你在調查不同供應商之間的工具呼叫 ID 不匹配問題時
title: "對話紀錄整理"
---

# 對話紀錄整理 (供應商修正)

本文件描述了在執行（建立模型上下文）之前，針對 **特定供應商進行的修復**。這些是為滿足供應商嚴格要求而進行的 **記憶體內 (in-memory)** 調整。這些整理步驟 **不會** 重寫儲存在磁碟上的 JSONL 對話紀錄；然而，在載入工作階段之前，獨立的工作階段檔案修復程序可能會透過捨棄無效行來重寫格式錯誤的 JSONL 檔案。當修復發生時，原本的檔案會與工作階段檔案一起備份。

範圍包括：

- 工具呼叫 ID 清理
- 工具呼叫輸入驗證
- 工具結果配對修復
- 輪次驗證 / 排序
- 思考簽章清理
- 圖片酬載清理
- 使用者輸入來源標記（用於跨工作階段路由的提示詞）

如果你需要對話紀錄儲存詳情，請參閱：

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## 執行位置

所有對話紀錄整理都集中在內嵌執行器中：

- 策略選擇：`src/agents/transcript-policy.ts`
- 清理/修復應用：`src/agents/pi-embedded-runner/google.ts` 中的 `sanitizeSessionHistory`

該策略使用 `provider`、`modelApi` 與 `modelId` 來決定要套用哪些規則。

除了對話紀錄整理之外，工作階段檔案在載入前也會視需要進行修復：

- `src/agents/session-file-repair.ts` 中的 `repairSessionFileIfNeeded`
- 從 `run/attempt.ts` 與 `compact.ts`（內嵌執行器）呼叫

---

## 全域規則：圖片清理

圖片酬載一律會進行清理，以防止因尺寸限制而遭供應商拒絕（對過大的 base64 圖片進行縮放/重新壓縮）。

實作方式：

- `src/agents/pi-embedded-helpers/images.ts` 中的 `sanitizeSessionMessagesImages`
- `src/agents/tool-images.ts` 中的 `sanitizeContentBlocksImages`

---

## 全域規則：格式錯誤的工具呼叫

在建立模型上下文之前，會捨棄同時缺少 `input` 與 `arguments` 的智慧代理工具呼叫區塊。這可以防止因部分持久化的工具呼叫（例如在速率限制失敗之後）而導致供應商拒絕。

實作方式：

- `src/agents/session-transcript-repair.ts` 中的 `sanitizeToolCallInputs`
- 在 `src/agents/pi-embedded-runner/google.ts` 的 `sanitizeSessionHistory` 中套用

---

## 全域規則：跨工作階段輸入來源

當智慧代理透過 `sessions_send`（包括智慧代理對智慧代理的修復/通知步驟）將提示詞發送到另一個工作階段時，OpenClaw 會持久化建立的使用者輪次，並帶有：

- `message.provenance.kind = "inter_session"`

此元數據是在對話紀錄附加時寫入的，且不會更改角色（為了供應商相容性，仍保持 `role: "user"`）。對話紀錄讀取器可以使用此標記，以避免將路由的內部提示詞視為終端使用者撰寫的指令。

在重建上下文期間，OpenClaw 還會在記憶體中為這些使用者輪次加上簡短的 `[Inter-session message]` 標記，以便模型可以將其與外部終端使用者指令區分開來。

---

## 供應商矩陣（目前行為）

**OpenAI / OpenAI Codex**

- 僅進行圖片清理。
- 切換模型至 OpenAI Responses/Codex 時，捨棄孤立的推理簽章（沒有後續內容區塊的獨立推理項目）。
- 不進行工具呼叫 ID 清理。
- 不進行工具結果配對修復。
- 不進行輪次驗證或重排。
- 不產生合成工具結果。
- 不進行思考簽章移除。

**Google (Generative AI / Gemini CLI / Antigravity)**

- 工具呼叫 ID 清理：嚴格英數字。
- 工具結果配對修復與合成工具結果。
- 輪次驗證（Gemini 風格的輪次交替）。
- Google 輪次排序修正（如果歷史紀錄以 assistant 開始，則在前置插入一個微小的使用者引導 bootstrap）。
- Antigravity Claude：標準化思考簽章；捨棄未簽署的思考區塊。

**Anthropic / Minimax (Anthropic 相容)**

- 工具結果配對修復與合成工具結果。
- 輪次驗證（合併連續的使用者輪次以滿足嚴格交替要求）。

**Mistral (包括基於模型 ID 的偵測)**

- 工具呼叫 ID 清理：strict9（長度為 9 的英數字）。

**OpenRouter Gemini**

- 思考簽章清理：移除非 base64 的 `thought_signature` 值（保留 base64）。

**其他所有**

- 僅進行圖片清理。

---

## 歷史行為 (2026.1.22 以前)

在 2026.1.22 版本發佈之前，OpenClaw 套用了多層對話紀錄整理：

- 一個 **transcript-sanitize 擴充功能** 在每次上下文建立時執行，且可以：
  - 修復工具使用/結果配對。
  - 清理工具呼叫 ID（包括保留 `_`/`-` 的非嚴格模式）。
- 執行器也會執行特定供應商的清理，這導致了重複工作。
- 在供應商策略之外還發生了額外的變更，包括：
  - 在持久化之前從 assistant 文本中移除 `<final>` 標籤。
  - 捨棄空的 assistant 錯誤輪次。
  - 在工具呼叫後修剪 assistant 內容。

這種複雜性導致了跨供應商的退化（特別是 `openai-responses` 的 `call_id|fc_id` 配對）。2026.1.22 的清理移除了該擴充功能，將邏輯集中在執行器中，並使 OpenAI 除了圖片清理外保持 **原樣 (no-touch)**。
