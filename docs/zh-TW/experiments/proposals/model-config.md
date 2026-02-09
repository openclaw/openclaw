---
summary: "Exploration: model config, auth profiles, and fallback behavior"
read_when:
  - Exploring future model selection + auth profile ideas
title: "模型設定探索"
---

# 模型設定（探索）

This document captures **ideas** for future model configuration. It is not a
shipping spec. For current behavior, see:

- [模型](/concepts/models)
- [模型失敗接手](/concepts/model-failover)
- [OAuth + 設定檔](/concepts/oauth)

## 動機

營運者希望：

- Multiple auth profiles per provider (personal vs work).
- 簡單的 `/model` 選擇，並具備可預期的後備行為。
- Clear separation between text models and image-capable models.

## 可能方向（高層次）

- 保持模型選擇簡單：`provider/model`，並支援選用別名。
- Let providers have multiple auth profiles, with an explicit order.
- Use a global fallback list so all sessions fail over consistently.
- 僅在明確設定時才覆寫影像路由。

## 開放問題

- Should profile rotation be per-provider or per-model?
- How should the UI surface profile selection for a session?
- 從舊版設定鍵遷移的最安全路徑是什麼？
