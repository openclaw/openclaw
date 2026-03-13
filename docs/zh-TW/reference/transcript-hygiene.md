---
summary: "Reference: provider-specific transcript sanitization and repair rules"
read_when:
  - You are debugging provider request rejections tied to transcript shape
  - You are changing transcript sanitization or tool-call repair logic
  - You are investigating tool-call id mismatches across providers
title: Transcript Hygiene
---

# 文字記錄清理（提供者修正）

本文檔說明在執行期間（建立模型上下文）對文字記錄所做的**提供者特定修正**。這些是用於符合嚴格提供者要求的**記憶體內**調整。這些清理步驟**不會**重寫磁碟上的 JSONL 文字記錄；不過，會有獨立的會話檔案修復程序，在載入會話前透過丟棄無效行來重寫格式錯誤的 JSONL 檔案。當修復發生時，原始檔案會與會話檔案一同備份。

範圍包括：

- 工具呼叫 ID 清理
- 工具呼叫輸入驗證
- 工具結果配對修復
- 輪次驗證／排序
- 思考簽名清理
- 影像載荷清理
- 使用者輸入來源標記（用於跨會話路由提示）

若需要文字記錄儲存細節，請參考：

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## 執行位置

所有文字記錄清理集中在內嵌執行器中：

- 政策選擇：`src/agents/transcript-policy.ts`
- 清理／修復應用：`sanitizeSessionHistory` 位於 `src/agents/pi-embedded-runner/google.ts`

該政策使用 `provider`、`modelApi` 和 `modelId` 來決定應用內容。

與文字記錄清理分開，會話檔案會在載入前（如有需要）進行修復：

- `repairSessionFileIfNeeded` 位於 `src/agents/session-file-repair.ts`
- 由 `run/attempt.ts` 和 `compact.ts`（內嵌執行器）呼叫

---

## 全域規則：影像清理

影像載荷會被自動清理，以防止因大小限制而被服務提供者拒絕（對過大 base64 影像進行縮放或重新壓縮）。

這也有助於控制具備視覺能力模型的影像驅動 token 壓力。較低的最大尺寸通常會減少 token 使用量；較高的尺寸則能保留更多細節。

實作方式：

- `sanitizeSessionMessagesImages` 位於 `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` 位於 `src/agents/tool-images.ts`
- 最大影像邊長可透過 `agents.defaults.imageMaxDimensionPx` 設定（預設值：`1200`）。

---

## 全域規則：格式錯誤的工具呼叫

缺少 `input` 和 `arguments` 兩者的助理工具呼叫區塊，會在模型上下文建立前被丟棄。這可防止因部分持久化的工具呼叫（例如速率限制失敗後）導致服務提供者拒絕。

實作方式：

- `sanitizeToolCallInputs` 位於 `src/agents/session-transcript-repair.ts`
- 應用於 `sanitizeSessionHistory` 中的 `src/agents/pi-embedded-runner/google.ts`

---

## 全域規則：跨會話輸入來源

當代理透過 `sessions_send` 將提示發送到另一個會話（包含代理間的回覆/公告步驟）時，OpenClaw 會將建立的使用者回合持久化，並包含：

- `message.provenance.kind = "inter_session"`

此元資料會在逐字稿附加時寫入，且不會改變角色（`role: "user"` 仍保留以維持與服務提供者的相容性）。逐字稿讀取器可利用此資訊，避免將路由的內部提示誤判為最終使用者撰寫的指令。

在上下文重建期間，OpenClaw 也會在記憶體中的這些使用者回合前加上短暫的 `[Inter-session message]` 標記，讓模型能區分它們與外部最終使用者的指令。

---

## 供應商矩陣（目前行為）

**OpenAI / OpenAI Codex**

- 僅進行圖片淨化。
- 丟棄孤立的推理簽名（獨立推理專案且後面無內容區塊）於 OpenAI 回應／Codex 轉錄中。
- 不進行工具呼叫 ID 淨化。
- 不修復工具結果配對。
- 不進行回合驗證或重新排序。
- 不產生合成工具結果。
- 不剝除思考簽名。

**Google（生成式 AI / Gemini CLI / Antigravity）**

- 工具呼叫 ID 淨化：嚴格限制為字母數字。
- 工具結果配對修復及合成工具結果。
- 回合驗證（Gemini 風格回合交替）。
- Google 回合排序修正（若歷史以助理開頭，則前置一個微小的使用者啟動回合）。
- Antigravity Claude：標準化思考簽名；丟棄未簽名的思考區塊。

**Anthropic / Minimax（Anthropic 相容）**

- 工具結果配對修復及合成工具結果。
- 回合驗證（合併連續使用者回合以符合嚴格交替規則）。

**Mistral（包含基於模型 ID 的偵測）**

- 工具呼叫 ID 淨化：嚴格限制為長度 9 的字母數字。

**OpenRouter Gemini**

- 思考簽名清理：剝除非 base64 格式的 `thought_signature` 值（保留 base64 格式）。

**其他所有**

- 僅進行圖片淨化。

---

## 歷史行為（2026.1.22 之前）

在 2026.1.22 版本釋出之前，OpenClaw 採用了多層的對話紀錄清理機制：

- 一個 **transcript-sanitize 擴充功能** 會在每次上下文建構時執行，功能包括：
  - 修復工具使用與結果的配對。
  - 清理工具呼叫 ID（包含一個非嚴格模式，可保留 `_`/`-`）。
- 執行器（runner）也會執行特定提供者的清理，導致工作重複。
- 在提供者政策之外還有額外的變異，包括：
  - 在儲存前從助理文字中剝除 `<final>` 標籤。
  - 丟棄空的助理錯誤回合。
  - 在工具呼叫後修剪助理內容。

這種複雜性導致跨提供者的回歸問題（特別是 `openai-responses` `call_id|fc_id` 配對）。2026.1.22 的清理移除了該擴充功能，將邏輯集中於執行器，並使 OpenAI 除了圖片清理外，成為 **不干涉** 狀態。
