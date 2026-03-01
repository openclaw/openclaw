---
summary: "vllm 提供商配置"
read_when:
  - 配置 vllm 作为 OpenClaw 模型提供商
title: "vllm"
---

# vllm

vllm 模型提供商配置指南。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "https://api.vllm.com/v1",
        apiKey: "${vllm.md_API_KEY}",
      },
    },
  },
}
```

## 环境变量

- `vllm.md_API_KEY`

详情请参阅官方文档。
