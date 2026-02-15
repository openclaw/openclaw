---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway 設定 (憑證 + 模型選擇)"
read_when:
  - 您想將 Vercel AI Gateway 與 OpenClaw 搭配使用
  - 您需要 API 鍵環境變數或 CLI 憑證選項
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) 提供統一的 API，透過單一端點存取數百種模型。

- 供應商: `vercel-ai-gateway`
- 憑證: `AI_GATEWAY_API_KEY`
- API: 與 Anthropic Messages 相容

## 快速開始

1. 設定 API 鍵（建議：為 Gateway 儲存此鍵）：

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. 設定一個預設模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## 非互動式範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 環境注意事項

如果 Gateway 作為常駐程式 (launchd/systemd) 運行，請確保 `AI_GATEWAY_API_KEY`
對該程式可用（例如，在 `~/.openclaw/.env` 或透過
`env.shellEnv`）。
