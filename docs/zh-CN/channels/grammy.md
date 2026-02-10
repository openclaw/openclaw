---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 开发 Telegram 或 grammY 相关功能时（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: 通过 grammY 集成 Telegram Bot API，附设置说明（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: grammY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T10:03:55Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: ea7ef23e6d77801f4ef5fc56685ef4470f79f5aecab448d644a72cbab53521b7（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: channels/grammy.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# grammY 集成（Telegram Bot API）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 为什么选择 grammY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 以 TS 为核心的 Bot API 客户端，内置长轮询 + webhook 辅助工具、中间件、错误处理和速率限制器。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 媒体处理辅助工具比手动编写 fetch + FormData 更简洁；支持所有 Bot API 方法。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 可扩展：通过自定义 fetch 支持代理，可选的会话中间件，类型安全的上下文。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 我们发布的内容（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **单一客户端路径：** 移除了基于 fetch 的实现；grammY 现在是唯一的 Telegram 客户端（发送 + Gateway 网关），默认启用 grammY throttler。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway 网关：** `monitorTelegramProvider` 构建 grammY `Bot`，接入 mention/allowlist 网关控制，通过 `getFile`/`download` 下载媒体，并使用 `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` 发送回复。通过 `webhookCallback` 支持长轮询或 webhook。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **代理：** 可选的 `channels.telegram.proxy` 通过 grammY 的 `client.baseFetch` 使用 `undici.ProxyAgent`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Webhook 支持：** `webhook-set.ts` 封装了 `setWebhook/deleteWebhook`；`webhook.ts` 托管回调，支持健康检查和优雅关闭。当设置了 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 时，Gateway 网关启用 webhook 模式（否则使用长轮询）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **会话：** 私聊折叠到智能体主会话（`agent:<agentId>:<mainKey>`）；群组使用 `agent:<agentId>:telegram:group:<chatId>`；回复路由回同一渠道。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **配置选项：** `channels.telegram.botToken`、`channels.telegram.dmPolicy`、`channels.telegram.groups`（allowlist + mention 默认值）、`channels.telegram.allowFrom`、`channels.telegram.groupAllowFrom`、`channels.telegram.groupPolicy`、`channels.telegram.mediaMaxMb`、`channels.telegram.linkPreview`、`channels.telegram.proxy`、`channels.telegram.webhookSecret`、`channels.telegram.webhookUrl`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **草稿流式传输：** 可选的 `channels.telegram.streamMode` 在私有话题聊天中使用 `sendMessageDraft`（Bot API 9.3+）。这与渠道分块流式传输是分开的。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **测试：** grammY mock 覆盖了私信 + 群组 mention 网关控制和出站发送；欢迎添加更多媒体/webhook 测试用例。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
待解决问题（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 如果遇到 Bot API 429 错误，考虑使用可选的 grammY 插件（throttler）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 添加更多结构化媒体测试（贴纸、语音消息）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使 webhook 监听端口可配置（目前固定为 8787，除非通过 Gateway 网关配置）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
