---
summary: "litellm 提供商配置"
read_when:
  - 配置 litellm 作为 OpenClaw 模型提供商
title: "litellm"
---

# litellm

litellm 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "https://api.litellm.com/v1",
        apiKey: "${litellm.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `litellm.md_API_KEY`

详情请参阅官方文档。
