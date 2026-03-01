---
summary: "nvidia 提供商配置"
read_when:
  - 配置 nvidia 作为 OpenClaw 模型提供商
title: "nvidia"
---

# nvidia

nvidia 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://api.nvidia.com/v1",
        apiKey: "${nvidia.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `nvidia.md_API_KEY`

详情请参阅官方文档。
