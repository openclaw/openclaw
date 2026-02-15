---
summary: "參考：供應商專屬的對話紀錄清理與修復規則"
read_when:
  - 當您在偵錯因對話紀錄格式引起之供應商請求拒絕時
  - 當您正在修改對話紀錄清理或工具呼叫修復邏輯時
  - 當您正在調查跨供應商的工具呼叫 ID 不符情況時
title: "對話紀錄清理"
---

# 對話紀錄清理 (供應商修復)

本文件描述了在執行前（建立模型上下文）對對話紀錄套用的**供應商專屬修復**。這些是**記憶體內**的調整，用於滿足嚴格的供應商要求。這些清理步驟**不會**重寫儲存於磁碟上的 JSONL 對話紀錄；但是，獨立的工作階段檔案修復程序可能會在載入工作階段前，透過捨棄無效行來重寫格式錯誤的 JSONL 檔案。當發生修復時，原始檔案會與工作階段檔案一同備份。

範圍包括：

- 工具呼叫 ID 清理
- 工具呼叫輸入驗證
- 工具結果配對修復
- 對話輪次驗證/排序
- 思考簽名清理
- 圖片酬載清理
- 使用者輸入來源標記（用於工作階段間路由的提示）

如果您需要對話紀錄儲存的詳細資訊，請參閱：

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## 執行位置

所有對話紀錄清理都集中在嵌入式執行器中：

- 政策選擇: `src/agents/transcript-policy.ts`
- 清理/修復應用: `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

該政策使用 `provider`、`modelApi` 和 `modelId` 來決定要套用哪些規則。

獨立於對話紀錄清理，工作階段檔案會在載入前進行修復（如果需要）：

- `repairSessionFileIfNeeded` in `src/agents/session-file-repair.ts`
- Called from `run/attempt.ts` and `compact.ts` (embedded runner)

---

## 全域規則：圖片清理

圖片酬載總是會被清理，以防止因大小限制導致供應商端拒絕（縮小/重新壓縮過大的 Base64 圖片）。

實作方式：

- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`

---

## 全域規則：格式錯誤的工具呼叫

缺少 `input` 和 `arguments` 的助理工具呼叫區塊會在建立模型上下文之前被捨棄。這可以防止因部分持久化的工具呼叫（例如，在達到速率限制失敗後）導致供應商拒絕。

實作方式：

- `sanitizeToolCallInputs` in `src/agents/session-transcript-repair.ts`
- Applied in `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

---

## 全域規則：工作階段間輸入來源

當智慧代理透過 `sessions_send` 將提示傳送到另一個工作階段時（包括智慧代理間的回覆/公告步驟），OpenClaw 會將建立的使用者輪次持久化，並帶有以下內容：

- `message.provenance.kind = "inter_session"`

此中繼資料在對話紀錄附加時寫入，並且角色不會改變（`role: "user"` 為了供應商相容性而保留）。對話紀錄讀取器可以使用此資訊，避免將路由的內部提示視為終端使用者撰寫的指令。

在上下文重建期間，OpenClaw 還會在記憶體中將簡短的 `[Inter-session message]` 標記預置到這些使用者輪次之前，以便模型可以將其與外部終端使用者指令區分開來。

---

## 供應商矩陣 (目前行為)

**OpenAI / OpenAI Codex**

- 僅進行圖片清理。
- 切換模型至 OpenAI Responses/Codex 時，捨棄孤立的思考簽名（沒有後續內容區塊的獨立思考項目）。
- 無工具呼叫 ID 清理。
- 無工具結果配對修復。
- 無對話輪次驗證或重新排序。
- 無合成工具結果。
- 無思考簽名移除。

**Google (Generative AI / Gemini CLI / Antigravity)**

- 工具呼叫 ID 清理：嚴格的英數字元。
- 工具結果配對修復和合成工具結果。
- 對話輪次驗證 (Gemini 風格的輪次交替)。
- Google 對話輪次排序修復（如果歷史紀錄以助理開頭，則預置一個微小的使用者引導）。
- Antigravity Claude：正規化思考簽名；捨棄未簽名的思考區塊。

**Anthropic / Minimax (Anthropic-compatible)**

- 工具結果配對修復和合成工具結果。
- 對話輪次驗證（合併連續的使用者輪次以滿足嚴格的交替要求）。

**Mistral (including model-id based detection)**

- 工具呼叫 ID 清理：strict9 (英數字元長度 9)。

**OpenRouter Gemini**

- 思考簽名清理：移除非 Base64 的 `thought_signature` 值（保留 Base64）。

**其他所有情況**

- 僅進行圖片清理。

---

## 歷史行為 (2026.1.22 之前)

在 2026.1.22 版本發布之前，OpenClaw 套用了多層次的對話紀錄清理機制：

- **對話紀錄清理擴充功能**會在每次上下文建立時執行，並且可以：
  - 修復工具使用/結果配對。
  - 清理工具呼叫 ID（包括保留 `_`/`-` 的非嚴格模式）。
- 執行器也會執行供應商專屬的清理，這造成了重複的工作。
- 供應商政策之外還發生了額外的變異，包括：
  - 在持久化之前從助理文字中移除 `<final>` 標籤。
  - 捨棄空的助理錯誤輪次。
  - 在工具呼叫後截斷助理內容。

這種複雜性導致了跨供應商的退化（特別是 `openai-responses` 的 `call_id|fc_id` 配對）。2026.1.22 的清理移除了擴充功能，將邏輯集中到執行器中，並使 OpenAI 除了圖片清理之外**不進行任何修改**。
