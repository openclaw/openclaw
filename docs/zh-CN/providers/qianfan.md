---
read_when:
  - 你想用一个 API key 访问许多 LLM
  - 你需要 Baidu Qianfan 设置指南
summary: 使用 Qianfan 的统一 API 在 OpenClaw 中访问许多模型
title: Qianfan
x-i18n:
  generated_at: "2026-03-16T06:26:58Z"
  model: gpt-5.4
  provider: openai
  source_hash: 2ca710b422f190b65d23db51a3219f0abd67074fb385251efeca6eae095d02e0
  source_path: providers/qianfan.md
  workflow: 15
---

# Qianfan 提供商指南

Qianfan 是 Baidu 的 MaaS 平台，提供一个**统一 API**，可通过单个
端点和 API key 将请求路由到许多模型。它与 OpenAI 兼容，因此大多数 OpenAI SDK 只需切换 base URL 即可使用。

## 前提条件

1. 一个已开通 Qianfan API 访问权限的 Baidu Cloud 账号
2. 一个来自 Qianfan 控制台的 API key
3. 已在你的系统上安装 OpenClaw

## 获取 API key

1. 访问 [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. 创建一个新应用，或选择一个现有应用
3. 生成一个 API key（格式：`bce-v3/ALTAK-...`）
4. 复制该 API key 以在 OpenClaw 中使用

## CLI 设置

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 相关文档

- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
