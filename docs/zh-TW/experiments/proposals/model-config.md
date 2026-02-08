---
summary: "探索：模型設定、身分驗證設定檔與後備行為"
read_when:
  - 探索未來的模型選擇與身分驗證設定檔構想
title: "模型設定探索"
x-i18n:
  source_path: experiments/proposals/model-config.md
  source_hash: 48623233d80f874c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:51Z
---

# 模型設定（探索）

本文件彙整未來模型設定的**構想**。這不是
正式發佈的規格。關於目前行為，請參閱：

- [模型](/concepts/models)
- [模型失敗接手](/concepts/model-failover)
- [OAuth + 設定檔](/concepts/oauth)

## 動機

營運者希望：

- 每個提供者可有多個身分驗證設定檔（個人 vs 工作）。
- 簡單的 `/model` 選擇，並具備可預期的後備行為。
- 清楚區分文字模型與具備影像能力的模型。

## 可能方向（高層次）

- 保持模型選擇簡單：`provider/model`，並支援選用別名。
- 讓提供者可擁有多個身分驗證設定檔，且有明確順序。
- 使用全域後備清單，讓所有工作階段一致地進行失敗接手。
- 僅在明確設定時才覆寫影像路由。

## 未解問題

- 設定檔輪替應以提供者為單位，還是以模型為單位？
- UI 應如何呈現工作階段的設定檔選擇？
- 從舊版設定鍵遷移的最安全路徑是什麼？
