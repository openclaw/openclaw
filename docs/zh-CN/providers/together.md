---
summary: "together 提供商配置"
read_when:
  - 配置 together 作为 OpenClaw 模型提供商
title: "together"
---

# together

together 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      together: {
        baseUrl: "https://api.together.com/v1",
        apiKey: "${together.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `together.md_API_KEY`

详情请参阅官方文档。
