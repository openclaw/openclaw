---
summary: "使用千帆的统一 API 在 OpenClaw 中访问多种模型"
read_when:
  - 你想用一个 API 密钥访问多种大语言模型
  - 你需要百度千帆的配置指南
title: "千帆"
---

# 千帆服务商指南

千帆是百度的 MaaS 平台，提供**统一 API**，可将请求路由到单一端点和 API 密钥背后的多种模型。它兼容 OpenAI API，因此大多数 OpenAI SDK 只需更换 base URL 即可使用。

## 前提条件

1. 拥有千帆 API 访问权限的百度云账号
2. 来自千帆控制台的 API 密钥
3. 系统已安装 OpenClaw

## 获取 API 密钥

1. 访问 [千帆控制台](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. 创建新应用或选择已有应用
3. 生成 API 密钥（格式：`bce-v3/ALTAK-...`）
4. 复制 API 密钥用于 OpenClaw

## CLI 配置

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 相关文档

- [OpenClaw 配置](/configuration)
- [模型服务商](/concepts/model-providers)
- [Agent 配置](/concepts/agent)
- [千帆 API 文档](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
