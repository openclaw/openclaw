---
title: "HEARTBEAT.md Growth Edition"
summary: "Heartbeat checklist designed for agent growth — reflection, distillation, skill tracking"
read_when:
  - Setting up a new workspace for agent growth
  - Replacing a minimal HEARTBEAT.md with a growth-oriented version
---

# Heartbeat Checklist（成長版）

> 把這個檔案命名為 `HEARTBEAT.md` 放在 workspace 根目錄。
> Heartbeat 每次觸發時會讀取並執行此清單。

---

## 每次觸發（Every heartbeat）

```
1. 掃描是否有未讀的重要訊息或緊急事項
   → 有緊急事項：回覆處理
   → 沒有：繼續往下

2. 檢查是否有進行中的任務卡住
   → 若卡住：記錄到 memory/YYYY-MM-DD.md，等下次對話問使用者

3. 沒有需要處理的事項：回覆 HEARTBEAT_OK
```

---

## 每日（Daily — 今天第一次 heartbeat 執行）

```
□ 昨天有什麼值得記憶的事情？
  → 有：補充到 memory/昨天日期.md（若昨天沒寫的話）

□ 今天是否有已知的排程或待辦？
  → 有：記錄在 memory/今天日期.md 作為開場脈絡
```

---

## 每週一（Weekly — 週一第一次 heartbeat 執行）

```
□ 讀最近 7 天的 memory/*.md
□ 按照 WEEKLY_REVIEW.md 的清單執行完整週度反思：
  1. 識別重複主題
  2. 更新 MEMORY.md（精煉，不增肥）
  3. 更新 GROWTH_LOG.md（記錄失誤 + 學習）
  4. 評估技能缺口
  5. 設定下週意圖

□ 完成後回覆週度反思摘要（≤ 100 字）
```

---

## 每月第一個週一（Monthly — 月初第一個週一）

```
□ 讀最近 30 天的 memory/*.md 和 MEMORY.md
□ 更新 bank/ 知識庫：
  - 有沒有新的客觀事實？→ bank/world.md
  - 有沒有值得記錄的活動？→ bank/experience.md
  - 有沒有形成新觀點？→ bank/opinions.md
  - 有沒有重要的人物/專案頁面需要建立或更新？→ bank/entities/

□ SOUL.md 評估：
  - 個性描述還準確嗎？
  - 有沒有新的邊界或偏好需要加入？
  - 有沒有過時的規則需要移除？

□ 成長統計更新（GROWTH_LOG.md 的統計摘要表格）

□ 若月度任務較重，可用 sessions_spawn 觸發子代理人並行處理：
  /subagents spawn --task "讀取最近 30 天 memory/*.md，更新 bank/ 目錄，
  完成後摘要哪些檔案被更新" --label "monthly-distillation"
```

---

## 執行注意事項

- **週度反思優先於一般 HEARTBEAT_OK**：若今天是週一，週度反思比快速確認更重要
- **不要在 heartbeat 中執行破壞性操作**：讀、寫、分析可以，刪除或推送到外部要謹慎
- **長任務用子代理人**：月度蒸餾若預計超過 3 分鐘，spawn 一個子代理人處理
- **保持精簡**：MEMORY.md 應該越寫越精，不是越寫越長

---

*此 HEARTBEAT.md 與 `docs/agent-growth-blueprint.md` 中的成長框架對應。*
*若需要調整節奏（例如改為雙週反思），修改「每週一」區塊的觸發條件。*
