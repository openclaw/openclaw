---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway 設定（身分驗證 + 模型選擇）"
read_when:
  - 你想要將 Vercel AI Gateway 與 OpenClaw 一起使用
  - 你需要 API 金鑰的 環境變數 或 CLI 身分驗證選項
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) 提供單一端點的統一 API，讓你可存取數百個模型。

- Provider：`vercel-ai-gateway`
- Auth：`AI_GATEWAY_API_KEY`
- API：相容於 Anthropic Messages

## 快速開始

1. 設定 API 金鑰（建議：將其儲存於 Gateway 閘道器）：

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. 設定預設模型：

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

如果 Gateway 閘道器 以常駐服務（launchd/systemd）執行，請確保 `AI_GATEWAY_API_KEY`
可供該程序使用（例如在 `~/.openclaw/.env` 中，或透過
`env.shellEnv`）。
