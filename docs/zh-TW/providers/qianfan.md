---
summary: Use Qianfan's unified API to access many models in OpenClaw
read_when:
  - You want a single API key for many LLMs
  - You need Baidu Qianfan setup guidance
title: Qianfan
---

# 千帆服務提供者指南

千帆是百度的MaaS平台，提供一個**統一的API**，能透過單一端點和API金鑰路由請求至多個模型。它與OpenAI相容，因此大多數OpenAI SDK只需切換基底URL即可使用。

## 前置條件

1. 擁有可使用千帆API的百度雲帳號
2. 從千帆控制台取得API金鑰
3. 系統已安裝OpenClaw

## 取得API金鑰

1. 前往 [千帆控制台](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. 建立新應用或選擇現有應用
3. 產生API金鑰（格式：`bce-v3/ALTAK-...`）
4. 複製API金鑰以供OpenClaw使用

## CLI設定

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 相關文件

- [OpenClaw設定](/gateway/configuration)
- [模型服務提供者](/concepts/model-providers)
- [代理設定](/concepts/agent)
- [千帆API文件](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
