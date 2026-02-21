---
read_when:
  - 探索未来模型选择和认证配置文件的方案
summary: 探索：模型配置、认证配置文件和回退行为
title: 模型配置探索
x-i18n:
  generated_at: "2026-02-01T20:25:05Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 48623233d80f874c0ae853b51f888599cf8b50ae6fbfe47f6d7b0216bae9500b
  source_path: experiments/proposals/model-config.md
  workflow: 14
---

# 模型配置（探索）

本文档记录了未来模型配置的**构想**。这不是正式的发布规范。如需了解当前行为，请参阅：

- [模型](/concepts/models)
- [模型故障转移](/concepts/model-failover)
- [OAuth + 配置文件](/concepts/oauth)

## 动机

运营者希望：

- 每个提供商支持多个认证配置文件（个人 vs 工作）。
- 简单的 `/model` 选择，并具有可预测的回退行为。
- 文本模型与图像模型之间有清晰的分离。

## 可能的方向（高层级）

- 保持模型选择简洁：`provider/model` 加可选别名。
- 允许提供商拥有多个认证配置文件，并指定明确的顺序。
- 使用全局回退列表，使所有会话以一致的方式进行故障转移。
- 仅在明确配置时才覆盖图像路由。

## 待解决的问题

- 配置文件轮换应该按提供商还是按模型进行？
- UI 应如何为会话展示配置文件选择？
- 从旧版配置键迁移的最安全路径是什么？
