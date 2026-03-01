---
summary: "cloudflare-ai-gateway 提供商配置"
read_when:
  - 配置 cloudflare-ai-gateway 作为 OpenClaw 模型提供商
title: "cloudflare-ai-gateway"
---

# cloudflare-ai-gateway

cloudflare-ai-gateway 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        baseUrl: "https://api.cloudflare-ai-gateway.com/v1",
        apiKey: "${cloudflare-ai-gateway.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `cloudflare-ai-gateway.md_API_KEY`

详情请参阅官方文档。
