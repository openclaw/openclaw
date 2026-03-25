---
name: qqbot-channel
description: QQ 频道管理技能。查询频道列表、子频道、成员、发帖、公告、日程等操作。使用 qqbot_channel_api 工具代理 QQ 开放平台 HTTP 接口，自动处理 Token 鉴权。当用户需要查看频道、管理子频道、查询成员、发布帖子/公告/日程时使用。
metadata: { "openclaw": { "emoji": "📡", "requires": { "config": ["channels.qqbot"] } } }
---

# QQ 频道 API 请求指导

`qqbot_channel_api` 是一个 QQ 开放平台 HTTP 代理工具，**自动填充鉴权 Token**。你只需要指定 HTTP 方法、API 路径、请求体和查询参数。

## 📚 详细参考文档

- `references/api_references.md`
