---
summary: "kilocode 提供商配置"
read_when:
  - 配置 kilocode 作为 OpenClaw 模型提供商
title: "kilocode"
---

# kilocode

kilocode 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      kilocode: {
        baseUrl: "https://api.kilocode.com/v1",
        apiKey: "${kilocode.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `kilocode.md_API_KEY`

详情请参阅官方文档。
