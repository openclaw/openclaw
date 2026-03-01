---
summary: "mistral 提供商配置"
read_when:
  - 配置 mistral 作为 OpenClaw 模型提供商
title: "mistral"
---

# mistral

mistral 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      mistral: {
        baseUrl: "https://api.mistral.com/v1",
        apiKey: "${mistral.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `mistral.md_API_KEY`

详情请参阅官方文档。
