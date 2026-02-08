---
summary: 「情境視窗 + 壓縮：OpenClaw 如何讓工作階段維持在模型限制內」
read_when:
  - 「你想了解自動壓縮與 /compact」
  - 「你正在除錯長時間工作階段觸及情境限制的問題」
title: 「壓縮」
x-i18n:
  source_path: concepts/compaction.md
  source_hash: e1d6791f2902044b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:33Z
---

# 情境視窗與壓縮

每個模型都有一個 **情境視窗**（可看到的最大 token 數）。長時間執行的聊天會累積訊息與工具結果；一旦視窗變得吃緊，OpenClaw 會 **壓縮** 較舊的歷史內容以維持在限制內。

## 什麼是壓縮

壓縮會將 **較舊的對話摘要化** 成一筆精簡的摘要項目，並保留近期訊息不變。摘要會儲存在工作階段歷史中，因此後續請求會使用：

- 壓縮後的摘要
- 壓縮點之後的近期訊息

壓縮會 **持久化** 到工作階段的 JSONL 歷史中。

## 設定

請參閱 [Compaction config & modes](/concepts/compaction) 以了解 `agents.defaults.compaction` 設定。

## 自動壓縮（預設開啟）

當工作階段接近或超過模型的情境視窗時，OpenClaw 會觸發自動壓縮，並可能使用已壓縮的情境重試原始請求。

你會看到：

- 在詳細模式中顯示 `🧹 Auto-compaction complete`
- 顯示 `🧹 Compactions: <count>` 的 `/status`

在壓縮之前，OpenClaw 可以執行一次 **靜默記憶體清空** 的回合，將可持久化的筆記寫入磁碟。設定與細節請參閱 [Memory](/concepts/memory)。

## 手動壓縮

使用 `/compact`（可選擇附加指示）以強制執行一次壓縮：

```
/compact Focus on decisions and open questions
```

## 情境視窗來源

情境視窗為模型特定。OpenClaw 會使用已設定之提供者目錄中的模型定義來判定限制。

## 壓縮 vs 修剪

- **壓縮**：進行摘要並 **持久化** 到 JSONL。
- **工作階段修剪**：僅修剪較舊的 **工具結果**，**僅在記憶體中**，逐次請求執行。

修剪的詳細資訊請參閱 [/concepts/session-pruning](/concepts/session-pruning)。

## 小技巧

- 當工作階段感覺遲鈍或情境過於膨脹時，使用 `/compact`。
- 大型工具輸出已會被截斷；修剪可進一步降低工具結果的累積。
- 若需要全新開始，`/new` 或 `/reset` 會啟動新的工作階段 ID。
