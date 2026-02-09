---
summary: "Telegram 允許清單強化：前綴＋空白正規化"
read_when:
  - 檢視歷史 Telegram 允許清單變更時
title: "Telegram 允許清單強化"
---

# Telegram 允許清單強化

**日期**：2026-01-05  
**狀態**：完成  
**PR**：#216

## 摘要

Telegram 允許清單現在可不分大小寫地接受 `telegram:` 與 `tg:` 前綴，並且容忍
意外的空白。這使得入站允許清單檢查與出站傳送的正規化保持一致。 25. 這使入站允許清單檢查與出站傳送的正規化保持一致。

## 26. 變更內容

- 前綴 `telegram:` 與 `tg:` 視為相同（不分大小寫）。
- 允許清單項目會被修剪；空白項目將被忽略。

## 範例

以下項目皆會被視為相同 ID 而接受：

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## 為何重要

27. 從日誌或聊天 ID 複製／貼上時，常會包含前綴與空白字元。 28. 正規化可避免
    在判斷是否要於私訊或群組中回應時出現誤判（false negatives）。

## 29. 相關文件

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
