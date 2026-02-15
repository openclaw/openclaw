---
summary: "使用千帆的統一 API 在 OpenClaw 中存取多種模型"
read_when:
  - 您希望為多個 LLM 使用單一 API 密鑰
  - 您需要百度千帆設定指南
title: "千帆"
---

# 千帆供應商指南

千帆是百度的大模型即服務平台，提供**統一 API**，透過單一端點和 API 密鑰將請求路由到多個模型。它與 OpenAI 相容，因此大多數 OpenAI SDK 可以透過切換基礎 URL 來運作。

## 前提

1. 具有千帆 API 存取權限的百度雲帳戶
2. 來自千帆主控台的 API 密鑰
3. 您的系統已安裝 OpenClaw

## 取得您的 API 密鑰

1. 造訪 [千帆主控台](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. 建立新應用程式或選擇現有應用程式
3. 產生 API 密鑰（格式：`bce-v3/ALTAK-...`）
4. 複製 API 密鑰以供 OpenClaw 使用

## CLI 設定

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 相關文件

- [OpenClaw 設定](/gateway/configuration)
- [模型供應商](/concepts/model-providers)
- [智慧代理設定](/concepts/agent)
- [千帆 API 文件](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
