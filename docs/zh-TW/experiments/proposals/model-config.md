---
summary: "Exploration: model config, auth profiles, and fallback behavior"
read_when:
  - Exploring future model selection + auth profile ideas
title: Model Config Exploration
---

# 模型設定 (探索)

此文件記錄了**未來模型設定**的想法。這不是一份發佈規範。欲了解當前行為，請參見：

- [模型](/concepts/models)
- [模型故障轉移](/concepts/model-failover)
- [OAuth + 個人資料](/concepts/oauth)

## Motivation

Operators want:

- 每個提供者可以有多個身份驗證設定檔（個人與工作）。
- 簡單的 `/model` 選擇，並具有可預測的回退機制。
- 清楚區分文本模型與具備圖像能力的模型。

## 可能的方向（高層次）

- 簡化模型選擇：`provider/model` 並提供可選的別名。
- 讓提供者擁有多個身份驗證設定檔，並明確設定順序。
- 使用全域備援列表，以便所有會話一致地失敗轉移。
- 只有在明確設定時才覆蓋映像路由。

## 開放性問題

- 應該根據提供者還是模型來進行設定輪換？
- 使用者介面應該如何在會話中顯示設定選擇？
- 從舊版設定鍵遷移的最安全路徑是什麼？
