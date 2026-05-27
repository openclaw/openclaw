---
read_when:
  - 更新提供商重试行为或默认值
  - 调试提供商发送错误或速率限制
summary: 出站提供商调用的重试策略
title: 重试策略
x-i18n:
  generated_at: "2026-02-01T20:23:37Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 55bb261ff567f46ce447be9c0ee0c5b5e6d2776287d7662762656c14108dd607
  source_path: concepts/retry.md
  workflow: 14
---

# 重试策略

## 目标

- 按 HTTP 请求重试，而非按多步骤流程重试。
- 通过仅重试当前步骤来保持顺序。
- 避免重复执行非幂等操作。

## 默认值

- 尝试次数：3
- 最大延迟上限：30000 毫秒
- 抖动：0.1（10%）
- 提供商默认值：
  - Telegram 最小延迟：400 毫秒
  - Discord 最小延迟：500 毫秒

## 行为

### Discord

- 仅在速率限制错误（HTTP 429）时重试。
- 可用时使用 Discord `retry_after`，否则使用指数退避。

### Telegram

- 在瞬态错误时重试（429、超时、连接/重置/关闭、暂时不可用）。
- 可用时使用 `retry_after`，否则使用指数退避。
- Markdown 解析错误不会重试；会回退为纯文本。

## 配置

在 `~/.openclaw/openclaw.json` 中按提供商设置重试策略：

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

- 重试按请求应用（消息发送、媒体上传、表情回应、投票、贴纸）。
- 组合流程不会重试已完成的步骤。
