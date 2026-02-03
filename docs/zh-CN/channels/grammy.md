---
read_when:
  - 开发 Telegram 或 grammY 相关功能
summary: 通过 grammY 集成 Telegram Bot API 及设置说明
title: grammY
x-i18n:
  generated_at: "2026-02-01T19:20:16Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ea7ef23e6d77801f4ef5fc56685ef4470f79f5aecab448d644a72cbab53521b7
  source_path: channels/grammy.md
  workflow: 14
---

# grammY 集成（Telegram Bot API）

# 为什么选择 grammY

- TypeScript 优先的 Bot API 客户端，内置长轮询 + webhook 辅助工具、中间件、错误处理、速率限制器。
- 比手动编写 fetch + FormData 更简洁的媒体辅助工具；支持所有 Bot API 方法。
- 可扩展：通过自定义 fetch 支持代理，会话中间件（可选），类型安全的上下文。

# 已交付的功能

- **单一客户端路径：** 基于 fetch 的实现已移除；grammY 现在是唯一的 Telegram 客户端（发送 + Gateway网关），默认启用 grammY throttler。
- **Gateway网关：** `monitorTelegramProvider` 构建一个 grammY `Bot`，接入提及/允许列表门控、通过 `getFile`/`download` 下载媒体，并通过 `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` 投递回复。支持通过 `webhookCallback` 进行长轮询或 webhook。
- **代理：** 可选的 `channels.telegram.proxy` 通过 grammY 的 `client.baseFetch` 使用 `undici.ProxyAgent`。
- **Webhook 支持：** `webhook-set.ts` 封装了 `setWebhook/deleteWebhook`；`webhook.ts` 托管回调并支持健康检查 + 优雅关闭。当设置了 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 时 Gateway网关启用 webhook 模式（否则使用长轮询）。
- **会话：** 私聊合并到智能体主会话（`agent:<agentId>:<mainKey>`）；群组使用 `agent:<agentId>:telegram:group:<chatId>`；回复路由回同一渠道。
- **配置选项：** `channels.telegram.botToken`、`channels.telegram.dmPolicy`、`channels.telegram.groups`（允许列表 + 提及默认值）、`channels.telegram.allowFrom`、`channels.telegram.groupAllowFrom`、`channels.telegram.groupPolicy`、`channels.telegram.mediaMaxMb`、`channels.telegram.linkPreview`、`channels.telegram.proxy`、`channels.telegram.webhookSecret`、`channels.telegram.webhookUrl`。
- **草稿流式传输：** 可选的 `channels.telegram.streamMode` 在私有话题聊天中使用 `sendMessageDraft`（Bot API 9.3+）。这与渠道分块流式传输是分开的。
- **测试：** grammY mock 覆盖了私信 + 群组提及门控和出站发送；欢迎更多媒体/webhook 测试用例。

待讨论问题

- 如果遇到 Bot API 429 错误，考虑使用可选的 grammY 插件（throttler）。
- 添加更多结构化的媒体测试（贴纸、语音消息）。
- 使 webhook 监听端口可配置（目前固定为 8787，除非通过 Gateway网关接入）。
