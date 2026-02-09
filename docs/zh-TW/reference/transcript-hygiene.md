---
summary: "參考：提供者特定的逐字稿清理與修復規則"
read_when:
  - 你正在除錯與逐字稿結構相關的供應商請求拒絕問題
  - 你正在變更逐字稿清理或工具呼叫修復邏輯
  - 你正在調查跨提供者的工具呼叫 id 不一致問題
title: "逐字稿衛生"
---

# 逐字稿衛生（提供者修正）

本文件說明在執行前（建立模型上下文時）套用於逐字稿的 **供應商特定修正**。 這些是為了滿足嚴格供應商需求而使用的 **記憶體內** 調整。 這些清理步驟**不會**重寫磁碟上儲存的 JSONL 逐字稿；不過，另有一個工作階段檔案修復流程，可能會在載入工作階段前，透過移除無效行來重寫格式錯誤的 JSONL 檔案。 發生修復時，原始檔案會在工作階段檔案旁被備份。

範圍包含：

- 工具呼叫 id 清理
- 工具呼叫輸入驗證
- 工具結果配對修復
- 回合驗證／排序
- 思考簽章清理
- 影像負載清理

如果你需要逐字稿儲存的詳細資訊，請參閱：

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## 執行位置

所有逐字稿衛生處理皆集中於內嵌執行器中：

- 政策選擇：`src/agents/transcript-policy.ts`
- 清理／修復套用：`sanitizeSessionHistory`（位於 `src/agents/pi-embedded-runner/google.ts`）

該政策使用 `provider`、`modelApi` 與 `modelId` 來決定要套用哪些規則。

與逐字稿衛生處理分開，工作階段檔案會在載入前（如有需要）進行修復：

- `repairSessionFileIfNeeded`（位於 `src/agents/session-file-repair.ts`）
- 由 `run/attempt.ts` 與 `compact.ts`（內嵌執行器）呼叫

---

## 全域規則：影像清理

影像承載一律會被清理，以避免因大小限制而遭提供者端拒絕
（對過大的 base64 影像進行縮放／重新壓縮）。

實作：

- `sanitizeSessionMessagesImages`（位於 `src/agents/pi-embedded-helpers/images.ts`）
- `sanitizeContentBlocksImages`（位於 `src/agents/tool-images.ts`）

---

## 全域規則：格式不正確的工具呼叫

缺少 `input` 與 `arguments` 這兩者的助理工具呼叫區塊，會在建構模型上下文之前被捨棄。這可避免因部分持久化的工具呼叫（例如在速率限制失敗後）而導致提供者拒絕。 這可防止因部分持久化的工具呼叫而導致的供應商拒絕（例如在速率限制失敗之後）。

實作：

- `sanitizeToolCallInputs`（位於 `src/agents/session-transcript-repair.ts`）
- 套用於 `sanitizeSessionHistory`（位於 `src/agents/pi-embedded-runner/google.ts`）

---

## 提供者矩陣（目前行為）

**OpenAI／OpenAI Codex**

- 僅進行影像清理。
- 切換至 OpenAI Responses/Codex 模型時，捨棄孤立的推理簽章（沒有後續內容區塊的獨立推理項目）。
- 不進行工具呼叫 id 清理。
- 不進行工具結果配對修復。
- 不進行回合驗證或重新排序。
- 不產生合成工具結果。
- 不進行思考簽名移除。

**Google（Generative AI／Gemini CLI／Antigravity）**

- 工具呼叫 id 清理：嚴格的英數字元。
- 工具結果配對修復與合成工具結果。
- 回合驗證（Gemini 風格的回合交替）。
- Google 回合排序修正（若歷史以助理開頭，則在前方插入極小的使用者啟動內容）。
- Antigravity Claude：正規化 thinking 簽章；捨棄未簽署的 thinking 區塊。

**Anthropic／Minimax（Anthropic 相容）**

- 工具結果配對修復與合成工具結果。
- 輪次驗證（合併連續的使用者輪次以滿足嚴格的交替要求）。

**Mistral（包含基於 model-id 的偵測）**

- 工具呼叫 id 清理：strict9（長度為 9 的英數字元）。

**OpenRouter Gemini**

- 思考簽章清理：移除非 base64 的 `thought_signature` 值（保留 base64）。

**其他所有提供者**

- 僅進行影像清理。

---

## 歷史行為（2026.1.22 之前）

在 2026.1.22 版本之前，OpenClaw 套用了多層逐字稿衛生處理：

- 一個 **transcript-sanitize 擴充** 在每次建構上下文時執行，並且可以：
  - 修復工具使用／結果配對。
  - 清理工具呼叫 id（包含一種保留 `_`/`-` 的非嚴格模式）。
- Runner 也曾執行供應商特定的清理，造成重複工作。
- 另外還有發生在提供者政策之外的其他變異，包括：
  - 在持久化之前，從助理文字中移除 `<final>` 標籤。
  - 捨棄空的助理錯誤回合。
  - 在工具呼叫後修剪助理內容。

這種複雜性導致跨供應商的回歸問題（尤其是 `openai-responses`
`call_id|fc_id` 配對）。 2026.1.22 的清理移除了該擴充，將邏輯集中於 runner，並使 OpenAI 在影像清理之外 **不需觸碰**。
