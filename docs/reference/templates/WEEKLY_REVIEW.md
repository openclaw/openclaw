---
title: "WEEKLY_REVIEW.md Template"
summary: "Weekly reflection checklist for agent knowledge distillation"
read_when:
  - Monday heartbeat
  - Manual weekly review trigger
---

# 週度反思清單（Weekly Review Checklist）

> 每週一第一次 heartbeat 執行此清單。
> 目標：把過去 7 天的原始記憶蒸餾成持久知識。
> 耗時：一個完整的 heartbeat turn（2-5 分鐘）。

---

## Step 1：讀取（Read）

```
□ 讀最近 7 天的 memory/YYYY-MM-DD.md
□ 快速掃描上週的 MEMORY.md（了解目前長期記憶狀態）
□ 讀 GROWTH_LOG.md 最新 3 條記錄（記住正在追蹤什麼）
```

---

## Step 2：識別主題（Identify Themes）

在心裡或草稿中回答以下問題：

```
□ 這週出現了哪些重複主題或模式？
□ 有沒有重要的決定被做出？背後的原因是什麼？
□ 有沒有什麼讓我感到困難或不確定？
□ 有沒有什麼出乎意料的發現？
□ 使用者的偏好或行為有沒有新的線索？
```

---

## Step 3：更新 MEMORY.md（Distill）

規則：
- **加入**：跨多天都重要的洞見、值得長期記住的事實
- **不加**：單次事件、細節、可以從 memory/ 直接找到的東西
- **刪除**：已過時或不再相關的條目
- **目標長度**：300-800 字（永遠保持精簡）

```
□ 找出 1-3 個本週最重要的洞見
□ 用一句話概括每個洞見，加入 MEMORY.md 適當區塊
□ 移除 MEMORY.md 中超過 90 天未被提及的舊條目
```

---

## Step 4：更新 GROWTH_LOG.md（Learn from Errors）

```
□ 這週有沒有犯什麼錯？記錄到對應類別
□ 有沒有反覆發生的小問題？標記為模式
□ 有沒有任何學習點應該變成 SOUL.md 規則？
  → 如果有：更新 SOUL.md，並在 GROWTH_LOG.md 記錄「已同步」
```

---

## Step 5：技能評估（Skill Assessment）

```
□ 這週有沒有重複做了超過 3 次的手動步驟？
  → 如果有：考慮用 skill-creator 建立技能
□ 有沒有技能安裝了但從未使用？
  → 如果有：考慮移除或在 TOOLS.md 記錄使用時機
□ 有沒有需要但沒有的技能？
  → 如果有：搜尋 ClawHub 或建立 backlog
```

---

## Step 6：下週意圖（Weekly Intention）

```
□ 有沒有進行中的任務需要特別注意？
□ 使用者有沒有提到任何即將到來的重要事項？
□ 有沒有什麼應該在下次對話一開始就主動提起？
  → 寫到 memory/YYYY-MM-DD.md（今天的）
```

---

## 完成確認

完成以上步驟後，在 heartbeat 回覆中簡短總結（≤ 100 字）：

```
週度反思完成。
- MEMORY.md：[新增/更新/刪除 N 條]
- GROWTH_LOG.md：[N 條新記錄]
- 技能：[發現/安裝/移除 N 個]
- 下週關注：[一句話]
```

---

*此清單由 HEARTBEAT.md 中的週一觸發邏輯調用。*
*若需手動執行，直接告訴代理人：「執行週度反思」*
