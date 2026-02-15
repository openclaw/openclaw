---
summary: "使用 Qianfan 的統一 API 在 OpenClaw 中存取多種模型"
read_when:
  - 您希望為多個 LLM 使用單一 API 金鑰
  - 您需要 Baidu Qianfan 的設定指南
title: "Qianfan"
---

# Qianfan 供應商指南

Qianfan 是 Baidu 的 MaaS 平台，提供一個**統一 API**，可透過單一端點和 API 金鑰將請求路由至多種模型。它與 OpenAI 相容，因此大多數 OpenAI SDK 只要切換基礎 URL 即可運作。

## 前置作業

1. 具有 Qianfan API 存取權限的 Baidu Cloud 帳戶
2. 來自 Qianfan 控制台的 API 金鑰
3. 系統中已安裝 OpenClaw

## 獲取您的 API 金鑰

1. 訪問 [Qianfan 控制台](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. 建立新應用程式或選擇現有應用程式
3. 產生 API 金鑰（格式：`bce-v3/ALTAK-...`）
4. 複製 API 金鑰以便在 OpenClaw 中使用

## CLI 設定

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 相關文件

- [OpenClaw 設定](/gateway/configuration)
- [模型供應商](/concepts/model-providers)
- [智慧代理設定](/concepts/agent)
- [Qianfan API 文件](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
