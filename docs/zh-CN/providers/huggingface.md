---
summary: "huggingface 提供商配置"
read_when:
  - 配置 huggingface 作为 OpenClaw 模型提供商
title: "huggingface"
---

# huggingface

huggingface 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      huggingface: {
        baseUrl: "https://api.huggingface.com/v1",
        apiKey: "${huggingface.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `huggingface.md_API_KEY`

详情请参阅官方文档。
