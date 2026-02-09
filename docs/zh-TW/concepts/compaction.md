---
summary: "情境視窗 + 壓縮：OpenClaw 如何讓工作階段維持在模型限制內"
read_when:
  - 你想了解自動壓縮與 /compact
  - 24. 你正在除錯因達到內容限制的長時間工作階段
title: "25. 壓縮"
---

# 26. 內容視窗與壓縮

27. 每個模型都有一個**內容視窗**（它能看到的最大權杖數）。 28. 長時間執行的聊天會累積訊息與工具結果；一旦視窗變得吃緊，OpenClaw 會**壓縮**較舊的歷史記錄以維持在限制內。

## 什麼是壓縮

29. 壓縮會將**較舊的對話摘要**成一個精簡的摘要項目，並保留最近的訊息不變。 30. 摘要會儲存在工作階段歷史中，因此後續請求會使用：

- 壓縮後的摘要
- 31. 壓縮點之後的近期訊息

32. 壓縮會**持續存在**於工作階段的 JSONL 歷史中。

## 設定

請參閱 [Compaction config & modes](/concepts/compaction) 以了解 `agents.defaults.compaction` 設定。

## 33. 自動壓縮（預設開啟）

34. 當工作階段接近或超過模型的內容視窗時，OpenClaw 會觸發自動壓縮，並可能使用已壓縮的內容重試原始請求。

你會看到：

- 在詳細模式中顯示 `🧹 Auto-compaction complete`
- 顯示 `🧹 Compactions: <count>` 的 `/status`

35. 在壓縮之前，OpenClaw 可以執行一次**靜默的記憶體清空**回合，將可持久化的筆記儲存到磁碟。 36. 詳情與設定請參閱 [Memory](/concepts/memory)。

## 手動壓縮

使用 `/compact`（可選擇附加指示）以強制執行一次壓縮：

```
/compact Focus on decisions and open questions
```

## 情境視窗來源

37. 內容視窗依模型而異。 情境視窗為模型特定。OpenClaw 會使用已設定之提供者目錄中的模型定義來判定限制。

## 38. 壓縮 vs 修剪

- **壓縮**：進行摘要並 **持久化** 到 JSONL。
- 39. **工作階段修剪**：僅修剪舊的**工具結果**，**在記憶體中**，每次請求進行。

40. 修剪詳情請參閱 [/concepts/session-pruning](/concepts/session-pruning)。

## 小技巧

- Use `/compact` when sessions feel stale or context is bloated.
- 大型工具輸出已會被截斷；修剪可進一步降低工具結果的累積。
- 若需要全新開始，`/new` 或 `/reset` 會啟動新的工作階段 ID。
