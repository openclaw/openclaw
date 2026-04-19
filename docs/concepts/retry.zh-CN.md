---
summary: "出站提供者调用的重试策略"
read_when:
  - 更新提供者重试行为或默认值
  - 调试提供者发送错误或速率限制
---

# 重试策略

## 目标

- 每个 HTTP 请求重试，而不是每个多步骤流程。
- 通过仅重试当前步骤来保持顺序。
- 避免重复非幂等操作。

## 默认值

- 尝试次数：3
- 最大延迟上限：30000 ms
- 抖动：0.1（10%）
- 提供者默认值：
  - Telegram 最小延迟：400 ms
  - Discord 最小延迟：500 ms

## 行为

### Discord

- 仅在速率限制错误（HTTP 429）时重试。
- 当可用时使用 Discord `retry_after`，否则使用指数退避。

### Telegram

- 在瞬时错误时重试（429、超时、连接/重置/关闭、暂时不可用）。
- 当可用时使用 `retry_after`，否则使用指数退避。
- Markdown 解析错误不重试；它们回退到纯文本。

## 配置

在 `~/.openclaw/openclaw.json` 中为每个提供者设置重试策略：

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## 注意事项

- 重试适用于每个请求（消息发送、媒体上传、反应、投票、贴纸）。
- 复合流程不重试已完成的步骤。
