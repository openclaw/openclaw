---
summary: "使用 Qianfan 的統一 API，在 OpenClaw 中存取多種模型"
read_when:
  - 你想要使用單一 API 金鑰存取多個 LLM
  - 你需要百度 Qianfan 的設定指引
title: "Qianfan"
---

# Qianfan 提供者指南

Qianfan 是百度的 MaaS 平台，提供**統一 API**，可透過單一端點與 API 金鑰，將請求路由至多個模型。它相容於 OpenAI，因此只要切換基底 URL，多數 OpenAI SDK 即可運作。 It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## 先決條件

1. 具有 Qianfan API 存取權限的百度雲帳戶
2. 來自 Qianfan 主控台的 API 金鑰
3. 系統上已安裝 OpenClaw

## 取得你的 API 金鑰

1. 前往 [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Create a new application or select an existing one
3. 產生 API 金鑰（格式：`bce-v3/ALTAK-...`）
4. 複製 API 金鑰以供 OpenClaw 使用

## CLI 設定

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Related Documentation

- [OpenClaw 設定](/gateway/configuration)
- [模型提供者](/concepts/model-providers)
- [代理程式設定](/concepts/agent)
- [Qianfan API 文件](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
